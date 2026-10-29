import { Logger } from '@nestjs/common';
import type Docker from 'dockerode';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { COMMAND_LIMIT_SEARCH_PATH } from './command-limit.service';
import { CpuAllocatorService } from './cpu-allocator.service';
import { SandboxArchiveService } from './sandbox-archive.service';
import {
  AGENT_ENTRYPOINT_PATH,
  CHECK_SCRIPT,
  MISSING_CLI_EXIT,
  MISSING_GIT_EXIT,
  MISSING_JQ_EXIT,
  MISSING_SETSID_EXIT,
  OLD_BASH_EXIT,
  SandboxService,
} from './sandbox.service';
import type { ConfigService } from '@/config/config.service';

import { RunConfigError } from './run-config.error';
import { SandboxLabel, SandboxRole } from './runner.types';
import { StepList } from '@/core/task/task.types';

const IDS = { taskId: 12, runId: 34, runNumber: 2, list: StepList.STEPS, step: 1 };

const dockerError = (statusCode: number, message = `(HTTP code ${statusCode})`) =>
  Object.assign(new Error(message), { statusCode });

const imageInfo = (overrides: { User?: string; Env?: string[]; Id?: string } = {}) =>
  ({
    Id: overrides.Id ?? 'sha256:agent',
    Config: { User: overrides.User ?? 'agent', Env: overrides.Env ?? ['PATH=/usr/bin'] },
  }) as unknown as Docker.ImageInspectInfo;

const fakeContainer = (id: string) => ({
  id,
  start: vi.fn().mockResolvedValue(undefined),
  wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
  kill: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  attach: vi.fn(),
  logs: vi.fn(),
  inspect: vi.fn().mockResolvedValue({ HostConfig: { CpusetCpus: '' } }),
  update: vi.fn().mockResolvedValue(undefined),
  putArchive: vi.fn().mockResolvedValue(undefined),
});

type FakeContainer = ReturnType<typeof fakeContainer>;

