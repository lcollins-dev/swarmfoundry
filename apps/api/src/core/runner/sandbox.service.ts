import { Inject, Injectable, Logger } from '@nestjs/common';
import type Docker from 'dockerode';
import { Writable } from 'node:stream';

import { COMMAND_LIMIT_SEARCH_PATH } from './command-limit.service';
import { CpuAllocatorService } from './cpu-allocator.service';
import { SandboxArchiveService } from './sandbox-archive.service';
import { ConfigService } from '@/config/config.service';

import { RunConfigError } from './run-config.error';
import {
  DOCKER_CLIENT,
  SandboxLabel,
  SandboxRole,
  type IAgentContainerOptions,
  type IAttachedOutput,
  type IOutputSinks,
  type ISandboxContainer,
  type ISandboxFile,
  type ISandboxIds,
  type ISandboxNetwork,
  type IServiceContainerOptions,
  type StopSignal,
} from './runner.types';
import {
  containerInspectSchema,
  containerWaitSchema,
  dockerErrorSchema,
  dockerInfoSchema,
  imageInspectSchema,
  networkInspectSchema,
  pullProgressSchema,
} from './schema/docker';
import { AGENT_AUTH_VARIABLES } from '@/core/foundry-config/schema/environments';
import { StepList } from '@/core/task/task.types';

const NOT_FOUND = 404;
const CONFLICT = 409;
const BAD_REQUEST = 400;

/** Docker's refusal of an unavailable cpuset: `Requested CPUs are not available - requested 0,1, available: 2-5`. */
const AVAILABLE_CPUS_PATTERN = /available: (\S+)/;

const ICC_OPTION = 'com.docker.network.bridge.enable_icc';

export const CLI_CHECK_TIMEOUT_MS = 60_000;

/** Root-owned and read-only, like the rest of `/foundry`. Run with bash, so it needs no mode bit or shebang path. */
export const AGENT_ENTRYPOINT_PATH = '/foundry/entrypoint.sh';

/** Exit codes of the check script, for a tool it found missing. */
export const MISSING_GIT_EXIT = 90;
export const MISSING_CLI_EXIT = 91;
export const MISSING_JQ_EXIT = 92;
export const MISSING_SETSID_EXIT = 93;
export const OLD_BASH_EXIT = 94;

/**
 * Run by bash with the CLI as `$0` and the command limit's `PATH` as `$1`, so a missing bash fails the start instead.
 * The command limit's watchdog reads `EPOCHREALTIME`, which bash has from version 5.
 */
export const CHECK_SCRIPT = [
  `command -v git > /dev/null || exit ${MISSING_GIT_EXIT}`,
  `command -v "$0" > /dev/null || exit ${MISSING_CLI_EXIT}`,
  `PATH="$1" command -v jq > /dev/null || exit ${MISSING_JQ_EXIT}`,
  `PATH="$1" command -v setsid > /dev/null || exit ${MISSING_SETSID_EXIT}`,
  `PATH="$1" bash -c '[[ -n \${EPOCHREALTIME-} ]]' 2> /dev/null || exit ${OLD_BASH_EXIT}`,
  'exec "$0" --version',
].join('\n');

/** Claude refuses `--dangerously-skip-permissions` as root. */
const ROOT_USERS = new Set(['', 'root', '0']);

