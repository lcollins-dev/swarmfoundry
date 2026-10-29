import { Injectable, Logger } from '@nestjs/common';
import ms from 'ms';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentOutputService } from './agent-output.service';
import {
  COMMAND_LIMIT_PATH,
  COMMAND_LIMIT_SOURCE,
  COMMAND_WATCHDOG_PATH,
  COMMAND_WATCHDOG_SOURCE,
  CommandLimitService,
} from './command-limit.service';
import { GitIdentityService } from './git-identity.service';
import { AGENT_ENTRYPOINT_PATH, SandboxService } from './sandbox.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { TaskService } from '@/core/task/task.service';

import { RunConfigError } from './run-config.error';
import {
  SandboxLabel,
  SandboxRole,
  type IAgentOutput,
  type IAttachedOutput,
  type IOutputSinks,
  type ISandboxFile,
  type ISandboxIds,
  type StopSignal,
} from './runner.types';
import type { IAgentRunner, IAgentRunRequest } from '@/core/actions/actions.types';
import type { IResolvedAgent } from '@/core/foundry-config/foundry-config.types';
import { DeploymentFault, RunEndReason, type IRunReport } from '@/core/task/task.types';

export const PROMPT_PATH = '/foundry/prompt.md';
export const SYSTEM_PROMPT_PATH = '/foundry/system.md';

/** Managed settings outrank the cloned repo's own. */
export const MANAGED_SETTINGS_PATH = '/etc/claude-code/managed-settings.json';

/** The managed CLAUDE.md loads alongside the cloned repo's own, and the repo cannot exclude it. */
export const MANAGED_INSTRUCTIONS_PATH = '/etc/claude-code/CLAUDE.md';

/** Shipped beside this file, and copied into every agent container. */
export const ENTRYPOINT_SOURCE = join(__dirname, 'agent-entrypoint.sh');

/** Shipped beside this file, and put before the step's own system prompt in every run. */
export const RUNNER_SYSTEM_PROMPT_SOURCE = join(__dirname, 'runner-system-prompt.md');

/** Defaults for long unattended runs, which the environment's `env` overrides. See the runner design, "Agent image". */
export const AGENT_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  CLAUDE_CODE_RETRY_WATCHDOG: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_SYNC_PLUGIN_INSTALL: '1',
  DISABLE_AUTOUPDATER: '1',
};

/** SIGINT lets Claude end its turn; SIGTERM leaves it unfinished. */
export const STOP_SEQUENCE: readonly { signal: StopSignal; graceMs: number }[] = [
  { signal: 'SIGINT', graceMs: 30_000 },
  { signal: 'SIGTERM', graceMs: 10_000 },
  { signal: 'SIGKILL', graceMs: 10_000 },
];

/** How long the last output may trail the container's exit. */
export const OUTPUT_DRAIN_MS = 5_000;

export const DEFAULT_PIDS_LIMIT = 4096;

export const SHUTDOWN_ERROR = 'The orchestrator shut down during the run';
export const AGENT_GONE_ERROR = 'The agent container was gone when the orchestrator restarted';
export const AGENT_NEVER_STARTED_ERROR = 'The agent container had not started when the orchestrator stopped';

const STOPPED_STATES = new Set(['exited', 'dead']);

const AGENT_CLI: Record<IResolvedAgent['type'], string> = { claude: 'claude' };

const AUTH_VARIABLE: Record<IResolvedAgent['auth'], string> = {
  oauth: 'CLAUDE_CODE_OAUTH_TOKEN',
  apiKey: 'ANTHROPIC_API_KEY',
};

/** A host with an optional port, so it cannot redirect REPO_URL's path or scheme. */
const GITLAB_HOST_PATTERN = /^[a-z0-9.-]+(:\d+)?$/i;

// setTimeout overflows above this and fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

type RunEnd =
  | { kind: 'exited'; exitCode: number }
  | { kind: 'waitFailed'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'pluginFailure'; message: string }
  | { kind: 'shutdown' };

interface IRunState {
  /** Once the agent container has started, a shutdown leaves the sandbox for restart recovery. */
  started: boolean;
}

interface IOutputWatch {
  sinks: IOutputSinks;
  pluginFailed: Promise<RunEnd>;
}

