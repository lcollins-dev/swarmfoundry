import { Logger } from '@nestjs/common';
import type Docker from 'dockerode';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunTranscriptLine } from '@/core/task/entities/run-transcript-line.entity';
import { Run } from '@/core/task/entities/run.entity';
import { Task } from '@/core/task/entities/task.entity';

import { AgentOutputService } from './agent-output.service';
import {
  AGENT_GONE_ERROR,
  AGENT_NEVER_STARTED_ERROR,
  AgentRunnerService,
  DEFAULT_PIDS_LIMIT,
  ENTRYPOINT_SOURCE,
  MANAGED_INSTRUCTIONS_PATH,
  MANAGED_SETTINGS_PATH,
  PROMPT_PATH,
  RUNNER_SYSTEM_PROMPT_SOURCE,
  SHUTDOWN_ERROR,
  STOP_SEQUENCE,
  SYSTEM_PROMPT_PATH,
} from './agent-runner.service';
import {
  COMMAND_LIMIT_PATH,
  COMMAND_LIMIT_SOURCE,
  COMMAND_WATCHDOG_PATH,
  COMMAND_WATCHDOG_SOURCE,
  CommandLimitService,
} from './command-limit.service';
import type { GitIdentityService } from './git-identity.service';
import { AGENT_ENTRYPOINT_PATH, type SandboxService } from './sandbox.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { REDACTED, SecretRedactionService } from '@/core/foundry-config/secret-redaction.service';
import type { TaskService } from '@/core/task/task.service';

import { RunConfigError } from './run-config.error';
import type {
  IAgentContainerOptions,
  IOutputSinks,
  ISandboxContainer,
  ISandboxFile,
  ISandboxIds,
  IServiceContainerOptions,
  SandboxRole,
  StopSignal,
} from './runner.types';
import type { IAgentRunRequest } from '@/core/actions/actions.types';
import type { IAgentStepConfig, IPromptContext, ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import { DeploymentFault, RunEndReason, StepList } from '@/core/task/task.types';

const AGENT_TOKEN = 'sk-ant-oat-agent-token';
const GITLAB_TOKEN = 'glpat-agent-gitlab';
const TIMEOUT_MS = 60_000;

const NO_USAGE = {
  turns: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  costUsd: null,
};

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });

  return { promise, resolve };
};

const jsonLine = (event: unknown) => Buffer.from(`${JSON.stringify(event)}\n`);

const agentStep = (
  overrides: { auth?: 'oauth' | 'apiKey'; env?: Record<string, string>; plugins?: string[]; instructions?: string } = {}
) =>
  ({
    kind: 'agent',
    timeout: TIMEOUT_MS,
    environment: {
      name: 'node',
      image: 'agent:1',
      env: overrides.env ?? { GITLAB_HOST: 'gitlab.example.com', GITLAB_TOKEN },
      mounts: [{ source: '/srv/cache', target: '/home/agent/.npm', readOnly: false }],
      services: { postgres: { image: 'postgres:17', env: { POSTGRES_PASSWORD: 'postgres' } } },
      resources: { cpus: 2, memory: 1024 },
    },
    agent: {
      name: 'claude',
      type: 'claude',
      auth: overrides.auth ?? 'oauth',
      token: AGENT_TOKEN,
      model: 'haiku',
      settings: {
        path: '/config/settings.json',
        content: JSON.stringify({
          enabledPlugins: Object.fromEntries((overrides.plugins ?? []).map(plugin => [plugin, true])),
        }),
      },
      instructions:
        overrides.instructions === undefined
          ? undefined
          : { path: '/config/CLAUDE.md', content: overrides.instructions },
    },
    prompt: { path: '/config/prompt.md', content: 'Implement' },
  }) as unknown as IAgentStepConfig;

/** Records every Docker step in order. The agent runs until the test settles `exit`. */
class FakeSandbox {
  readonly calls: string[] = [];
  readonly signals: StopSignal[] = [];

  readonly started = deferred<undefined>();
  readonly exit = deferred<number>();
  readonly ended = deferred<undefined>();

  sinks: IOutputSinks | null = null;
  agent: IAgentContainerOptions | null = null;
  files: readonly ISandboxFile[] = [];

  exitOn: { signal: StopSignal; code: number } = { signal: 'SIGKILL', code: 137 };

  ensureImage = vi.fn((image: string) => {
    this.calls.push(`ensureImage ${image}`);

    return Promise.resolve({ Id: `sha256:${image}` } as Docker.ImageInspectInfo);
  });

