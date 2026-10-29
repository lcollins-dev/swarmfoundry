import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';

import { ActionRegistryService } from '@/core/actions/action-registry.service';
import { AgentActionService } from '@/core/actions/agent-action.service';
import { IssueActionService } from '@/core/actions/issue-action.service';
import { StepExecutorService } from '@/core/actions/step-executor.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { PromptTemplateService } from '@/core/foundry-config/prompt-template.service';
import { IssueSourceService } from '@/core/issue-source/issue-source.service';
import { TaskService } from '@/core/task/task.service';
import { FailureReportService } from '@/core/trigger-engine/failure-report.service';
import { RunJudgeService } from '@/core/trigger-engine/run-judge.service';
import { TaskCheckService } from '@/core/trigger-engine/task-check.service';
import { TaskQueueService } from '@/core/trigger-engine/task-queue.service';
import { TaskRecoveryService } from '@/core/trigger-engine/task-recovery.service';
import { TriggerEngineService } from '@/core/trigger-engine/trigger-engine.service';
import { TriggerMatchService } from '@/core/trigger-engine/trigger-match.service';
import { TriggerScheduleService } from '@/core/trigger-engine/trigger-schedule.service';

import type { IAgentRunner, IAgentRunRequest } from '@/core/actions/actions.types';
import type {
  ICommentStepConfig,
  IPromptContext,
  IStepConfig,
  ITriggerConfig,
  MergeRequestEventKind,
} from '@/core/foundry-config/foundry-config.types';
import type {
  IIssueEvent,
  IIssueState,
  IMergeRequestEvent,
  ISourceEvent,
  SourceEventHandler,
} from '@/core/issue-source/issue-source.types';
import { DeploymentFault, type IRunReport } from '@/core/task/task.types';

export const TEST_SOURCE = 'gitlab-int';
export const SOURCE_TOKEN = 'glpat-int-orchestrator';
export const TRIGGER_LABEL = 'workflow::in-progress';
export const DONE_LABEL = 'workflow::review';
export const FAILED_LABEL = 'foundry::failed';
export const BOT_USERNAME = 'swarmfoundry-bot';

export const CLEAN_RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"Done"}';
export const CLEAN_EXIT: IRunReport = { exitCode: 0, result: CLEAN_RESULT, error: null };

export const INFRASTRUCTURE_FAILURE: IRunReport = {
  exitCode: null,
  result: null,
  error: 'Docker answered 500',
  deploymentFault: DeploymentFault.TRANSIENT,
};

export interface ITestTriggerOptions {
  concurrency?: number;
  anyLabel?: string[];
  anyAssignee?: string[];

  /** How many agent steps. */
  steps?: number;
}

export const FAILURE_STEPS: IStepConfig[] = [
  { kind: 'comment', body: '{{failure.report}}' },
  { kind: 'relabel', add: [FAILED_LABEL], remove: [] },
];

export const createTestTrigger = (options: ITestTriggerOptions | number = {}): ITriggerConfig => {
  const {
    concurrency = 1,
    anyLabel = [],
    anyAssignee = [],
    steps = 1,
  } = typeof options === 'number' ? { concurrency: options } : options;

  return {
    name: `int-${randomUUID()}`,
    source: { name: TEST_SOURCE, type: 'gitlab', url: 'https://gitlab.test', token: SOURCE_TOKEN },
    steps: Array.from({ length: steps }, () => ({
      kind: 'agent',
      agent: { name: 'claude', model: 'claude-opus-5-5', auth: 'oauth', token: 'sk-ant-integration-agent' },
      timeout: 60_000,
    })),
    concurrency,
    issue: {
      labels: [TRIGGER_LABEL],
      notLabels: [FAILED_LABEL],
      anyAssignee,
      projects: [],
      expect: { anyLabel },
    },
    failureSteps: FAILURE_STEPS,
  } as unknown as ITriggerConfig;
};

/** Fires each 1 January, so its latest fire time stays put while a spec runs. */
export const YEARLY_CRON = '0 0 1 1 *';

export const createScheduledTrigger = (): ITriggerConfig => ({
  ...createTestTrigger(),
  issue: undefined,
  schedule: { cron: YEARLY_CRON, project: 'group/project' },
  mergeRequest: undefined,
  failureSteps: [],
});