describe('SandboxService', () => {
  let containers: Map<string, ReturnType<typeof fakeContainer>>;
  let networks: Map<
    string,
    { inspect: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }
  >;
  let docker: {
    getImage: ReturnType<typeof vi.fn>;
    pull: ReturnType<typeof vi.fn>;
    createContainer: Mock<(options: unknown) => Promise<FakeContainer>>;
    getContainer: ReturnType<typeof vi.fn>;
    createNetwork: ReturnType<typeof vi.fn>;
    getNetwork: ReturnType<typeof vi.fn>;
    listContainers: ReturnType<typeof vi.fn>;
    listNetworks: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    modem: { followProgress: ReturnType<typeof vi.fn>; demuxStream: ReturnType<typeof vi.fn> };
  };
  let imageInspect: ReturnType<typeof vi.fn>;
  let cpuAllocator: CpuAllocatorService;
  let service: SandboxService;

  const container = (id: string) => {
    let existing = containers.get(id);

    if (existing === undefined) {
      existing = fakeContainer(id);
      containers.set(id, existing);
    }

    return existing;
  };

  const network = (id: string) => {
    let existing = networks.get(id);

    if (existing === undefined) {
      existing = {
        inspect: vi.fn().mockResolvedValue({ Options: { 'com.docker.network.bridge.enable_icc': 'false' } }),
        remove: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn().mockResolvedValue(undefined),
      };
      networks.set(id, existing);
    }

    return existing;
  };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    containers = new Map();
    networks = new Map();
    imageInspect = vi.fn().mockResolvedValue(imageInfo());

    let created = 0;

    docker = {
      getImage: vi.fn(() => ({ inspect: imageInspect })),
      pull: vi.fn().mockResolvedValue(new PassThrough()),
      createContainer: vi.fn(() => Promise.resolve(container(`container-${++created}`))),
      getContainer: vi.fn((id: string) => container(id)),
      createNetwork: vi.fn().mockResolvedValue(undefined),
      getNetwork: vi.fn((id: string) => network(id)),
      listContainers: vi.fn().mockResolvedValue([]),
      listNetworks: vi.fn().mockResolvedValue([]),
      info: vi.fn().mockResolvedValue({ NCPU: 8 }),
      modem: {
        followProgress: vi.fn((_stream: unknown, done: (error: Error | null, output: unknown[]) => void) =>
          done(null, [{ status: 'Downloaded' }])
        ),
        demuxStream: vi.fn(),
      },
    };

    cpuAllocator = new CpuAllocatorService();

    service = new SandboxService(
      docker as unknown as Docker,
      { sandboxNamespace: 'foundry' } as ConfigService,
      new SandboxArchiveService(),
      cpuAllocator
    );
  });

  it('names and labels sandboxes by namespace, task and run', () => {
    expect(service.baseName(IDS)).toBe('foundry-task12-run2-step1');
    expect(service.baseName({ ...IDS, list: StepList.FAILURE_STEPS })).toBe('foundry-task12-run2-failurestep1');
    expect(service.labels(IDS, SandboxRole.SERVICE, { [SandboxLabel.SERVICE]: 'postgres' })).toEqual({
      'swarmfoundry.namespace': 'foundry',
      'swarmfoundry.task-id': '12',
      'swarmfoundry.run-id': '34',
      'swarmfoundry.role': 'service',
      'swarmfoundry.service': 'postgres',
    });
  });

  describe('ensureImage', () => {
    it('uses an image the daemon has without pulling', async () => {
      await service.ensureImage('agent:1', new AbortController().signal);

      expect(docker.pull).not.toHaveBeenCalled();
    });

    it('pulls a missing image', async () => {
      imageInspect.mockRejectedValueOnce(dockerError(404));

      await expect(service.ensureImage('agent:1', new AbortController().signal)).resolves.toMatchObject({
        Id: 'sha256:agent',
      });
      expect(docker.pull).toHaveBeenCalledWith('agent:1', { abortSignal: expect.any(AbortSignal) as AbortSignal });
    });

    it('fails on an error in the pull progress', async () => {
      imageInspect.mockRejectedValueOnce(dockerError(404));
      docker.modem.followProgress.mockImplementationOnce(
        (_stream: unknown, done: (error: Error | null, output: unknown[]) => void) =>
          done(null, [{ error: 'manifest unknown' }])
      );

      await expect(service.ensureImage('agent:1', new AbortController().signal)).rejects.toThrow(
        'Pulling agent:1 failed: manifest unknown'
      );
    });
  });

  describe('checkAgentImage', () => {
    it.each(['', 'root', '0', '0:0', 'root:root'])('refuses an image running as user %j', async user => {
      await expect(
        service.checkAgentImage('agent:1', imageInfo({ User: user }), 'claude', IDS, new AbortController().signal)
      ).rejects.toThrow('Image agent:1 runs as root');
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('refuses an image whose inspect response has no User, as running as root', async () => {
      const info = { Id: 'sha256:agent', Config: { Env: ['PATH=/usr/bin'] } } as unknown as Docker.ImageInspectInfo;

      await expect(
        service.checkAgentImage('agent:1', info, 'claude', IDS, new AbortController().signal)
      ).rejects.toThrow('Image agent:1 runs as root');
    });

    it('accepts an image whose inspect response has no Env', async () => {
      const info = { Id: 'sha256:agent', Config: { User: 'agent' } } as unknown as Docker.ImageInspectInfo;

      await service.checkAgentImage('agent:1', info, 'claude', IDS, new AbortController().signal);

      expect(docker.createContainer).toHaveBeenCalled();
    });

    it('refuses an image whose inspect response has no Config, as running as root', async () => {
      const info = { Id: 'sha256:agent' } as unknown as Docker.ImageInspectInfo;

      await expect(
        service.checkAgentImage('agent:1', info, 'claude', IDS, new AbortController().signal)
      ).rejects.toThrow('Image agent:1 runs as root');
    });

    it('refuses an image that presets an auth variable', async () => {
      const info = imageInfo({ Env: ['ANTHROPIC_API_KEY=sk-x'] });

      await expect(
        service.checkAgentImage('agent:1', info, 'claude', IDS, new AbortController().signal)
      ).rejects.toThrow('Image agent:1 sets ANTHROPIC_API_KEY');
    });

    it('checks the tools through bash with no network, then removes the check container', async () => {
      await service.checkAgentImage('agent:1', imageInfo(), 'claude', IDS, new AbortController().signal);

      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: 'agent:1',
          Entrypoint: ['bash'],
          Cmd: ['-c', expect.stringContaining('command -v git'), 'claude', COMMAND_LIMIT_SEARCH_PATH],
          NetworkDisabled: true,
          Labels: expect.objectContaining({ 'swarmfoundry.role': 'cli-check', 'swarmfoundry.run-id': '34' }) as object,
        })
      );
      expect(container('container-1').remove).toHaveBeenCalledWith({ force: true, v: true });
    });

    it('fails naming the image when bash is missing, and still removes the check container', async () => {
      docker.createContainer.mockImplementationOnce(() => {
        const check = container('check');
        check.start.mockRejectedValueOnce(dockerError(400, 'exec: "bash": executable file not found in $PATH'));

        return Promise.resolve(check);
      });

      await expect(
        service.checkAgentImage('agent:1', imageInfo(), 'claude', IDS, new AbortController().signal)
      ).rejects.toThrow('Image agent:1 does not contain bash: exec: "bash": executable file not found in $PATH');
      expect(container('check').remove).toHaveBeenCalled();
    });

    it.each([
      [MISSING_GIT_EXIT, 'Image agent:1 does not contain git'],
      [MISSING_CLI_EXIT, 'Image agent:1 does not contain the claude CLI'],
      [MISSING_JQ_EXIT, `Image agent:1 does not contain jq in ${COMMAND_LIMIT_SEARCH_PATH}`],
      [MISSING_SETSID_EXIT, `Image agent:1 does not contain setsid in ${COMMAND_LIMIT_SEARCH_PATH}`],
      [OLD_BASH_EXIT, `Image agent:1 does not contain bash 5 or later in ${COMMAND_LIMIT_SEARCH_PATH}`],
    ])('fails naming the missing tool when the check exits %i', async (statusCode, message) => {
      docker.createContainer.mockImplementationOnce(() => {
        const check = container('check');
        check.wait.mockResolvedValueOnce({ StatusCode: statusCode });

        return Promise.resolve(check);
      });

      await expect(
        service.checkAgentImage('agent:1', imageInfo(), 'claude', IDS, new AbortController().signal)
      ).rejects.toThrow(message);
      expect(container('check').remove).toHaveBeenCalled();
    });

    it('fails when the CLI exits non-zero', async () => {
      docker.createContainer.mockImplementationOnce(() => {
        const check = container('check');
        check.wait.mockResolvedValueOnce({ StatusCode: 127 });

        return Promise.resolve(check);
      });

      await expect(
        service.checkAgentImage('agent:1', imageInfo(), 'claude', IDS, new AbortController().signal)
      ).rejects.toThrow('exited 127');
    });

    it('gives up on a CLI that does not finish in time, and removes the check container', async () => {
      vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort());
      docker.createContainer.mockImplementationOnce(() => {
        const check = container('check');
        check.wait.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) =>
          abortSignal.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve({ StatusCode: 0 })
        );

        return Promise.resolve(check);
      });

      await expect(
        service.checkAgentImage('agent:1', imageInfo(), 'claude', IDS, new AbortController().signal)
      ).rejects.toThrow('Image agent:1: `claude --version` did not finish within 60 seconds');
      expect(container('check').remove).toHaveBeenCalled();
    });

    it.each(['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'])(
      'refuses an image that sets %s',
      async variable => {
        const info = imageInfo({ Env: [`${variable}=1`] });

        await expect(
          service.checkAgentImage('agent:1', info, 'claude', IDS, new AbortController().signal)
        ).rejects.toThrow(`Image agent:1 sets ${variable}`);
      }
    );

    it('checks an image id once', async () => {
      await service.checkAgentImage('agent:1', imageInfo(), 'claude', IDS, new AbortController().signal);
      await service.checkAgentImage('agent:1', imageInfo(), 'claude', IDS, new AbortController().signal);

      expect(docker.createContainer).toHaveBeenCalledTimes(1);
    });
  });

  it('creates the run network internal', async () => {
    await service.createRunNetwork('foundry-task12-run2', { a: 'b' });

    expect(docker.createNetwork).toHaveBeenCalledWith({
      Name: 'foundry-task12-run2',
      Driver: 'bridge',
      Internal: true,
      Labels: { a: 'b' },
    });
  });

  describe('connectEgressNetwork', () => {
    it('creates the shared egress network when there is none, with inter-container traffic off', async () => {
      network('foundry-egress').inspect.mockRejectedValueOnce(dockerError(404));

      await Promise.all([service.connectEgressNetwork('agent-1'), service.connectEgressNetwork('agent-2')]);

      expect(docker.createNetwork).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          Name: 'foundry-egress',
          Options: { 'com.docker.network.bridge.enable_icc': 'false' },
        })
      );
      expect(network('foundry-egress').connect).toHaveBeenCalledWith({ Container: 'agent-1' });
      expect(network('foundry-egress').connect).toHaveBeenCalledWith({ Container: 'agent-2' });
    });

    it('accepts an egress network another process created first', async () => {
      network('foundry-egress').inspect.mockRejectedValueOnce(dockerError(404));
      docker.createNetwork.mockRejectedValueOnce(dockerError(409));

      await expect(service.connectEgressNetwork('agent')).resolves.toBeUndefined();
    });

    it('refuses an existing egress network that lets containers reach each other as a config fault', async () => {
      network('foundry-egress').inspect.mockResolvedValueOnce({ Options: {} });

      const connected = service.connectEgressNetwork('agent');

      await expect(connected).rejects.toThrow('Network foundry-egress lets containers reach each other');
      await expect(connected).rejects.toBeInstanceOf(RunConfigError);
      expect(network('foundry-egress').connect).not.toHaveBeenCalled();
    });

    it('refuses a network another process created first that lets containers reach each other', async () => {
      network('foundry-egress').inspect.mockRejectedValueOnce(dockerError(404)).mockResolvedValueOnce({ Options: {} });
      docker.createNetwork.mockRejectedValueOnce(dockerError(409));

      await expect(service.connectEgressNetwork('agent')).rejects.toBeInstanceOf(RunConfigError);
      expect(network('foundry-egress').connect).not.toHaveBeenCalled();
    });

    it('refuses a network replaced since the last run with one that lets containers reach each other', async () => {
      await service.connectEgressNetwork('agent-1');

      network('foundry-egress').inspect.mockResolvedValueOnce({ Options: {} });

      await expect(service.connectEgressNetwork('agent-2')).rejects.toBeInstanceOf(RunConfigError);
      expect(network('foundry-egress').connect).toHaveBeenCalledExactlyOnceWith({ Container: 'agent-1' });
    });

    it('creates the network again when it was removed since the last run', async () => {
      await service.connectEgressNetwork('agent-1');

      network('foundry-egress').inspect.mockRejectedValueOnce(dockerError(404));

      await service.connectEgressNetwork('agent-2');

      expect(docker.createNetwork).toHaveBeenCalledOnce();
      expect(network('foundry-egress').connect).toHaveBeenCalledWith({ Container: 'agent-2' });
    });

    it('creates the network again when it was removed between the check and the connect', async () => {
      network('foundry-egress').connect.mockRejectedValueOnce(dockerError(404));
      network('foundry-egress')
        .inspect.mockResolvedValueOnce({ Options: { 'com.docker.network.bridge.enable_icc': 'false' } })
        .mockRejectedValueOnce(dockerError(404));

      await service.connectEgressNetwork('agent');

      expect(docker.createNetwork).toHaveBeenCalledOnce();
      expect(network('foundry-egress').connect).toHaveBeenCalledTimes(2);
    });

    it('tries again after a failure', async () => {
      network('foundry-egress').inspect.mockRejectedValueOnce(dockerError(500));

      await expect(service.connectEgressNetwork('agent')).rejects.toThrow();
      await expect(service.connectEgressNetwork('agent')).resolves.toBeUndefined();
    });
  });

  it('starts a service reachable on the run network by its key', async () => {
    await service.startService({
      name: 'foundry-task12-run2-svc-postgres',
      image: 'postgres:17',
      env: { POSTGRES_PASSWORD: 'postgres' },
      network: 'foundry-task12-run2',
      alias: 'postgres',
      labels: {},
    });

    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Env: ['POSTGRES_PASSWORD=postgres'],
        HostConfig: { NetworkMode: 'foundry-task12-run2', Privileged: false },
        NetworkingConfig: { EndpointsConfig: { 'foundry-task12-run2': { Aliases: ['postgres'] } } },
      })
    );
    expect(container('container-1').start).toHaveBeenCalled();
  });

  it("creates the agent unprivileged under Docker's init, on the runner's entrypoint, with only the configured binds and limits", async () => {
    await service.createAgentContainer({
      runId: 34,
      name: 'foundry-task12-run2-agent',
      image: 'agent:1',
      env: ['MODEL=haiku'],
      network: 'foundry-task12-run2',
      mounts: [
        { source: '/srv/cache/npm', target: '/home/agent/.npm', readOnly: false },
        { source: '/srv/ref', target: '/ref', readOnly: true },
      ],
      cpus: 1.5,
      memoryBytes: 512 * 1024 ** 2,
      pidsLimit: 4096,
      labels: {},
    });

    const [options] = docker.createContainer.mock.calls[0] as [Docker.ContainerCreateOptions];

    expect(options.Entrypoint).toEqual(['bash', AGENT_ENTRYPOINT_PATH]);
    expect(options.Cmd).toEqual([]);
    expect(options.HostConfig).toEqual({
      Init: true,
      NetworkMode: 'foundry-task12-run2',
      Mounts: [
        { Type: 'bind', Source: '/srv/cache/npm', Target: '/home/agent/.npm', ReadOnly: false },
        { Type: 'bind', Source: '/srv/ref', Target: '/ref', ReadOnly: true },
      ],
      NanoCpus: 1_500_000_000,
      CpusetCpus: '0,1',
      Memory: 512 * 1024 ** 2,
      MemorySwap: 512 * 1024 ** 2,
      PidsLimit: 4096,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
    });
    expect(options.HostConfig?.Binds).toBeUndefined();
  });

  describe('CPU pinning', () => {
    const agentOptions = (runId: number, cpus?: number) => ({
      runId,
      name: `agent-${runId}`,
      image: 'agent:1',
      env: [],
      network: 'run',
      mounts: [],
      cpus,
      pidsLimit: 4096,
      labels: {},
    });

    const hostConfigOf = (call: number) =>
      (docker.createContainer.mock.calls[call] as [Docker.ContainerCreateOptions])[0].HostConfig;

    const cpusetsCreated = () => docker.createContainer.mock.calls.map((_, call) => hostConfigOf(call)?.CpusetCpus);

    const keptAgent = (id: string, runId: number) => ({
      Id: id,
      Names: [],
      State: 'running',
      Labels: { 'swarmfoundry.role': 'agent', 'swarmfoundry.run-id': String(runId) },
    });

    it('leaves an agent without a CPU cap unpinned, without asking the daemon', async () => {
      await service.createAgentContainer(agentOptions(1));

      expect(hostConfigOf(0)?.CpusetCpus).toBeUndefined();
      expect(hostConfigOf(0)?.NanoCpus).toBeUndefined();
      expect(docker.info).not.toHaveBeenCalled();
    });

    it('pins concurrent agents to different cores, asking the daemon its CPU count once', async () => {
      await service.createAgentContainer(agentOptions(1, 4));
      await service.createAgentContainer(agentOptions(2, 2.5));

      expect(hostConfigOf(0)).toMatchObject({ NanoCpus: 4_000_000_000, CpusetCpus: '0,1,2,3' });
      expect(hostConfigOf(1)).toMatchObject({ NanoCpus: 2_500_000_000, CpusetCpus: '4,5,6' });
      expect(docker.info).toHaveBeenCalledOnce();
    });

    it('shares one CPU count lookup between agents created at once', async () => {
      await Promise.all([
        service.createAgentContainer(agentOptions(1, 4)),
        service.createAgentContainer(agentOptions(2, 4)),
      ]);

      expect(docker.info).toHaveBeenCalledOnce();
      expect(new Set(cpusetsCreated())).toEqual(new Set(['0,1,2,3', '4,5,6,7']));
    });

    it('asks the daemon again after a failed CPU count', async () => {
      docker.info.mockRejectedValueOnce(dockerError(500));

      await expect(service.createAgentContainer(agentOptions(1, 2))).rejects.toThrow();
      await service.createAgentContainer(agentOptions(1, 2));

      expect(hostConfigOf(0)).toMatchObject({ CpusetCpus: '0,1' });
    });

    it('pins to the cores a restricted daemon names when it refuses the cpuset', async () => {
      docker.createContainer.mockRejectedValueOnce(
        dockerError(400, 'Requested CPUs are not available - requested 0,1, available: 2-5')
      );

      await expect(service.createAgentContainer(agentOptions(1, 2))).resolves.toBe('container-1');
      await service.createAgentContainer(agentOptions(2, 2));

      expect(cpusetsCreated()).toEqual(['0,1', '2,3', '4,5']);
    });

    it('turns pinning off when the daemon refuses a cpuset without naming its cores', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');

      docker.createContainer.mockRejectedValueOnce(dockerError(400, 'cpuset refused'));

      await service.createAgentContainer(agentOptions(1, 2));
      await service.createAgentContainer(agentOptions(2, 2));

      expect(cpusetsCreated()).toEqual(['0,1', undefined, undefined]);
      expect(hostConfigOf(2)?.NanoCpus).toBe(2_000_000_000);
      expect(warn).toHaveBeenCalledOnce();
    });

    it('raises a refused unpinned agent without retrying', async () => {
      docker.createContainer.mockRejectedValueOnce(dockerError(400, 'bad request'));

      await expect(service.createAgentContainer(agentOptions(1))).rejects.toThrow('bad request');
      expect(docker.createContainer).toHaveBeenCalledOnce();
    });

    it('releases the run’s cores when its sandbox is removed, even when a removal fails', async () => {
      await service.createAgentContainer(agentOptions(1, 4));
      docker.listContainers.mockRejectedValueOnce(dockerError(500, 'daemon busy'));

      await expect(service.removeRun(1)).rejects.toThrow('daemon busy');
      await service.createAgentContainer(agentOptions(2, 4));

      expect(hostConfigOf(1)).toMatchObject({ CpusetCpus: '0,1,2,3' });
    });

    it('moves an agent sharing its cores onto the cores a removed run frees, keeping its core count', async () => {
      docker.info.mockResolvedValue({ NCPU: 4 });

      await service.createAgentContainer(agentOptions(1, 2));
      await service.createAgentContainer(agentOptions(2, 2));
      await service.createAgentContainer(agentOptions(3, 2));
      await service.removeRun(2);

      expect(cpusetsCreated()).toEqual(['0,1', '2,3', '0,1']);
      expect(container('agent-1').update).toHaveBeenCalledWith({ CpusetCpus: '2,3' });
      expect(container('agent-3').update).not.toHaveBeenCalled();

      await service.createAgentContainer(agentOptions(4, 2));

      expect(hostConfigOf(3)).toMatchObject({ CpusetCpus: '0,1' });
    });

    it('leaves agents in place when no core is shared', async () => {
      await service.createAgentContainer(agentOptions(1, 4));
      await service.createAgentContainer(agentOptions(2, 4));
      await service.removeRun(1);

      expect(container('agent-2').update).not.toHaveBeenCalled();
    });

    it('logs and ignores a failed move', async () => {
      docker.info.mockResolvedValue({ NCPU: 2 });

      await service.createAgentContainer(agentOptions(1, 1));
      await service.createAgentContainer(agentOptions(2, 1));
      await service.createAgentContainer(agentOptions(3, 1));
      container('agent-1').update.mockRejectedValueOnce(dockerError(404));

      await expect(service.removeRun(2)).resolves.toBeUndefined();
      expect(container('agent-1').update).toHaveBeenCalledWith({ CpusetCpus: '1' });
    });

    it('holds the cores of each kept agent through the startup sweep, until its sandbox is removed', async () => {
      docker.listContainers.mockResolvedValueOnce([keptAgent('kept', 1)]);
      container('kept').inspect.mockResolvedValue({ HostConfig: { CpusetCpus: '0-2,3' } });

      await service.removeRunsExcept(new Set([1]));
      await service.createAgentContainer(agentOptions(2, 4));
      await service.removeRun(1);
      await service.createAgentContainer(agentOptions(3, 4));

      expect(cpusetsCreated()).toEqual(['4,5,6,7', '0,1,2,3']);
    });

    it('reserves nothing for an unpinned, uninspectable or removed agent', async () => {
      docker.listContainers.mockResolvedValueOnce([
        keptAgent('unpinned', 1),
        keptAgent('gone', 2),
        keptAgent('stale', 3),
      ]);
      container('gone').inspect.mockRejectedValue(dockerError(404));
      container('stale').inspect.mockResolvedValue({ HostConfig: { CpusetCpus: '0-3' } });

      await service.removeRunsExcept(new Set([1, 2]));
      await service.createAgentContainer(agentOptions(4, 4));

      expect(container('stale').inspect).not.toHaveBeenCalled();
      expect(cpusetsCreated()).toEqual(['0,1,2,3']);
    });
  });

  it('copies files in as one archive extracted at /', async () => {
    await service.copyFiles('agent', [{ path: '/foundry/prompt.md', content: 'x' }]);

    expect(container('agent').putArchive).toHaveBeenCalledWith(expect.any(Buffer), { path: '/' });
  });

  it('demuxes attached output into the sinks, and ends when the stream does', async () => {
    const stream = new PassThrough();
    const stdout: string[] = [];

    container('agent').attach.mockResolvedValue(stream);
    docker.modem.demuxStream.mockImplementation((input: PassThrough, out: NodeJS.WritableStream) => {
      input.on('data', (chunk: Buffer) => out.write(chunk));
    });

    const attached = await service.attach('agent', new AbortController().signal, {
      stdout: chunk => stdout.push(chunk.toString()),
      stderr: () => undefined,
    });

    stream.end(Buffer.from('line\n'));
    await attached.ended;

    expect(container('agent').attach).toHaveBeenCalledWith({
      stream: true,
      stdout: true,
      stderr: true,
      abortSignal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(stdout).toEqual(['line\n']);
  });

  it('follows the logs from the start, demuxed into the sinks', async () => {
    const stream = new PassThrough();
    const stdout: string[] = [];

    container('agent').logs.mockResolvedValue(stream);
    docker.modem.demuxStream.mockImplementation((input: PassThrough, out: NodeJS.WritableStream) => {
      input.on('data', (chunk: Buffer) => out.write(chunk));
    });

    const logs = await service.followLogs('agent', new AbortController().signal, {
      stdout: chunk => stdout.push(chunk.toString()),
      stderr: () => undefined,
    });

    stream.end(Buffer.from('line\n'));
    await logs.ended;

    expect(container('agent').logs).toHaveBeenCalledWith({
      follow: true,
      stdout: true,
      stderr: true,
      abortSignal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(stdout).toEqual(['line\n']);
  });

  describe('signal', () => {
    it('sends the signal', async () => {
      await service.signal('agent', 'SIGINT');

      expect(container('agent').kill).toHaveBeenCalledWith({ signal: 'SIGINT' });
    });

    it.each([404, 409])('treats a %d as already stopped', async status => {
      container('agent').kill.mockRejectedValueOnce(dockerError(status));

      await expect(service.signal('agent', 'SIGTERM')).resolves.toBeUndefined();
    });

    it('raises any other failure', async () => {
      container('agent').kill.mockRejectedValueOnce(dockerError(500));

      await expect(service.signal('agent', 'SIGTERM')).rejects.toThrow();
    });
  });

  describe('removeRun', () => {
    it('removes the run’s containers with their volumes, then its networks, selected by label', async () => {
      docker.listContainers.mockResolvedValue([{ Id: 'agent' }, { Id: 'postgres' }]);
      docker.listNetworks.mockResolvedValue([{ Id: 'run-network' }]);
      container('postgres').remove.mockRejectedValueOnce(dockerError(404));

      await service.removeRun(34);

      const filters = { label: ['swarmfoundry.namespace=foundry', 'swarmfoundry.run-id=34'] };

      expect(docker.listContainers).toHaveBeenCalledWith({ all: true, filters });
      expect(docker.listNetworks).toHaveBeenCalledWith({ filters });
      expect(container('agent').remove).toHaveBeenCalledWith({ force: true, v: true });
      expect(network('run-network').remove).toHaveBeenCalled();
    });

    it('removes everything it can, then raises what failed', async () => {
      docker.listContainers.mockResolvedValue([{ Id: 'agent' }, { Id: 'postgres' }]);
      docker.listNetworks.mockResolvedValue([{ Id: 'run-network' }]);
      container('agent').remove.mockRejectedValueOnce(dockerError(500, 'daemon busy'));

      await expect(service.removeRun(34)).rejects.toThrow("Failed to remove part of run 34's sandbox: daemon busy");
      expect(container('postgres').remove).toHaveBeenCalled();
      expect(network('run-network').remove).toHaveBeenCalled();
    });
  });

  describe('removeRunsExcept', () => {
    it('removes every run of the namespace not kept, sparing the egress network', async () => {
      docker.listContainers
        .mockResolvedValueOnce([
          { Id: 'a', Names: [], State: 'running', Labels: { 'swarmfoundry.run-id': '1' } },
          { Id: 'b', Names: [], State: 'exited', Labels: { 'swarmfoundry.run-id': '2' } },
        ])
        .mockResolvedValue([]);
      docker.listNetworks
        .mockResolvedValueOnce([
          { Id: 'n3', Labels: { 'swarmfoundry.role': 'run-network', 'swarmfoundry.run-id': '3' } },
          { Id: 'egress', Labels: { 'swarmfoundry.role': 'egress-network' } },
        ])
        .mockResolvedValue([]);

      await expect(service.removeRunsExcept(new Set([1]))).resolves.toEqual([2, 3]);

      const removedRuns = docker.listNetworks.mock.calls
        .slice(1)
        .map(call => (call[0] as { filters: { label: string[] } }).filters.label[1]);

      expect(removedRuns).toEqual(['swarmfoundry.run-id=2', 'swarmfoundry.run-id=3']);
    });
  });

  it('lists the namespace’s networks with their role and run', async () => {
    docker.listNetworks.mockResolvedValue([
      { Id: 'n1', Labels: { 'swarmfoundry.role': 'run-network', 'swarmfoundry.run-id': '34' } },
      { Id: 'n2', Labels: {} },
    ]);

    await expect(service.listNetworks()).resolves.toEqual([
      { id: 'n1', role: SandboxRole.RUN_NETWORK, runId: 34 },
      { id: 'n2', role: null, runId: null },
    ]);
    expect(docker.listNetworks).toHaveBeenCalledWith({ filters: { label: ['swarmfoundry.namespace=foundry'] } });
  });

  it('lists the namespace’s containers with their task and run', async () => {
    docker.listContainers.mockResolvedValue([
      {
        Id: 'abc',
        Names: ['/foundry-task12-run2-agent'],
        State: 'running',
        Labels: { 'swarmfoundry.role': 'agent', 'swarmfoundry.task-id': '12', 'swarmfoundry.run-id': '34' },
      },
      { Id: 'def', Names: [], State: 'exited', Labels: { 'swarmfoundry.role': 'other' } },
    ]);

    await expect(service.listContainers()).resolves.toEqual([
      {
        id: 'abc',
        name: 'foundry-task12-run2-agent',
        role: SandboxRole.AGENT,
        taskId: 12,
        runId: 34,
        state: 'running',
      },
      { id: 'def', name: 'def', role: null, taskId: null, runId: null, state: 'exited' },
    ]);
    expect(docker.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['swarmfoundry.namespace=foundry'] },
    });
  });
});