  checkAgentImage = vi.fn((image: string) => {
    this.calls.push(`checkAgentImage ${image}`);

    return Promise.resolve();
  });

  baseName = (ids: ISandboxIds) =>
    `foundry-task${ids.taskId}-run${ids.runNumber}-${ids.list === StepList.STEPS ? 'step' : 'failurestep'}${ids.step}`;

  labels = (_ids: ISandboxIds, role: SandboxRole, extra: Record<string, string> = {}) => ({ role, ...extra });

  createRunNetwork = vi.fn((name: string) => {
    this.calls.push(`createRunNetwork ${name}`);

    return Promise.resolve();
  });

  startService = vi.fn((options: IServiceContainerOptions) => {
    this.calls.push(`startService ${options.alias} on ${options.network}`);

    return Promise.resolve(`service-${options.alias}`);
  });

  createAgentContainer = vi.fn((options: IAgentContainerOptions) => {
    this.calls.push('createAgentContainer');
    this.agent = options;

    return Promise.resolve('agent-container');
  });

  connectEgressNetwork = vi.fn((containerId: string) => {
    this.calls.push(`connectEgressNetwork ${containerId}`);

    return Promise.resolve();
  });

  copyFiles = vi.fn((_containerId: string, files: readonly ISandboxFile[]) => {
    this.calls.push('copyFiles');
    this.files = files;

    return Promise.resolve();
  });

  attach = vi.fn((_containerId: string, _signal: AbortSignal, sinks: IOutputSinks) => {
    this.calls.push('attach');
    this.sinks = sinks;

    return Promise.resolve({ ended: this.ended.promise });
  });

  start = vi.fn(() => {
    this.calls.push('start');
    this.started.resolve(undefined);

    return Promise.resolve();
  });

  wait = vi.fn(() => {
    this.calls.push('wait');

    return this.exit.promise;
  });

  signal = vi.fn((_containerId: string, signal: StopSignal) => {
    this.signals.push(signal);

    if (signal === this.exitOn.signal) {
      this.finish(this.exitOn.code);
    }

    return Promise.resolve();
  });

  removeRun = vi.fn((runId: number) => {
    this.calls.push(`removeRun ${runId}`);

    return Promise.resolve();
  });

  containers: ISandboxContainer[] = [];

  listContainers = vi.fn(() => Promise.resolve(this.containers));

  followLogs = vi.fn((_containerId: string, _signal: AbortSignal, sinks: IOutputSinks) => {
    this.calls.push('followLogs');
    this.sinks = sinks;
    this.started.resolve(undefined);

    return Promise.resolve({ ended: this.ended.promise });
  });

  removeRunsExcept = vi.fn<(runIds: ReadonlySet<number>) => Promise<number[]>>(() => Promise.resolve([3]));

  stdout(event: unknown): void {
    this.sinks?.stdout(jsonLine(event));
  }

  finish(code: number): void {
    this.exit.resolve(code);
    this.ended.resolve(undefined);
  }
}