/**
 * Executes one run of an agent step as a sandboxed `claude -p` session on the host's Docker daemon, and removes
 * every container and network it created on every path. The one exception is a shutdown after the agent started: the
 * sandbox keeps running, for restart recovery to find by its labels.
 */
@Injectable()
export class AgentRunnerService implements IAgentRunner {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly taskService: TaskService,
    private readonly sandboxService: SandboxService,
    private readonly agentOutputService: AgentOutputService,
    private readonly gitIdentityService: GitIdentityService,
    private readonly commandLimitService: CommandLimitService
  ) {}

  run(request: IAgentRunRequest): Promise<IRunReport> {
    return this.supervise(request, { started: false }, (detach, state) => this.execute(request, detach, state));
  }

  /** The agent started before the restart, so a shutdown leaves its sandbox running again. */
  resume(request: IAgentRunRequest): Promise<IRunReport> {
    return this.supervise(request, { started: true }, detach => this.reattach(request, detach));
  }

  async removeSandboxesExcept(runIds: ReadonlySet<number>): Promise<void> {
    try {
      const removed = await this.sandboxService.removeRunsExcept(runIds);

      if (removed.length > 0) {
        this.logger.log({ runIds: removed }, 'removeSandboxesExcept(): Removed the sandboxes no running task owns');
      }
    } catch (error) {
      this.logger.error(
        { error: this.foundryConfigService.redactText(error instanceof Error ? error.message : String(error)) },
        'removeSandboxesExcept(): Failed to remove the sandboxes no running task owns'
      );
    }
  }

  /** Settles with a report however `work` ends, and removes the sandbox unless a shutdown leaves a started agent. */
  private async supervise(
    request: IAgentRunRequest,
    state: IRunState,
    work: (detach: AbortSignal, state: IRunState) => Promise<IRunReport>
  ): Promise<IRunReport> {
    const { task, run, signal } = request;

    if (signal.aborted) {
      return this.shutdownReport(state.started);
    }

    const log = { taskId: task.id, runId: run.id };

    // Closes Docker streams and timers, on shutdown and once the run ends.
    const detach = new AbortController();
    const onShutdown = () => detach.abort();

    signal.addEventListener('abort', onShutdown, { once: true });

    try {
      return await work(detach.signal, state);
    } catch (error) {
      if (this.isShuttingDown(signal)) {
        return this.shutdownReport(state.started);
      }

      const message = this.redact(request, error instanceof Error ? error.message : String(error));

      this.logger.error({ ...log, error: message }, 'supervise(): The run failed outside the agent');

      return {
        exitCode: null,
        result: null,
        error: message,
        deploymentFault: error instanceof RunConfigError ? DeploymentFault.PERMANENT : DeploymentFault.TRANSIENT,
      };
    } finally {
      signal.removeEventListener('abort', onShutdown);
      detach.abort();

      if (this.isShuttingDown(signal) && state.started) {
        this.logger.log(log, 'supervise(): Shutting down, so the sandbox keeps running for restart recovery');
      } else {
        await this.removeSandbox(request);
      }
    }
  }

  private async execute(request: IAgentRunRequest, detach: AbortSignal, state: IRunState): Promise<IRunReport> {
    const { step, task, run, signal } = request;
    const ids: ISandboxIds = {
      taskId: task.id,
      runId: run.id,
      runNumber: run.number,
      list: run.list,
      step: run.step,
    };
    const { environment, agent } = step;

    const output = this.agentOutputService.create(run.id, agent);
    const env = await this.agentEnv(request, detach);
    const files = await this.agentFiles(request);

    const image = await this.sandboxService.ensureImage(environment.image, detach);

    await this.sandboxService.checkAgentImage(environment.image, image, AGENT_CLI[agent.type], ids, detach);

    for (const service of Object.values(environment.services)) {
      await this.sandboxService.ensureImage(service.image, detach);
    }

    if (this.isShuttingDown(signal)) {
      return this.shutdownReport(false);
    }

    const network = this.sandboxService.baseName(ids);

    await this.sandboxService.createRunNetwork(network, this.sandboxService.labels(ids, SandboxRole.RUN_NETWORK));

    for (const [key, service] of Object.entries(environment.services)) {
      await this.sandboxService.startService({
        name: `${network}-svc-${key}`,
        image: service.image,
        env: service.env,
        network,
        alias: key,
        labels: this.sandboxService.labels(ids, SandboxRole.SERVICE, { [SandboxLabel.SERVICE]: key }),
      });
    }

    const containerId = await this.sandboxService.createAgentContainer({
      runId: run.id,
      name: `${network}-agent`,
      // The checked image, even if the tag moves meanwhile.
      image: image.Id,
      env,
      network,
      mounts: environment.mounts,
      cpus: environment.resources.cpus,
      memoryBytes: environment.resources.memory,
      pidsLimit: environment.resources.pids ?? DEFAULT_PIDS_LIMIT,
      labels: this.sandboxService.labels(ids, SandboxRole.AGENT),
    });

    await this.taskService.setContainerId(run, containerId);
    await this.sandboxService.connectEgressNetwork(containerId);
    await this.sandboxService.copyFiles(containerId, files);

    if (this.isShuttingDown(signal)) {
      return this.shutdownReport(false);
    }

    return this.follow(request, containerId, output, detach, state);
  }

  /** Starts the agent and reads its output until it exits, times out, fails its plugin check, or the app shuts down. */
  private async follow(
    request: IAgentRunRequest,
    containerId: string,
    output: IAgentOutput,
    detach: AbortSignal,
    state: IRunState
  ): Promise<IRunReport> {
    const { step, task, run } = request;
    const watch = this.watch(output);
    const attached = await this.sandboxService.attach(containerId, detach, watch.sinks);

    await this.sandboxService.start(containerId);
    state.started = true;

    this.logger.log(
      { taskId: task.id, runId: run.id, containerId, image: step.environment.image },
      `follow(): Started the agent for task ${task.id}`
    );

    return this.awaitEnd(request, containerId, output, attached, watch.pluginFailed, detach, step.timeout);
  }

  /**
   * Follows the agent of a run a restart cut off, from `docker logs`. Lines already stored are read for their events
   * but not stored again. A live agent gets what remains of its timeout since the run started.
   */
  private async reattach(request: IAgentRunRequest, detach: AbortSignal): Promise<IRunReport> {
    const { step, task, run } = request;
    const containers = await this.sandboxService.listContainers();
    const agent = containers.find(container => container.runId === run.id && container.role === SandboxRole.AGENT);

    const storedLineCount = await this.taskService.countTranscriptLines(run.id);

    // A gone agent that stored no line never got as far as Claude's first event, so it counts as never started.
    if (agent === undefined || agent.state === 'created') {
      return {
        exitCode: null,
        result: null,
        error: agent === undefined ? AGENT_GONE_ERROR : AGENT_NEVER_STARTED_ERROR,
        deploymentFault: DeploymentFault.TRANSIENT,
        neverStarted: agent !== undefined || storedLineCount === 0,
      };
    }

    const output = this.agentOutputService.create(run.id, step.agent, storedLineCount);
    const watch = this.watch(output);
    const logs = await this.sandboxService.followLogs(agent.id, detach, watch.sinks);

    const timeoutMs = STOPPED_STATES.has(agent.state)
      ? Infinity
      : Math.max(0, step.timeout - (Date.now() - run.startDate.getTime()));

    this.logger.log(
      { taskId: task.id, runId: run.id, containerId: agent.id, state: agent.state, storedLineCount, timeoutMs },
      `reattach(): Reattached to the agent for task ${task.id}`
    );

    return this.awaitEnd(request, agent.id, output, logs, watch.pluginFailed, detach, timeoutMs);
  }

  private watch(output: IAgentOutput): IOutputWatch {
    let raisePluginFailure: (message: string) => void = () => undefined;

    const pluginFailed = new Promise<RunEnd>(resolve => {
      raisePluginFailure = message => resolve({ kind: 'pluginFailure', message });
    });

    const sinks: IOutputSinks = {
      stdout: chunk => {
        this.agentOutputService.writeStdout(output, chunk);

        const failure = this.agentOutputService.pluginFailure(output);

        if (failure !== null) {
          raisePluginFailure(failure);
        }
      },
      stderr: chunk => this.agentOutputService.writeStderr(output, chunk),
    };

    return { sinks, pluginFailed };
  }

  /** Call once the agent has started. */
  private async awaitEnd(
    request: IAgentRunRequest,
    containerId: string,
    output: IAgentOutput,
    attached: IAttachedOutput,
    pluginFailed: Promise<RunEnd>,
    detach: AbortSignal,
    timeoutMs: number
  ): Promise<IRunReport> {
    const { step, task, run, signal } = request;
    const log = { taskId: task.id, runId: run.id };

    const exited = this.sandboxService.wait(containerId, detach).then(
      (exitCode): RunEnd => ({ kind: 'exited', exitCode }),
      (error: unknown): RunEnd => ({ kind: 'waitFailed', error })
    );

    const timedOut = this.delay(timeoutMs, detach).then(
      (): RunEnd => (detach.aborted ? { kind: 'shutdown' } : { kind: 'timeout' })
    );

    const end = await Promise.race([exited, pluginFailed, timedOut]);

    let exitCode: number | null = null;
    let stopError: string | null = null;

    if (end.kind === 'waitFailed' && !this.isShuttingDown(signal)) {
      throw end.error;
    } else if (end.kind === 'exited') {
      exitCode = end.exitCode;
    } else if (end.kind === 'timeout') {
      const stoppedWith = await this.stop(containerId, exited, detach);

      stopError = `Timed out after ${ms(step.timeout, { long: true })}, stopped with ${stoppedWith}`;
    } else if (end.kind === 'pluginFailure') {
      // Nothing worth finishing has run yet, since `system/init` comes before the first query.
      await this.sandboxService.signal(containerId, 'SIGKILL');
      await Promise.race([exited, this.delay(OUTPUT_DRAIN_MS, detach)]);

      stopError = end.message;
    }

    if (this.isShuttingDown(signal)) {
      // A line cut off mid-way is left out, so recovery can resume from `docker logs` after the stored line count.
      await this.agentOutputService.flush(output);

      return this.shutdownReport(true);
    }

    await Promise.race([attached.ended, this.delay(OUTPUT_DRAIN_MS, detach)]);
    await this.agentOutputService.finish(output);

    const failure = this.failure(output, exitCode, stopError);
    const report: IRunReport = {
      exitCode,
      result: output.result,
      error: failure === null ? null : this.redact(request, failure.error),
      ...(output.usage === null ? {} : { usage: output.usage }),
    };

    if (end.kind === 'timeout') {
      report.endReason = RunEndReason.TIMEOUT;
    } else if (failure?.byRunner === true) {
      report.endReason = RunEndReason.RUNNER_ERROR;
    }

    this.logger.log(
      { ...log, exitCode, error: report.error, lines: output.lineCount },
      `awaitEnd(): The agent for task ${task.id} ended`
    );

    return report;
  }

  /** Returns the signal that stopped the container. */
  private async stop(containerId: string, exited: Promise<RunEnd>, detach: AbortSignal): Promise<StopSignal> {
    let sent: StopSignal = 'SIGINT';

    for (const step of STOP_SEQUENCE) {
      sent = step.signal;

      await this.sandboxService.signal(containerId, step.signal);

      const stopped = await Promise.race([exited.then(() => true), this.delay(step.graceMs, detach).then(() => false)]);

      if (stopped || detach.aborted) {
        break;
      }
    }

    return sent;
  }

  /**
   * Null for a clean run. A failed run's message ends with the stderr tail, as the report has no field for it.
   * `byRunner` unless the agent exited non-zero.
   */
  private failure(
    output: IAgentOutput,
    exitCode: number | null,
    stopError: string | null
  ): { error: string; byRunner: boolean } | null {
    const runnerReason =
      stopError ??
      this.agentOutputService.pluginFailure(output) ??
      (exitCode === 0 && output.enabledPlugins.length > 0 && !this.agentOutputService.hasInit(output)
        ? 'Claude exited without reporting system/init, so its plugins went unchecked'
        : null) ??
      (output.writeError === null ? null : `Failed to store the transcript: ${output.writeError}`);

    const reason = runnerReason ?? (exitCode === 0 ? null : `The agent exited with code ${exitCode}`);

    if (reason === null) {
      return null;
    }

    const stderr = this.agentOutputService.stderrTail(output);

    return { error: stderr === null ? reason : `${reason}\n\nstderr:\n${stderr}`, byRunner: runnerReason !== null };
  }

  private async agentEnv({ step, task, run }: IAgentRunRequest, signal: AbortSignal): Promise<string[]> {
    const { environment, agent } = step;
    const host = Object.hasOwn(environment.env, 'GITLAB_HOST') ? environment.env.GITLAB_HOST : '';

    if (!GITLAB_HOST_PATTERN.test(host)) {
      throw new RunConfigError(
        `Environment ${environment.name} must set GITLAB_HOST to the GitLab web host, such as gitlab.example.com`
      );
    }

    const gitIdentity = await this.gitIdentityService.missingVariables(environment.name, environment.env, host, signal);

    const variables: Record<string, string> = {
      ...AGENT_ENV_DEFAULTS,
      ...environment.env,
      ...gitIdentity,
      REPO_URL: `https://${host}/${task.projectPath}.git`,
      MODEL: agent.model,
      FOUNDRY_TASK_ID: String(task.id),
      FOUNDRY_RUN_ID: String(run.id),
      ...(task.issueIid === null ? {} : { FOUNDRY_ISSUE_IID: String(task.issueIid) }),
      [AUTH_VARIABLE[agent.auth]]: agent.token,
    };

    return Object.entries(variables).map(([name, value]) => `${name}=${value}`);
  }

  private async agentFiles({ trigger, step, task, run, failure }: IAgentRunRequest): Promise<ISandboxFile[]> {
    const context = await this.taskService.promptContext(trigger, task, run);
    const prompts = this.foundryConfigService.renderPrompts(step, { ...context, failure });
    // Each file shipped beside this one is read per run, so an edit under `watchAssets` reaches the next run.
    const runnerSystemPrompt = this.commandLimitService.systemPrompt(
      (await readFile(RUNNER_SYSTEM_PROMPT_SOURCE, 'utf8')).trim(),
      step.agent.settings?.content,
      step.environment.env
    );
    const systemPrompt = [runnerSystemPrompt, prompts.systemPrompt].filter(part => part !== undefined).join('\n\n');
    const settings = this.commandLimitService.managedSettings(step.agent.settings?.content, step.environment.env);
    const files: ISandboxFile[] = [
      { path: PROMPT_PATH, content: prompts.prompt },
      { path: SYSTEM_PROMPT_PATH, content: systemPrompt },
      { path: MANAGED_SETTINGS_PATH, content: settings },
    ];

    if (step.agent.instructions !== undefined) {
      files.push({ path: MANAGED_INSTRUCTIONS_PATH, content: step.agent.instructions.content });
    }

    files.push(
      { path: AGENT_ENTRYPOINT_PATH, content: await readFile(ENTRYPOINT_SOURCE, 'utf8') },
      { path: COMMAND_LIMIT_PATH, content: await readFile(COMMAND_LIMIT_SOURCE, 'utf8') },
      { path: COMMAND_WATCHDOG_PATH, content: await readFile(COMMAND_WATCHDOG_SOURCE, 'utf8') }
    );

    return files;
  }

  private async removeSandbox(request: IAgentRunRequest): Promise<void> {
    const { task, run } = request;

    try {
      await this.sandboxService.removeRun(run.id);
    } catch (error) {
      this.logger.error(
        {
          taskId: task.id,
          runId: run.id,
          error: this.redact(request, error instanceof Error ? error.message : String(error)),
        },
        'removeSandbox(): Failed to remove the containers and networks of the run'
      );
    }
  }

  /** Resolves after `delayMs`, or as soon as `signal` aborts. */
  private delay(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      if (signal.aborted) {
        resolve();

        return;
      }

      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };

      const timer = setTimeout(done, Math.min(delayMs, MAX_TIMER_MS));

      signal.addEventListener('abort', done, { once: true });
    });
  }

  private redact({ step }: IAgentRunRequest, text: string): string {
    return this.foundryConfigService.redactText(text, [step.agent.token]);
  }

  /** A call rather than a property read, since TypeScript would keep a narrowed `signal.aborted` across awaits. */
  private isShuttingDown(signal: AbortSignal): boolean {
    return signal.aborted;
  }

  private shutdownReport(started: boolean): IRunReport {
    return { exitCode: null, result: null, error: SHUTDOWN_ERROR, neverStarted: !started };
  }
}