describe('CHECK_SCRIPT', () => {
  const bash = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

  let bin: string;

  /** Runs the script with only `tools` on both PATHs, each a stub that exits 0 but bash, the host's own. */
  const check = (...tools: string[]) => {
    for (const tool of tools) {
      writeFileSync(join(bin, tool), tool === 'bash' ? `#!/bin/sh\nexec ${bash} "$@"\n` : '#!/bin/sh\n');
      chmodSync(join(bin, tool), 0o755);
    }

    return spawnSync(bash, ['-c', CHECK_SCRIPT, 'claude', bin], { env: { PATH: bin } }).status;
  };

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'check-script-'));
  });

  afterEach(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  const TOOLS = ['git', 'claude', 'jq', 'setsid', 'bash'];

  it('runs the CLI when every tool is present', () => {
    expect(check(...TOOLS)).toBe(0);
  });

  it.each([
    ['git', MISSING_GIT_EXIT],
    ['claude', MISSING_CLI_EXIT],
    ['jq', MISSING_JQ_EXIT],
    ['setsid', MISSING_SETSID_EXIT],
    ['bash', OLD_BASH_EXIT],
  ])('exits with the missing code when %s is absent', (missing, code) => {
    expect(check(...TOOLS.filter(tool => tool !== missing))).toBe(code);
  });

  it.each([
    ['jq', MISSING_JQ_EXIT],
    ['setsid', MISSING_SETSID_EXIT],
    ['bash', OLD_BASH_EXIT],
  ])("looks for %s on the hook's PATH, not the image's", (missing, code) => {
    check(...TOOLS);

    const hookPath = mkdtempSync(join(tmpdir(), 'check-script-hook-'));

    for (const tool of ['jq', 'setsid', 'bash'].filter(tool => tool !== missing)) {
      symlinkSync(join(bin, tool), join(hookPath, tool));
    }

    try {
      expect(spawnSync(bash, ['-c', CHECK_SCRIPT, 'claude', hookPath], { env: { PATH: bin } }).status).toBe(code);
    } finally {
      rmSync(hookPath, { recursive: true, force: true });
    }
  });

  it('exits with the old-bash code when the bash on the PATH lacks EPOCHREALTIME', () => {
    check(...TOOLS.filter(tool => tool !== 'bash'));
    // A bash 5 without the variable's special meaning, as in bash 4.
    writeFileSync(join(bin, 'bash'), `#!/bin/sh\nexec ${bash} -c 'unset EPOCHREALTIME; eval "$1"' bash "$2"\n`);
    chmodSync(join(bin, 'bash'), 0o755);

    expect(spawnSync(bash, ['-c', CHECK_SCRIPT, 'claude', bin], { env: { PATH: bin } }).status).toBe(OLD_BASH_EXIT);
  });
});