export const createMergeRequestTrigger = (event: MergeRequestEventKind = 'merged'): ITriggerConfig => ({
  ...createTestTrigger(),
  issue: undefined,
  schedule: undefined,
  mergeRequest: { event, labels: [], notLabels: [], projects: [] },
  failureSteps: [],
});

export const createMergeRequestEvent = (
  mergeRequestIid: number,
  relatedIssueIid: number | null = mergeRequestIid,
  event: MergeRequestEventKind = 'merged'
): IMergeRequestEvent => ({
  source: TEST_SOURCE,
  project: { id: 7, path: 'group/project', url: 'https://gitlab.test/group/project' },
  event,
  mergeRequest: {
    iid: mergeRequestIid,
    title: `Merge request ${mergeRequestIid}`,
    url: `https://gitlab.test/group/project/-/merge_requests/${mergeRequestIid}`,
    sourceBranch: `${mergeRequestIid}-branch`,
    targetBranch: 'master',
    labels: [],
  },
  relatedIssue:
    relatedIssueIid === null
      ? null
      : {
          iid: relatedIssueIid,
          title: `Issue ${relatedIssueIid}`,
          url: `https://gitlab.test/group/project/-/issues/${relatedIssueIid}`,
        },
});

export const createIssueEvent = (
  issueIid: number,
  labelEventIds: number[] = [issueIid * 10],
  labels: string[] = [TRIGGER_LABEL],
  assignees: string[] = [BOT_USERNAME]
): IIssueEvent => ({
  source: TEST_SOURCE,
  project: { id: 7, path: 'group/project', url: 'https://gitlab.test/group/project' },
  issue: {
    iid: issueIid,
    title: `Issue ${issueIid}`,
    url: `https://gitlab.test/group/project/-/issues/${issueIid}`,
    labels,
    author: 'ada',
    assignees,
    updatedAt: new Date(),
  },
  labelEvents: labelEventIds.map((id, index) => ({
    id,
    label: TRIGGER_LABEL,
    action: 'add',
    createdAt: new Date(Date.UTC(2026, 9, 14, 10, 0, index)),
    actor: 'ada',
  })),
  assignments: [],
});

/** `event` with `BOT_USERNAME` assigned by system note `noteId`, after its label events. */
export const assignBot = (
  event: IIssueEvent,
  noteId: number,
  createdAt = new Date(Date.UTC(2026, 9, 14, 13))
): IIssueEvent => ({
  ...event,
  assignments: [...event.assignments, { id: noteId, usernames: [BOT_USERNAME], createdAt, actor: 'ada' }],
});

/** `event` with `FAILED_LABEL` added and then removed, after its other label events, so the flag no longer blocks it. */
export const clearFlag = (event: IIssueEvent, addId: number, removeId: number): IIssueEvent => ({
  ...event,
  labelEvents: [
    ...event.labelEvents,
    { id: addId, label: FAILED_LABEL, action: 'add', createdAt: new Date(Date.UTC(2026, 9, 14, 11)), actor: 'ada' },
    {
      id: removeId,
      label: FAILED_LABEL,
      action: 'remove',
      createdAt: new Date(Date.UTC(2026, 9, 14, 12)),
      actor: 'ada',
    },
  ],
});

/**
 * GitLab as the engine reads and writes it. An issue it was never told about is open with the trigger label and
 * assigned to the bot.
 */
export class FakeIssueTracker {
  readonly issues = new Map<number, IIssueState | null>();
  readonly labelsAdded: { issueIid: number; label: string; token: string }[] = [];
  readonly labelsRemoved: { issueIid: number; label: string; token: string }[] = [];
  readonly assigned: { issueIid: number; usernames: readonly string[]; token: string }[] = [];
  readonly comments: { issueIid: number; body: string; token: string }[] = [];

  readIssue(issueIid: number): IIssueState | null {
    const issue = this.issues.get(issueIid);

    return issue === undefined ? { open: true, labels: [TRIGGER_LABEL], assignees: [BOT_USERNAME] } : issue;
  }

  setLabels(issueIid: number, labels: string[]): void {
    this.issues.set(issueIid, { open: true, labels, assignees: this.readIssue(issueIid)?.assignees ?? [] });
  }