/** Every Docker call a run makes. Containers and networks carry `SandboxLabel`s, which cleanup and recovery select by. */
@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);

  /** Image ids whose tool check passed. An id names the content, so a retag is checked again. */
  private readonly checkedImages = new Set<string>();

  /** The cores agents may be pinned to: `0` to `NCPU - 1` until the daemon names others. */
  private availableCores: Promise<readonly number[]> | null = null;

  /** Off once the daemon refuses a cpuset without naming the cores it has. */
  private pinCpus = true;

  constructor(
    @Inject(DOCKER_CLIENT) private readonly docker: Docker,
    private readonly configService: ConfigService,
    private readonly sandboxArchiveService: SandboxArchiveService,
    private readonly cpuAllocatorService: CpuAllocatorService
  ) {}

  get namespace(): string {
    return this.configService.sandboxNamespace;
  }

  baseName(ids: ISandboxIds): string {
    const step = ids.list === StepList.STEPS ? 'step' : 'failurestep';

    return `${this.namespace}-task${ids.taskId}-run${ids.runNumber}-${step}${ids.step}`;
  }

  labels(ids: ISandboxIds, role: SandboxRole, extra: Record<string, string> = {}): Record<string, string> {
    return {
      [SandboxLabel.NAMESPACE]: this.namespace,
      [SandboxLabel.TASK_ID]: String(ids.taskId),
      [SandboxLabel.RUN_ID]: String(ids.runId),
      [SandboxLabel.ROLE]: role,
      ...extra,
    };
  }

  async ensureImage(image: string, signal: AbortSignal): Promise<Docker.ImageInspectInfo> {
    try {
      return await this.docker.getImage(image).inspect();
    } catch (error) {
      if (this.statusOf(error) !== NOT_FOUND) {
        throw error;
      }
    }

    this.logger.log({ image }, `ensureImage(): Pulling ${image}`);

    await this.pull(image, signal);

    return this.docker.getImage(image).inspect();
  }

  /**
   * Refuses an image that runs as root, presets an auth variable, or lacks bash, git, the agent's CLI, or the jq, setsid
   * and bash 5 the command limit runs on, naming the image and what it lacks. Runs the CLI once per image id, in a throwaway container with no network.
   */
  async checkAgentImage(
    image: string,
    info: Docker.ImageInspectInfo,
    cli: string,
    ids: ISandboxIds,
    signal: AbortSignal
  ): Promise<void> {
    const parsed = imageInspectSchema.safeParse(info);

    if (!parsed.success) {
      this.logger.error({ image, issues: parsed.error.issues }, 'checkAgentImage(): Unexpected image inspect response');

      throw new Error(`Image ${image} could not be inspected: Docker returned an unexpected response`);
    }

    const { Id: imageId, Config: config } = parsed.data;

    // Docker omits an empty User, which means root
    const user = (config?.User ?? '').trim();
    const env = config?.Env ?? [];

    if (ROOT_USERS.has(user) || user.startsWith('root:') || user.startsWith('0:')) {
      throw new Error(`Image ${image} runs as root. Set a non-root USER, since Claude refuses to run as root`);
    }

    const preset = AGENT_AUTH_VARIABLES.filter(name => env.some(entry => entry.startsWith(`${name}=`)));

    if (preset.length > 0) {
      throw new Error(`Image ${image} sets ${preset.join(' and ')}. Remove it, so the agent's auth decides`);
    }

    if (this.checkedImages.has(imageId)) {
      return;
    }

    const container = await this.docker.createContainer({
      Image: image,
      Entrypoint: ['bash'],
      Cmd: ['-c', CHECK_SCRIPT, cli, COMMAND_LIMIT_SEARCH_PATH],
      Labels: this.labels(ids, SandboxRole.CLI_CHECK),
      NetworkDisabled: true,
      HostConfig: { Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] },
    });

    try {
      try {
        await container.start();
      } catch (error) {
        throw new Error(`Image ${image} does not contain bash: ${this.messageOf(error)}`);
      }

      const timeout = AbortSignal.timeout(CLI_CHECK_TIMEOUT_MS);
      let exitCode: number;

      try {
        exitCode = await this.waitFor(container, AbortSignal.any([signal, timeout]));
      } catch (error) {
        if (timeout.aborted && !signal.aborted) {
          throw new Error(
            `Image ${image}: \`${cli} --version\` did not finish within ${CLI_CHECK_TIMEOUT_MS / 1000} seconds`
          );
        }

        throw error;
      }

      if (exitCode === MISSING_GIT_EXIT) {
        throw new Error(`Image ${image} does not contain git`);
      }

      if (exitCode === MISSING_CLI_EXIT) {
        throw new Error(`Image ${image} does not contain the ${cli} CLI`);
      }

      if (exitCode === MISSING_JQ_EXIT || exitCode === MISSING_SETSID_EXIT || exitCode === OLD_BASH_EXIT) {
        const tool = { [MISSING_JQ_EXIT]: 'jq', [MISSING_SETSID_EXIT]: 'setsid', [OLD_BASH_EXIT]: 'bash 5 or later' }[
          exitCode
        ];

        throw new Error(
          `Image ${image} does not contain ${tool} in ${COMMAND_LIMIT_SEARCH_PATH}, which the runner's command limit runs on`
        );
      }

      if (exitCode !== 0) {
        throw new Error(
          `Image ${image} does not contain a working ${cli} CLI: \`${cli} --version\` exited ${exitCode}`
        );
      }

      this.checkedImages.add(imageId);
    } finally {
      await this.removeContainer(container.id);
    }
  }

  /** Internal, so services reach nothing outside the run. The agent reaches out through the egress network. */
  async createRunNetwork(name: string, labels: Record<string, string>): Promise<void> {
    await this.docker.createNetwork({ Name: name, Driver: 'bridge', Internal: true, Labels: labels });
  }

  /**
   * Joins the container to the one network every agent shares for outbound traffic, created on first use and never
   * removed. Inter-container traffic is off on it, so agents of different runs cannot reach each other. The network is
   * inspected on every call, so one replaced or removed since the last run is refused or created again.
   */
  async connectEgressNetwork(containerId: string): Promise<void> {
    const name = await this.ensureEgressNetwork();

    try {
      await this.connectNetwork(name, containerId);
    } catch (error) {
      if (this.statusOf(error) !== NOT_FOUND) {
        throw error;
      }

      await this.connectNetwork(await this.ensureEgressNetwork(), containerId);
    }
  }

  async startService(options: IServiceContainerOptions): Promise<string> {
    const container = await this.docker.createContainer({
      name: options.name,
      Image: options.image,
      Env: Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
      Labels: options.labels,
      HostConfig: { NetworkMode: options.network, Privileged: false },
      NetworkingConfig: { EndpointsConfig: { [options.network]: { Aliases: [options.alias] } } },
    });

    await container.start();

    return container.id;
  }

  /**
   * No Docker socket, no privileges, no capabilities and no setuid escalation. The runner's entrypoint replaces the
   * image's, under Docker's init so signals reach the agent. A CPU cap also pins the agent to that many cores, rounded
   * up, which `removeRun` releases.
   */
  async createAgentContainer(options: IAgentContainerOptions): Promise<string> {
    const cpuset = await this.allocateCpus(options);

    try {
      return await this.createAgent(options, cpuset);
    } catch (error) {
      if (cpuset === undefined || this.statusOf(error) !== BAD_REQUEST) {
        throw error;
      }

      return this.createAgent(options, await this.reallocateCpus(options, this.messageOf(error)));
    }
  }

  private async createAgent(options: IAgentContainerOptions, cpuset: string | undefined): Promise<string> {
    const container = await this.docker.createContainer({
      name: options.name,
      Image: options.image,
      Entrypoint: ['bash', AGENT_ENTRYPOINT_PATH],
      Cmd: [],
      Env: options.env,
      Labels: options.labels,
      Tty: false,
      OpenStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Init: true,
        NetworkMode: options.network,
        Mounts: options.mounts.map(mount => ({
          Type: 'bind',
          Source: mount.source,
          Target: mount.target,
          ReadOnly: mount.readOnly,
        })),
        NanoCpus: options.cpus === undefined ? undefined : Math.round(options.cpus * 1e9),
        CpusetCpus: cpuset,
        Memory: options.memoryBytes,
        MemorySwap: options.memoryBytes,
        PidsLimit: options.pidsLimit,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
      },
    });

    return container.id;
  }

  private async allocateCpus(options: IAgentContainerOptions): Promise<string | undefined> {
    if (options.cpus === undefined || !this.pinCpus) {
      return undefined;
    }

    const available = await this.cpuCores();

    return this.cpuAllocatorService.allocate(options.runId, options.name, Math.ceil(options.cpus), available).join(',');
  }

  /**
   * NCPU counts the daemon's cores but not which they are, so a daemon limited to other cores refuses the cpuset and
   * names the ones it has. Without them, pinning turns off for the process.
   */
  private async reallocateCpus(options: IAgentContainerOptions, message: string): Promise<string | undefined> {
    const available = this.parseCpuset(AVAILABLE_CPUS_PATTERN.exec(message)?.[1] ?? '');

    if (available.length > 0) {
      this.logger.log({ available }, 'reallocateCpus(): The daemon named the cores it has, so pinning to those');
      this.availableCores = Promise.resolve(available);

      return this.allocateCpus(options);
    }

    if (this.pinCpus) {
      this.logger.warn({ error: message }, 'reallocateCpus(): The daemon refused a cpuset, so agents run unpinned');
      this.pinCpus = false;
    }

    await this.releaseCpus(options.runId);

    return undefined;
  }

  private cpuCores(): Promise<readonly number[]> {
    this.availableCores ??= this.docker
      .info()
      .then((info: unknown) => {
        const parsed = dockerInfoSchema.safeParse(info);

        if (!parsed.success) {
          throw new Error('Docker reported its CPU count in a shape the runner cannot read');
        }

        return Array.from({ length: parsed.data.NCPU }, (_, core) => core);
      })
      .catch((error: unknown) => {
        this.availableCores = null;

        throw error;
      });

    return this.availableCores;
  }

  /** Holds a kept agent's cores, so new runs avoid them. Only spreads the load, so a failed inspect is ignored. */
  private async reserveCpus(runId: number, containerId: string): Promise<void> {
    try {
      const inspected = containerInspectSchema.parse(await this.docker.getContainer(containerId).inspect());
      const cpuset = inspected.HostConfig?.CpusetCpus ?? '';

      if (cpuset !== '') {
        this.cpuAllocatorService.reserve(runId, containerId, this.parseCpuset(cpuset));
      }
    } catch (error) {
      this.logger.warn({ runId, containerId, error: this.messageOf(error) }, 'reserveCpus(): Failed to read the cores');
    }
  }

  /** Moves agents that share a core onto the freed ones. A failed move is logged and ignored. */
  private async releaseCpus(runId: number): Promise<void> {
    const available = this.availableCores === null ? [] : await this.availableCores.catch(() => []);
    const moves = this.cpuAllocatorService.release(runId, available);

    await Promise.all(
      moves.map(async move => {
        try {
          await this.docker.getContainer(move.container).update({ CpusetCpus: move.cores.join(',') });
        } catch (error) {
          this.logger.warn(
            { runId: move.runId, container: move.container, error: this.messageOf(error) },
            'releaseCpus(): Failed to move the agent onto freed cores'
          );
        }
      })
    );
  }

  /** Docker's cpuset format, such as `0-3,6`. */
  private parseCpuset(cpuset: string): number[] {
    return cpuset.split(',').flatMap(part => {
      if (!/^\d+(-\d+)?$/.test(part)) {
        return [];
      }

      const bounds = part.split('-').map(Number);
      const start = Math.min(...bounds);
      const end = Math.max(...bounds);

      return Number.isInteger(start) && Number.isInteger(end)
        ? Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => start + offset)
        : [];
    });
  }

  private async connectNetwork(network: string, containerId: string): Promise<void> {
    await this.docker.getNetwork(network).connect({ Container: containerId });
  }

  async copyFiles(containerId: string, files: readonly ISandboxFile[]): Promise<void> {
    const archive = await this.sandboxArchiveService.build(files);

    await this.docker.getContainer(containerId).putArchive(archive, { path: '/' });
  }

  /** Attach before `start`, so no output is missed. `signal` closes the stream. */
  async attach(containerId: string, signal: AbortSignal, sinks: IOutputSinks): Promise<IAttachedOutput> {
    const stream = await this.docker
      .getContainer(containerId)
      .attach({ stream: true, stdout: true, stderr: true, abortSignal: signal });

    return this.demux(containerId, stream, signal, sinks);
  }

  /** The container's whole output so far, then what it writes until it stops. `signal` closes the stream. */
  async followLogs(containerId: string, signal: AbortSignal, sinks: IOutputSinks): Promise<IAttachedOutput> {
    const stream = await this.docker
      .getContainer(containerId)
      .logs({ follow: true, stdout: true, stderr: true, abortSignal: signal });

    return this.demux(containerId, stream, signal, sinks);
  }

  async start(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).start();
  }

  /** Resolves with the exit code once the container stops. Call after `start`. */
  wait(containerId: string, signal: AbortSignal): Promise<number> {
    return this.waitFor(this.docker.getContainer(containerId), signal);
  }

  /** A container already stopped or gone counts as signalled. */
  async signal(containerId: string, signal: StopSignal): Promise<void> {
    try {
      await this.docker.getContainer(containerId).kill({ signal });
    } catch (error) {
      const status = this.statusOf(error);

      if (status !== CONFLICT && status !== NOT_FOUND) {
        throw error;
      }
    }
  }

  /**
   * Removes every container, with its anonymous volumes, and every network the run created. Releases the run's cores
   * even when a removal fails, so a leftover container cannot hold them for good.
   */
  async removeRun(runId: number): Promise<void> {
    const filters = {
      label: [`${SandboxLabel.NAMESPACE}=${this.namespace}`, `${SandboxLabel.RUN_ID}=${runId}`],
    };

    try {
      const containers = await this.docker.listContainers({ all: true, filters });
      const removedContainers = await Promise.allSettled(
        containers.map(container => this.removeContainer(container.Id))
      );

      const networks = await this.docker.listNetworks({ filters });
      const removedNetworks = await Promise.allSettled(networks.map(network => this.removeNetwork(network.Id)));

      const failures = [...removedContainers, ...removedNetworks].flatMap(result =>
        result.status === 'rejected' ? [this.messageOf(result.reason)] : []
      );

      if (failures.length > 0) {
        throw new Error(`Failed to remove part of run ${runId}'s sandbox: ${failures.join('; ')}`);
      }
    } finally {
      await this.releaseCpus(runId);
    }
  }

  /**
   * Removes the sandbox of every run of the namespace not in `runIds`, and returns the runs it removed. Holds the cores
   * of each kept run's agent, so runs dispatched afterwards avoid them.
   */
  async removeRunsExcept(runIds: ReadonlySet<number>): Promise<number[]> {
    const containers = await this.listContainers();

    await Promise.all(
      containers.flatMap(container =>
        container.role === SandboxRole.AGENT && container.runId !== null && runIds.has(container.runId)
          ? [this.reserveCpus(container.runId, container.id)]
          : []
      )
    );

    const owners = [...containers, ...(await this.listNetworks())].map(item => item.runId);
    const stale = [...new Set(owners)].flatMap(runId => (runId === null || runIds.has(runId) ? [] : [runId]));

    const removed = await Promise.allSettled(stale.map(runId => this.removeRun(runId)));
    const failures = removed.flatMap(result => (result.status === 'rejected' ? [this.messageOf(result.reason)] : []));

    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }

    return stale;
  }

  async listContainers(): Promise<ISandboxContainer[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${SandboxLabel.NAMESPACE}=${this.namespace}`] },
    });

    return containers.map(container => ({
      id: container.Id,
      name: container.Names[0]?.replace(/^\//, '') ?? container.Id,
      role: this.roleOf(container.Labels[SandboxLabel.ROLE]),
      taskId: this.idOf(container.Labels[SandboxLabel.TASK_ID]),
      runId: this.idOf(container.Labels[SandboxLabel.RUN_ID]),
      state: container.State,
    }));
  }

  /** Every network of the namespace, the shared egress network included. */
  async listNetworks(): Promise<ISandboxNetwork[]> {
    const networks = await this.docker.listNetworks({
      filters: { label: [`${SandboxLabel.NAMESPACE}=${this.namespace}`] },
    });

    return networks.map(network => ({
      id: network.Id,
      role: this.roleOf(network.Labels?.[SandboxLabel.ROLE]),
      runId: this.idOf(network.Labels?.[SandboxLabel.RUN_ID]),
    }));
  }

  private async ensureEgressNetwork(): Promise<string> {
    const name = `${this.namespace}-egress`;

    if (await this.checkEgressNetwork(name)) {
      return name;
    }

    try {
      await this.docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        Labels: { [SandboxLabel.NAMESPACE]: this.namespace, [SandboxLabel.ROLE]: SandboxRole.EGRESS_NETWORK },
        Options: { [ICC_OPTION]: 'false' },
      });

      this.logger.log({ network: name }, 'ensureEgressNetwork(): Created the network agents reach out through');
    } catch (error) {
      if (this.statusOf(error) !== CONFLICT) {
        throw error;
      }

      // Another run created it first, so check that one instead.
      await this.checkEgressNetwork(name);
    }

    return name;
  }

  /** False when there is none. A network that lets containers reach each other is a config fault no retry fixes. */
  private async checkEgressNetwork(name: string): Promise<boolean> {
    let existing: unknown;

    try {
      existing = await this.docker.getNetwork(name).inspect();
    } catch (error) {
      if (this.statusOf(error) !== NOT_FOUND) {
        throw error;
      }

      return false;
    }

    if (networkInspectSchema.safeParse(existing).data?.Options?.[ICC_OPTION] !== 'false') {
      throw new RunConfigError(
        `Network ${name} lets containers reach each other. Remove it, and the runner creates it with that off`
      );
    }

    return true;
  }

  /** The daemon reports a failed layer in the progress stream, not in the response status. */
  private async pull(image: string, signal: AbortSignal): Promise<void> {
    const stream = await this.docker.pull(image, { abortSignal: signal });

    const progress = await new Promise<unknown[]>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error: Error | null, output: unknown[]) => {
        if (error === null) {
          resolve(output);
        } else {
          reject(error);
        }
      });
    });

    for (const event of progress) {
      const parsed = pullProgressSchema.safeParse(event);

      if (parsed.success && parsed.data.error !== undefined) {
        throw new Error(`Pulling ${image} failed: ${parsed.data.error}`);
      }
    }
  }

  private async waitFor(container: Docker.Container, signal?: AbortSignal): Promise<number> {
    const response: unknown = await container.wait({ abortSignal: signal });
    const parsed = containerWaitSchema.safeParse(response);

    if (!parsed.success) {
      throw new Error(`Docker reported container ${container.id}'s exit in a shape the runner cannot read`);
    }

    return parsed.data.StatusCode;
  }

  private async removeNetwork(networkId: string): Promise<void> {
    try {
      await this.docker.getNetwork(networkId).remove();
    } catch (error) {
      if (this.statusOf(error) !== NOT_FOUND) {
        throw error;
      }
    }
  }

  private async removeContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force: true, v: true });
    } catch (error) {
      if (this.statusOf(error) !== NOT_FOUND) {
        throw error;
      }
    }
  }

  private demux(
    containerId: string,
    stream: NodeJS.ReadableStream,
    signal: AbortSignal,
    sinks: IOutputSinks
  ): IAttachedOutput {
    const ended = new Promise<void>(resolve => {
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
      stream.on('error', (error: unknown) => {
        if (!signal.aborted) {
          this.logger.warn({ containerId, error: this.messageOf(error) }, 'demux(): The output stream failed');
        }

        resolve();
      });
    });

    this.docker.modem.demuxStream(stream, this.sink(containerId, sinks.stdout), this.sink(containerId, sinks.stderr));

    return { ended };
  }

  /** Never throws into the stream, since demuxing runs inside its `data` handler. */
  private sink(containerId: string, write: (chunk: Buffer) => void): Writable {
    const writable = new Writable({
      write: (chunk: unknown, _encoding, callback) => {
        try {
          write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });

    writable.on('error', (error: unknown) => {
      this.logger.error({ containerId, error: this.messageOf(error) }, 'sink(): Failed to read container output');
    });

    return writable;
  }

  private roleOf(value: string | undefined): SandboxRole | null {
    return Object.values(SandboxRole).find(role => role === value) ?? null;
  }

  private idOf(value: string | undefined): number | null {
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
  }

  private statusOf(error: unknown): number | null {
    const parsed = dockerErrorSchema.safeParse(error);

    return parsed.success ? parsed.data.statusCode : null;
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