describe('AgentRunnerService', () => {
  let sandbox: FakeSandbox;
  let stored: RunTranscriptLine[];
  let service: AgentRunnerService;
  let controller: AbortController;
  let storedLineCount: number;
  let storeError: Error | null;
  let stepSystemPrompt: string | undefined;
  let gitIdentityService: { missingVariables: ReturnType<typeof vi.fn<GitIdentityService['missingVariables']>> };

  const request = (step: IAgentStepConfig = agentStep(), steps = [step]): IAgentRunRequest => {
    const task = new Task({
      triggerName: 'implement',
      sourceName: 'gitlab',
      projectId: 7,
      projectPath: 'group/project',
      projectUrl: 'https://gitlab.example.com/group/project',
      issueIid: 3,
      issueTitle: 'Fix it',
      issueUrl: 'https://gitlab.example.com/group/project/-/issues/3',
      matchedIssue: null,
      change: { kind: 'label', id: 42, createdAt: new Date('2026-10-14T10:00:00Z'), actor: 'ada' },
      fireTime: null,
      cron: null,
      mergeRequest: null,
      queuedDate: new Date(),
    });
    task.id = 5;

    const run = new Run({
      taskId: 5,
      number: 2,
      list: StepList.STEPS,
      step: 0,
      startDate: new Date(),
      configId: null,
      agent: null,
    });
    run.id = 9;

    const trigger = { name: 'implement', steps } as unknown as ITriggerConfig;

    return { trigger, step, task, run, signal: controller.signal };
  };

  beforeEach(() => {
    stepSystemPrompt = 'You are unattended';

    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }

    sandbox = new FakeSandbox();
    stored = [];
    storedLineCount = 0;
    storeError = null;
    controller = new AbortController();
    gitIdentityService = {
      missingVariables: vi.fn<GitIdentityService['missingVariables']>(() =>
        Promise.resolve({ GIT_AUTHOR_NAME: 'Swarm Bot', GIT_AUTHOR_EMAIL: 'bot@example.com' })
      ),
    };

    const secretRedactionService = new SecretRedactionService();
    const foundryConfigService = {
      renderPrompts: (step: IAgentStepConfig, context: IPromptContext) => ({
        prompt: `${step.prompt.content} #${context.issue?.iid ?? ''}${context.failure === undefined ? '' : ` ${context.failure.reason}`}`,
        systemPrompt: stepSystemPrompt,
      }),
      redactText: (text: string, extra: readonly string[] = []) =>
        secretRedactionService.redactText(text, [GITLAB_TOKEN, ...extra]),
    } as unknown as FoundryConfigService;

    const taskService = {
      promptContext: (_trigger: unknown, task: Task) =>
        Promise.resolve(task.issueIid === null ? {} : { issue: { iid: task.issueIid } }),
      countTranscriptLines: vi.fn(() => Promise.resolve(storedLineCount)),
      setContainerId: vi.fn((_run: Run, containerId: string) => {
        sandbox.calls.push(`setContainerId ${containerId}`);

        return Promise.resolve();
      }),
      appendTranscriptLines: vi.fn((lines: RunTranscriptLine[]) => {
        if (storeError !== null) {
          return Promise.reject(storeError);
        }

        stored.push(...lines);

        return Promise.resolve();
      }),
    } as unknown as TaskService;

    service = new AgentRunnerService(
      foundryConfigService,
      taskService,
      sandbox as unknown as SandboxService,
      new AgentOutputService(foundryConfigService, taskService),
      gitIdentityService as unknown as GitIdentityService,
      new CommandLimitService()
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the sandbox in order, runs the agent, then removes everything', async () => {
    const report = service.run(request());

    await sandbox.started.promise;
    sandbox.stdout({ type: 'system', subtype: 'init', plugins: [] });
    sandbox.stdout({ type: 'result', subtype: 'success', result: 'done' });
    sandbox.finish(0);

    await expect(report).resolves.toEqual({
      exitCode: 0,
      result: '{"type":"result","subtype":"success","result":"done"}',
      error: null,
      usage: NO_USAGE,
    });
    expect(sandbox.calls).toEqual([
      'ensureImage agent:1',
      'checkAgentImage agent:1',
      'ensureImage postgres:17',
      'createRunNetwork foundry-task5-run2-step0',
      'startService postgres on foundry-task5-run2-step0',
      'createAgentContainer',
      'setContainerId agent-container',
      'connectEgressNetwork agent-container',
      'copyFiles',
      'attach',
      'start',
      'wait',
      'removeRun 9',
    ]);
  });

  it('honours resources.pids over the default', async () => {
    const step = agentStep();
    step.environment.resources.pids = 64;

    const report = service.run(request(step));

    await sandbox.started.promise;
    sandbox.finish(0);
    await report;

    expect(sandbox.agent?.pidsLimit).toBe(64);
  });

  it('gives the agent the checked image, the run network, its mounts and its limits', async () => {
    const report = service.run(request());

    await sandbox.started.promise;
    sandbox.finish(0);
    await report;

    expect(sandbox.agent).toMatchObject({
      runId: 9,
      name: 'foundry-task5-run2-step0-agent',
      image: 'sha256:agent:1',
      network: 'foundry-task5-run2-step0',
      mounts: [{ source: '/srv/cache', target: '/home/agent/.npm', readOnly: false }],
      cpus: 2,
      memoryBytes: 1024,
      pidsLimit: DEFAULT_PIDS_LIMIT,
      labels: { role: 'agent' },
    });
  });

  it.each([
    ['oauth', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['apiKey', 'ANTHROPIC_API_KEY'],
  ] as const)('sets exactly one auth variable for %s, beside the env and run context', async (auth, variable) => {
    const report = service.run(request(agentStep({ auth })));

    await sandbox.started.promise;
    sandbox.finish(0);
    await report;

    const env = sandbox.agent?.env ?? [];
    const authVariables = env.filter(entry => /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/.test(entry));

    expect(authVariables).toEqual([`${variable}=${AGENT_TOKEN}`]);
    expect(env).toEqual(
      expect.arrayContaining([
        'GITLAB_HOST=gitlab.example.com',
        `GITLAB_TOKEN=${GITLAB_TOKEN}`,
        'REPO_URL=https://gitlab.example.com/group/project.git',
        'MODEL=haiku',
        'FOUNDRY_TASK_ID=5',
        'FOUNDRY_RUN_ID=9',
        'FOUNDRY_ISSUE_IID=3',
      ])
    );
  });

  it('sets no issue iid for a scheduled task, which has none', async () => {
    const scheduled = request();
    Object.assign(scheduled.task, { issueIid: null, fireTime: new Date('2026-10-19T09:00:00Z') });

    const report = service.run(scheduled);

    await sandbox.started.promise;
    sandbox.finish(0);
    await report;

    const env = sandbox.agent?.env ?? [];

    expect(env).toContain('REPO_URL=https://gitlab.example.com/group/project.git');
    expect(env.filter(entry => entry.startsWith('FOUNDRY_ISSUE_IID='))).toEqual([]);
  });

  it("adds the git identity variables the environment's env leaves unset", async () => {
    const report = service.run(request());

    await sandbox.started.promise;
    sandbox.finish(0);
    await report;

    expect(gitIdentityService.missingVariables).toHaveBeenCalledWith(
      'node',
      { GITLAB_HOST: 'gitlab.example.com', GITLAB_TOKEN },
      'gitlab.example.com',
      expect.any(AbortSignal)
    );
    expect(sandbox.agent?.env).toEqual(
      expect.arrayContaining(['GIT_AUTHOR_NAME=Swarm Bot', 'GIT_AUTHOR_EMAIL=bot@example.com'])
    );
  });

  it('copies in the rendered prompts, the managed settings with the command limit, and no instructions unnamed', async () => {
    const step = agentStep({ plugins: ['development@acme'] });
    const report = service.run(request(step));

    await sandbox.started.promise;
    sandbox.finish(1);
    await report;

    expect(sandbox.files).toEqual([
      { path: PROMPT_PATH, content: 'Implement #3' },
      {
        path: SYSTEM_PROMPT_PATH,
        content: `${new CommandLimitService().systemPrompt(
          readFileSync(RUNNER_SYSTEM_PROMPT_SOURCE, 'utf8').trim(),
          step.agent.settings?.content,
          step.environment.env
        )}\n\nYou are unattended`,
      },
      {
        path: MANAGED_SETTINGS_PATH,
        content: new CommandLimitService().managedSettings(step.agent.settings?.content, step.environment.env),
      },
      { path: AGENT_ENTRYPOINT_PATH, content: readFileSync(ENTRYPOINT_SOURCE, 'utf8') },
      { path: COMMAND_LIMIT_PATH, content: readFileSync(COMMAND_LIMIT_SOURCE, 'utf8') },
      { path: COMMAND_WATCHDOG_PATH, content: readFileSync(COMMAND_WATCHDOG_SOURCE, 'utf8') },
    ]);
    expect(sandbox.files.find(file => file.path === MANAGED_SETTINGS_PATH)?.content).toContain(
      '"enabledPlugins":{"development@acme":true}'
    );
  });

  it('gives a step without a system prompt the runner prompt alone', async () => {
    stepSystemPrompt = undefined;

    const step = agentStep();
    const report = service.run(request(step));

    await sandbox.started.promise;
    sandbox.finish(1);
    await report;

    expect(sandbox.files.find(file => file.path === SYSTEM_PROMPT_PATH)?.content).toBe(
      new CommandLimitService().systemPrompt(
        readFileSync(RUNNER_SYSTEM_PROMPT_SOURCE, 'utf8').trim(),
        step.agent.settings?.content,
        step.environment.env
      )
    );
  });

  it("fixes the limits from the environment's env in the managed settings", async () => {
    const env = { GITLAB_HOST: 'gitlab.example.com', GITLAB_TOKEN, BASH_DEFAULT_TIMEOUT_MS: '300000' };
    const report = service.run(request(agentStep({ env })));

    await sandbox.started.promise;
    sandbox.finish(0);
    await report;

    expect(sandbox.files.find(file => file.path === MANAGED_SETTINGS_PATH)?.content).toContain(
      `${COMMAND_LIMIT_PATH} 300000 600000 600000 60000 `
    );
  });

  it('ships every file it reads beside itself in the build', () => {
    const { assets } = (
      JSON.parse(readFileSync(join(__dirname, '../../../nest-cli.json'), 'utf8')) as {
        compilerOptions: { assets: string[] };
      }
    ).compilerOptions;

    for (const source of [
      ENTRYPOINT_SOURCE,
      RUNNER_SYSTEM_PROMPT_SOURCE,
      COMMAND_LIMIT_SOURCE,
      COMMAND_WATCHDOG_SOURCE,
    ]) {
      expect(assets).toContain(relative(join(__dirname, '../..'), source));
    }
  });

  it('sets the long-run defaults on the agent', async () => {
    const report = service.run(request());

    await sandbox.started.promise;
    sandbox.finish(0);
    await report;

    expect(sandbox.agent?.env).toEqual(
      expect.arrayContaining([
        'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0',
        'CLAUDE_CODE_RETRY_WATCHDOG=1',
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
        'CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1',
        'DISABLE_AUTOUPDATER=1',
      ])
    );
  });

  it("leaves a command's timeout capped at Claude's own maximum", async () => {
    const report = service.run(request());

    await sandbox.started.promise;
    sandbox.finish(0);
    await report;

    expect(sandbox.agent?.env.filter(entry => entry.startsWith('BASH_MAX_TIMEOUT_MS='))).toEqual([]);
  });

  it("lets the environment's env override a long-run default", async () => {
    const env = { GITLAB_HOST: 'gitlab.example.com', GITLAB_TOKEN, DISABLE_AUTOUPDATER: '0' };
    const report = service.run(request(agentStep({ env })));

    await sandbox.started.promise;
    sandbox.finish(0);
    await report;

    const agentEnv = sandbox.agent?.env ?? [];

    expect(agentEnv.filter(entry => entry.startsWith('DISABLE_AUTOUPDATER='))).toEqual(['DISABLE_AUTOUPDATER=0']);
  });

  it("renders a failure step's prompts with the request's failure", async () => {
    const report = service.run({ ...request(), failure: { report: 'It failed.', reason: '` exit 1 `' } });

    await sandbox.started.promise;
    sandbox.finish(1);
    await report;

    expect(sandbox.files[0]).toEqual({ path: PROMPT_PATH, content: 'Implement #3 ` exit 1 `' });
  });

  it("runs the request's step, not the trigger's first", async () => {
    const first = agentStep();
    const review = agentStep({ auth: 'apiKey' });
    review.environment = { ...review.environment, image: 'review:1' };
    review.prompt = { path: '/config/review.md', content: 'Review' };

    const report = service.run(request(review, [first, review]));

    await sandbox.started.promise;
    sandbox.finish(0);
    await report;

    expect(sandbox.calls.slice(0, 2)).toEqual(['ensureImage review:1', 'checkAgentImage review:1']);
    expect(sandbox.files).toContainEqual({ path: PROMPT_PATH, content: 'Review #3' });
    expect(sandbox.agent?.env).toContainEqual(`ANTHROPIC_API_KEY=${AGENT_TOKEN}`);
  });

  it("copies in the agent's instructions as the managed CLAUDE.md", async () => {
    const report = service.run(request(agentStep({ instructions: '# Standing guidance' })));

    await sandbox.started.promise;
    sandbox.finish(1);
    await report;

    expect(sandbox.files).toContainEqual({ path: MANAGED_INSTRUCTIONS_PATH, content: '# Standing guidance' });
    expect(MANAGED_INSTRUCTIONS_PATH).toBe('/etc/claude-code/CLAUDE.md');
  });

  it('stores every stdout line redacted, tagged with the run', async () => {
    const report = service.run(request());

    await sandbox.started.promise;
    sandbox.stdout({ type: 'assistant', text: `token ${AGENT_TOKEN} and ${GITLAB_TOKEN}` });
    sandbox.stdout({ type: 'result', result: AGENT_TOKEN });
    sandbox.finish(0);

    const { result } = await report;

    expect(stored.map(line => [line.runId, line.lineNumber, line.line])).toEqual([
      [9, 1, `{"type":"assistant","text":"token ${REDACTED} and ${REDACTED}"}`],
      [9, 2, `{"type":"result","result":"${REDACTED}"}`],
    ]);
    expect(result).toBe(`{"type":"result","result":"${REDACTED}"}`);
  });

  it('copies the usage from the result line, leaving a malformed field null', async () => {
    const report = service.run(request());

    await sandbox.started.promise;
    sandbox.stdout({ type: 'system', subtype: 'init', plugins: [] });
    sandbox.sinks?.stdout(
      Buffer.from(
        '{"type":"result","subtype":"success","num_turns":12,"total_cost_usd":1.25,"usage":{"input_tokens":40,' +
          '"output_tokens":3000,"cache_read_input_tokens":900000,"cache_creation_input_tokens":"many"}}\n'
      )
    );
    sandbox.finish(0);

    await expect(report).resolves.toMatchObject({
      error: null,
      usage: {
        turns: 12,
        inputTokens: 40,
        outputTokens: 3000,
        cacheReadTokens: 900_000,
        cacheWriteTokens: null,
        costUsd: 1.25,
      },
    });
  });

  it('fails a clean exit whose transcript failed to store as a runner error', async () => {
    storeError = new Error('connection lost');
    const report = service.run(request());

    await sandbox.started.promise;
    sandbox.stdout({ type: 'system', subtype: 'init', plugins: [] });
    sandbox.finish(0);

    await expect(report).resolves.toMatchObject({
      exitCode: 0,
      error: 'Failed to store the transcript: connection lost',
      endReason: RunEndReason.RUNNER_ERROR,
    });
  });

  it('fails a non-zero exit with the redacted stderr tail', async () => {
    const report = service.run(request());

    await sandbox.started.promise;
    sandbox.sinks?.stderr(Buffer.from(`fatal: could not read from https://oauth2:${GITLAB_TOKEN}@example.com\n`));
    sandbox.finish(128);

    await expect(report).resolves.toEqual({
      exitCode: 128,
      result: null,
      error: `The agent exited with code 128\n\nstderr:\nfatal: could not read from https://oauth2:${REDACTED}@example.com`,
    });
  });

  describe('failures before the agent starts', () => {
    it('refuses an environment without a GitLab host, creating nothing', async () => {
      const report = await service.run(request(agentStep({ env: { GITLAB_TOKEN } })));

      expect(report.error).toContain('Environment node must set GITLAB_HOST');
      expect(report.deploymentFault).toBe(DeploymentFault.PERMANENT);
      expect(sandbox.calls).toEqual(['removeRun 9']);
    });

    it('fails a refused git identity lookup for good as a deployment fault, before creating any container', async () => {
      gitIdentityService.missingVariables.mockRejectedValueOnce(
        new RunConfigError('GitLab at gitlab.example.com answered 401 to GET /api/v4/user for the git identity')
      );

      const report = await service.run(request());

      expect(report).toEqual({
        exitCode: null,
        result: null,
        error: 'GitLab at gitlab.example.com answered 401 to GET /api/v4/user for the git identity',
        deploymentFault: DeploymentFault.PERMANENT,
      });
      expect(sandbox.calls).toEqual(['removeRun 9']);
    });

    it('fails a git identity lookup GitLab did not answer on a transient deployment fault', async () => {
      gitIdentityService.missingVariables.mockRejectedValueOnce(
        new Error('GitLab at gitlab.example.com did not answer GET /api/v4/user for the git identity')
      );

      await expect(service.run(request())).resolves.toMatchObject({ deploymentFault: DeploymentFault.TRANSIENT });
    });

    it('fails clearly on an image without the CLI, and cleans up', async () => {
      sandbox.checkAgentImage.mockRejectedValueOnce(new Error('Image agent:1 does not contain the claude CLI: exec'));

      const report = await service.run(request());

      expect(report).toEqual({
        exitCode: null,
        result: null,
        error: 'Image agent:1 does not contain the claude CLI: exec',
        deploymentFault: DeploymentFault.TRANSIENT,
      });
      expect(sandbox.calls).toEqual(['ensureImage agent:1', 'removeRun 9']);
    });

    it('cleans up after a Docker failure part-way, redacting the message', async () => {
      sandbox.createAgentContainer.mockRejectedValueOnce(new Error(`conflict ${AGENT_TOKEN}`));

      const report = await service.run(request());

      expect(report).toMatchObject({ error: `conflict ${REDACTED}`, deploymentFault: DeploymentFault.TRANSIENT });
      expect(sandbox.calls.at(-1)).toBe('removeRun 9');
    });
  });

  describe('timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    it('sends SIGINT, then SIGTERM after a grace period, then kills, and cleans up', async () => {
      const report = service.run(request());

      await sandbox.started.promise;

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(sandbox.signals).toEqual(['SIGINT']);

      await vi.advanceTimersByTimeAsync(STOP_SEQUENCE[0].graceMs);
      expect(sandbox.signals).toEqual(['SIGINT', 'SIGTERM']);

      await vi.advanceTimersByTimeAsync(STOP_SEQUENCE[1].graceMs);
      expect(sandbox.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);

      await expect(report).resolves.toEqual({
        exitCode: null,
        result: null,
        error: 'Timed out after 1 minute, stopped with SIGKILL',
        endReason: RunEndReason.TIMEOUT,
      });
      expect(sandbox.calls.at(-1)).toBe('removeRun 9');
    });

    it('stops at SIGINT when the agent ends its turn within the grace period', async () => {
      sandbox.exitOn = { signal: 'SIGINT', code: 130 };

      const report = service.run(request());

      await sandbox.started.promise;
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

      await expect(report).resolves.toMatchObject({
        exitCode: null,
        error: 'Timed out after 1 minute, stopped with SIGINT',
      });
      await expect(report).resolves.not.toHaveProperty('deploymentFault');
      expect(sandbox.signals).toEqual(['SIGINT']);
    });
  });

  describe('plugin check', () => {
    it('kills the agent when an enabled plugin is missing from system/init', async () => {
      const report = service.run(request(agentStep({ plugins: ['development@acme'] })));

      await sandbox.started.promise;
      sandbox.stdout({
        type: 'system',
        subtype: 'init',
        plugins: [{ name: 'telemetry', source: 'telemetry@builtin' }],
      });

      await expect(report).resolves.toMatchObject({
        exitCode: null,
        error: "Claude's plugins failed: enabled plugin development@acme did not load",
        endReason: RunEndReason.RUNNER_ERROR,
      });
      await expect(report).resolves.not.toHaveProperty('deploymentFault');
      expect(sandbox.signals).toEqual(['SIGKILL']);
    });

    it('fails on a failed plugin install', async () => {
      const report = service.run(request());

      await sandbox.started.promise;
      sandbox.stdout({
        type: 'system',
        subtype: 'plugin_install',
        status: 'failed',
        name: 'acme',
        error: 'no access',
      });
      sandbox.stdout({ type: 'system', subtype: 'init', plugins: [] });

      await expect(report).resolves.toMatchObject({
        error: "Claude's plugins failed: installing acme failed: no access",
      });
      await expect(report).resolves.not.toHaveProperty('deploymentFault');
    });

    it('fails on a plugin failure read only after the exit', async () => {
      const report = service.run(request());

      await sandbox.started.promise;
      sandbox.exit.resolve(1);
      await new Promise(resolve => setImmediate(resolve));
      sandbox.stdout({
        type: 'system',
        subtype: 'plugin_install',
        status: 'failed',
        name: 'acme',
        error: 'no access',
      });
      sandbox.stdout({ type: 'system', subtype: 'init', plugins: [] });
      sandbox.ended.resolve(undefined);

      await expect(report).resolves.toMatchObject({
        exitCode: 1,
        error: "Claude's plugins failed: installing acme failed: no access",
      });
      await expect(report).resolves.not.toHaveProperty('deploymentFault');
    });

    it('passes when every enabled plugin loaded', async () => {
      const report = service.run(request(agentStep({ plugins: ['development@acme'] })));

      await sandbox.started.promise;
      sandbox.stdout({
        type: 'system',
        subtype: 'init',
        plugins: [{ name: 'development', source: 'development@acme' }],
      });
      sandbox.finish(0);

      await expect(report).resolves.toMatchObject({ exitCode: 0, error: null });
      expect(sandbox.signals).toEqual([]);
    });

    it('fails a clean exit that never reported system/init while plugins are enabled', async () => {
      const report = service.run(request(agentStep({ plugins: ['development@acme'] })));

      await sandbox.started.promise;
      sandbox.finish(0);

      await expect(report).resolves.toMatchObject({
        exitCode: 0,
        error: 'Claude exited without reporting system/init, so its plugins went unchecked',
        endReason: RunEndReason.RUNNER_ERROR,
      });
      await expect(report).resolves.not.toHaveProperty('deploymentFault');
    });
  });

  describe('shutdown', () => {
    it('touches nothing when already aborted', async () => {
      controller.abort();

      await expect(service.run(request())).resolves.toEqual({
        exitCode: null,
        result: null,
        error: SHUTDOWN_ERROR,
        neverStarted: true,
      });
      expect(sandbox.calls).toEqual([]);
    });

    it('removes a sandbox whose agent had not started', async () => {
      sandbox.ensureImage.mockImplementationOnce((image: string) => {
        sandbox.calls.push(`ensureImage ${image}`);
        controller.abort();

        return Promise.resolve({ Id: 'sha256:agent' } as Docker.ImageInspectInfo);
      });

      await expect(service.run(request())).resolves.toMatchObject({ error: SHUTDOWN_ERROR, neverStarted: true });
      expect(sandbox.calls).not.toContain('start');
      expect(sandbox.calls.at(-1)).toBe('removeRun 9');
    });

    it('settles at once and leaves a started sandbox for restart recovery, keeping complete lines', async () => {
      const report = service.run(request());

      await sandbox.started.promise;
      sandbox.sinks?.stdout(Buffer.from('{"line":1}\n{"cut":'));
      controller.abort();

      await expect(report).resolves.toEqual({
        exitCode: null,
        result: null,
        error: SHUTDOWN_ERROR,
        neverStarted: false,
      });
      expect(sandbox.calls).not.toContain('removeRun 9');
      expect(sandbox.signals).toEqual([]);
      expect(stored.map(line => line.line)).toEqual(['{"line":1}']);
    });
  });

  describe('resume', () => {
    const agentContainer = (state: string): ISandboxContainer => ({
      id: 'agent-container',
      name: 'foundry-task5-run2-step0-agent',
      role: 'agent' as SandboxRole,
      taskId: 5,
      runId: 9,
      state,
    });

    it('fails a run whose agent is gone after storing output, and removes what is left of the sandbox', async () => {
      storedLineCount = 3;

      await expect(service.resume(request())).resolves.toEqual({
        exitCode: null,
        result: null,
        error: AGENT_GONE_ERROR,
        deploymentFault: DeploymentFault.TRANSIENT,
        neverStarted: false,
      });
      expect(sandbox.calls).toEqual(['removeRun 9']);
    });

    it('reports a gone agent that stored no line as never started', async () => {
      await expect(service.resume(request())).resolves.toMatchObject({ error: AGENT_GONE_ERROR, neverStarted: true });
    });

    it('reports an agent that was created but never started as never started', async () => {
      sandbox.containers = [agentContainer('created')];

      await expect(service.resume(request())).resolves.toMatchObject({
        error: AGENT_NEVER_STARTED_ERROR,
        neverStarted: true,
      });
      expect(sandbox.calls).toEqual(['removeRun 9']);
    });

    it('reads an exited agent from its logs, storing only the lines past the stored count', async () => {
      sandbox.containers = [agentContainer('exited')];
      storedLineCount = 1;

      const report = service.resume(request());

      await sandbox.started.promise;
      sandbox.stdout({ type: 'system', subtype: 'init', plugins: [] });
      sandbox.sinks?.stdout(Buffer.from('{"type":"result","subtype":"success","is_error":false}\n'));
      sandbox.finish(0);

      await expect(report).resolves.toEqual({
        exitCode: 0,
        result: '{"type":"result","subtype":"success","is_error":false}',
        error: null,
        usage: NO_USAGE,
      });
      expect(stored.map(line => [line.lineNumber, line.line])).toEqual([
        [2, '{"type":"result","subtype":"success","is_error":false}'],
      ]);
      expect(sandbox.calls).toEqual(['followLogs', 'wait', 'removeRun 9']);
    });

    it('gives a live agent only what remains of its timeout since the run started', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      sandbox.containers = [agentContainer('running')];

      const resumed = request();
      resumed.run.startDate = new Date(Date.now() - (TIMEOUT_MS - 5_000));

      const report = service.resume(resumed);

      await sandbox.started.promise;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(sandbox.signals).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(sandbox.signals).toEqual(['SIGINT']);

      await vi.advanceTimersByTimeAsync(STOP_SEQUENCE[0].graceMs + STOP_SEQUENCE[1].graceMs);

      await expect(report).resolves.toMatchObject({
        exitCode: null,
        error: 'Timed out after 1 minute, stopped with SIGKILL',
      });
      expect(sandbox.calls.at(-1)).toBe('removeRun 9');
    });

    it('leaves the sandbox running again on another shutdown', async () => {
      sandbox.containers = [agentContainer('running')];

      const report = service.resume(request());

      await sandbox.started.promise;
      controller.abort();

      await expect(report).resolves.toMatchObject({ error: SHUTDOWN_ERROR });
      expect(sandbox.calls).not.toContain('removeRun 9');
    });
  });

  describe('removeSandboxesExcept', () => {
    it('removes every sandbox but the kept runs', async () => {
      await service.removeSandboxesExcept(new Set([9]));

      expect(sandbox.removeRunsExcept).toHaveBeenCalledWith(new Set([9]));
    });

    it('logs a failure, redacted, without rejecting', async () => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      sandbox.removeRunsExcept.mockRejectedValueOnce(new Error(`daemon refused ${GITLAB_TOKEN}`));

      await expect(service.removeSandboxesExcept(new Set())).resolves.toBeUndefined();
      expect(JSON.stringify(error.mock.calls)).not.toContain(GITLAB_TOKEN);
    });
  });
});