  setAssignees(issueIid: number, assignees: string[]): void {
    this.issues.set(issueIid, { open: true, labels: this.readIssue(issueIid)?.labels ?? [], assignees });
  }
}

/**
 * The config as the engine reads it. `swap` makes a revision the running one. A restart loads a pinned revision from
 * `clone`, which `swap` adds to, so a test drops a revision from it to make it fail to load.
 */
export class FakeFoundryConfig {
  revisionId: number | null = null;
  readonly clone = new Map<number, ITriggerConfig[]>();

  private readonly loaded = new Map<number, ITriggerConfig[]>();

  constructor(public triggers: ITriggerConfig[]) {}

  swap(configId: number, triggers: ITriggerConfig[]): void {
    this.revisionId = configId;
    this.triggers = triggers;
    this.loaded.set(configId, triggers);
    this.clone.set(configId, triggers);
  }

  triggerAt(configId: number | null, name: string): ITriggerConfig | undefined {
    return (configId === null ? this.triggers : this.loaded.get(configId))?.find(trigger => trigger.name === name);
  }

  loadRevision(configId: number): Promise<boolean> {
    const triggers = this.clone.get(configId);

    if (triggers !== undefined) {
      this.loaded.set(configId, triggers);
    }

    return Promise.resolve(triggers !== undefined);
  }

  retainRevisions(configIds: ReadonlySet<number>): void {
    for (const configId of this.loaded.keys()) {
      if (configId !== this.revisionId && !configIds.has(configId)) {
        this.loaded.delete(configId);
      }
    }
  }

  redact(value: unknown): unknown {
    return value;
  }

  redactText(text: string): string {
    return text.replaceAll(SOURCE_TOKEN, '[redacted]');
  }

  renderComment(step: ICommentStepConfig, context: IPromptContext): string {
    return new PromptTemplateService().renderComment(step.body, context);
  }

  onSwap(): () => void {
    return () => undefined;
  }
}

/** Holds every task's run open until `finish`, or until the engine shuts down. */
export class TestAgentRunner implements IAgentRunner {
  /** Issue iids, or null for a scheduled task. */
  readonly started: (number | null)[] = [];
  readonly startedTasks: number[] = [];
  readonly resumed: number[] = [];
  readonly triggers: ITriggerConfig[] = [];
  readonly requests: IAgentRunRequest[] = [];
  readonly keptRunIds: number[][] = [];

  resumeReport: IRunReport = {
    exitCode: null,
    result: null,
    error: 'The agent container was gone',
    deploymentFault: DeploymentFault.TRANSIENT,
  };

  /** Set by `startTestEngine`, so a started run stores its container as the real runner does. */
  taskService: TaskService | null = null;

  private readonly pending = new Map<number, (report: IRunReport) => void>();
  private readonly pendingTasks = new Map<number, (report: IRunReport) => void>();

  run(request: IAgentRunRequest): Promise<IRunReport> {
    const { trigger, task, run, signal } = request;

    this.started.push(task.issueIid);
    this.startedTasks.push(task.id);
    this.triggers.push(trigger);
    this.requests.push(request);

    run.containerId = `test-agent-${run.id}`;
    const stored = this.taskService?.setContainerId(run, run.containerId) ?? Promise.resolve();

    const report = new Promise<IRunReport>(resolve => {
      const shutDown = () => resolve({ exitCode: null, result: null, error: 'Shut down' });

      if (signal.aborted) {
        shutDown();
      }

      if (task.issueIid !== null) {
        this.pending.set(task.issueIid, resolve);
      }

      this.pendingTasks.set(task.id, resolve);
      signal.addEventListener('abort', shutDown);
    });

    // The run ends only once its container is stored, so a restart reads it back.
    return Promise.all([report, stored]).then(([ended]) => ended);
  }

  resume(request: IAgentRunRequest): Promise<IRunReport> {
    const { trigger, run } = request;

    this.resumed.push(run.id);
    this.triggers.push(trigger);
    this.requests.push(request);

    return Promise.resolve(this.resumeReport);
  }

  removeSandboxesExcept(runIds: ReadonlySet<number>): Promise<void> {
    this.keptRunIds.push([...runIds]);

    return Promise.resolve();
  }

  finish(issueIid: number, report: IRunReport = CLEAN_EXIT): void {
    this.pending.get(issueIid)?.(report);
  }

  finishTask(taskId: number, report: IRunReport = CLEAN_EXIT): void {
    this.pendingTasks.get(taskId)?.(report);
  }
}

export interface ITestEngine {
  runner: TestAgentRunner;
  tracker: FakeIssueTracker;
  queue: TaskQueueService;

  /** Hands the event over as a poll would, then waits for the queue to settle. */
  emit: (event: ISourceEvent) => Promise<void>;

  /** Runs a schedule tick, then waits for the queue to settle. */
  tick: () => Promise<void>;

  stop: () => Promise<void>;
}

/**
 * One orchestrator process with GitLab and Docker faked at the service boundary: starting a second against the same
 * database simulates a restart. Recovery and the sweep of stranded failure steps see only the tasks of `triggers`, since
 * other specs share the database.
 */
export const startTestEngine = async (
  app: NestExpressApplication,
  triggers: ITriggerConfig[],
  tracker = new FakeIssueTracker(),
  runner = new TestAgentRunner(),
  config = new FakeFoundryConfig(triggers)
): Promise<ITestEngine> => {
  const foundryConfigService = config as unknown as FoundryConfigService;

  let handler: SourceEventHandler | null = null;

  const issueSourceService = {
    start: (eventHandler: SourceEventHandler) => {
      handler = eventHandler;

      return () => Promise.resolve();
    },
    readIssue: (_source: unknown, _projectId: number, issueIid: number) => Promise.resolve(tracker.readIssue(issueIid)),
    relabel: (
      source: { token: string },
      _projectId: number,
      issueIid: number,
      add: readonly string[],
      remove: readonly string[]
    ) => {
      tracker.labelsAdded.push(...add.map(label => ({ issueIid, label, token: source.token })));
      tracker.labelsRemoved.push(...remove.map(label => ({ issueIid, label, token: source.token })));

      return Promise.resolve();
    },
    assign: (source: { token: string }, _projectId: number, issueIid: number, usernames: readonly string[]) => {
      tracker.assigned.push({ issueIid, usernames, token: source.token });

      return Promise.resolve();
    },
    comment: (source: { token: string }, _projectId: number, issueIid: number, body: string) => {
      tracker.comments.push({ issueIid, body, token: source.token });

      return Promise.resolve();
    },
  } as unknown as IssueSourceService;

  const appTaskService = app.get(TaskService);
  const triggerNames = new Set(triggers.map(trigger => trigger.name));

  const taskService = Object.create(appTaskService, {
    findRunning: {
      value: async () => (await appTaskService.findRunning()).filter(({ task }) => triggerNames.has(task.triggerName)),
    },

    findQueuedOutside: {
      value: async (...args: Parameters<TaskService['findQueuedOutside']>) =>
        (await appTaskService.findQueuedOutside(...args)).filter(task => triggerNames.has(task.triggerName)),
    },
  }) as TaskService;

  runner.taskService = appTaskService;

  const triggerMatchService = new TriggerMatchService();

  const stepExecutor = new StepExecutorService(
    new ActionRegistryService(
      new AgentActionService(foundryConfigService, appTaskService, runner),
      new IssueActionService(foundryConfigService, issueSourceService, appTaskService)
    )
  );

  const queue = new TaskQueueService(
    foundryConfigService,
    taskService,
    new TaskCheckService(foundryConfigService, issueSourceService, triggerMatchService, taskService),
    new RunJudgeService(foundryConfigService, issueSourceService),
    new FailureReportService(foundryConfigService, taskService, stepExecutor),
    stepExecutor
  );

  const schedule = new TriggerScheduleService(foundryConfigService, taskService, queue);

  const engine = new TriggerEngineService(
    foundryConfigService,
    issueSourceService,
    triggerMatchService,
    taskService,
    queue,
    new TaskRecoveryService(foundryConfigService, taskService, queue, stepExecutor),
    schedule
  );

  await engine.onApplicationBootstrap();

  return {
    runner,
    tracker,
    queue,
    emit: async event => {
      await handler?.(event);
      await queue.requestDispatch();
    },
    tick: async () => {
      await schedule.requestTick();
      await queue.requestDispatch();
    },
    stop: () => engine.beforeApplicationShutdown(),
  };
};
