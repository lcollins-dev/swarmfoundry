import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Run } from '@/core/task/entities/run.entity';
import { Task } from '@/core/task/entities/task.entity';

import type { FailureReportService } from './failure-report.service';
import type { RunJudgeService } from './run-judge.service';
import type { TaskCheckService } from './task-check.service';
import { CHECK_RETRY_MS, DISPATCH_RETRY_MS, STEP_TRY_DELAYS_MS, TaskQueueService } from './task-queue.service';
import { ActionRegistryService } from '@/core/actions/action-registry.service';
import { AgentActionService } from '@/core/actions/agent-action.service';
import type { IssueActionService } from '@/core/actions/issue-action.service';
import { StepExecutorService } from '@/core/actions/step-executor.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import type { TaskService } from '@/core/task/task.service';
import type { IListSteps } from '@/core/task/task.service';

import type { TaskCheck } from './trigger-engine.types';
import type {
  IActionAgent,
  IActionHandler,
  IAgentRunner,
  IAgentRunRequest,
  IStepRequest,
} from '@/core/actions/actions.types';
import type { IStaticStepConfig, IStepConfig, ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import { DeploymentFault, RunEndReason, RunOutcome, StepList, TaskStatus } from '@/core/task/task.types';
import type { IRunAgent, IRunJudgement, IRunReport, TaskNext } from '@/core/task/task.types';

const SECRET = 'glpat-secret';
const CLEAN_RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"Done"}';
const SUCCESS: IRunReport = { exitCode: 0, result: CLEAN_RESULT, error: null };

const [FIRST_RETRY_MS] = STEP_TRY_DELAYS_MS;

const INFRASTRUCTURE_FAILURE: IRunReport = {
  exitCode: null,
  result: null,
  error: 'Docker answered 500',
  deploymentFault: DeploymentFault.TRANSIENT,
};

const CRASH: IRunReport = { exitCode: 1, result: null, error: 'exit 1' };

type ITestAgent = Pick<IActionAgent, 'name' | 'concurrency'>;

const stepsTrigger = (name: string, agents: ITestAgent[], concurrency = 1, failureSteps: IStepConfig[] = []) =>
  ({
    name,
    concurrency,
    steps: agents.map(agent => ({ kind: 'agent', agent })),
    failureSteps,
  }) as unknown as ITriggerConfig;

const CLAUDE: ITestAgent = { name: 'claude' };

const trigger = (name: string, concurrency: number, agent: ITestAgent = CLAUDE) =>
  stepsTrigger(name, [agent], concurrency);

const PASSED: IRunJudgement = { outcome: RunOutcome.SUCCEEDED, error: null, deploymentFault: null };
const MISSED_EXPECT: IRunJudgement = {
  outcome: RunOutcome.FAILED,
  error: 'The issue lacks workflow::review',
  deploymentFault: null,
};

/** Keeps tasks in memory with the same semantics as TaskService's queries. */
class FakeTaskService {
  readonly tasks: Task[] = [];
  readonly runs: Run[] = [];

  add(triggerName: string, issueIid: number, notBeforeDate: Date | null = null): Task {
    const task = new Task({
      triggerName,
      sourceName: 'gitlab',
      projectId: 7,
      projectPath: 'group/project',
      projectUrl: 'https://gitlab.test/group/project',
      issueIid,
      issueTitle: `Issue ${issueIid}`,
      issueUrl: `https://gitlab.test/group/project/-/issues/${issueIid}`,
      matchedIssue: null,
      change: { kind: 'label', id: issueIid * 10, createdAt: new Date('2026-10-14T10:00:00Z'), actor: null },
      fireTime: null,
      cron: null,
      mergeRequest: null,
      queuedDate: new Date(Date.UTC(2026, 9, 14, 10, 0, issueIid)),
    });

    task.id = this.tasks.length + 1;
    task.notBeforeDate = notBeforeDate;
    this.tasks.push(task);

    return task;
  }

  statusOf(issueIid: number): TaskStatus | undefined {
    return this.tasks.find(task => task.issueIid === issueIid)?.status;
  }

  countRunning(triggerName: string, at?: IListSteps): Promise<number> {
    return Promise.resolve(
      this.tasks.filter(
        task =>
          task.triggerName === triggerName &&
          (at === undefined || this.isAt(task, at)) &&
          task.status === TaskStatus.RUNNING
      ).length
    );
  }

  findStartable(triggerName: string, at: IListSteps, now: Date, limit: number): Promise<Task[]> {
    return Promise.resolve(
      this.tasks
        .filter(task => task.triggerName === triggerName && this.isAt(task, at) && task.status === TaskStatus.QUEUED)
        .filter(task => task.notBeforeDate === null || task.notBeforeDate <= now)
        .sort((left, right) => left.queuedDate.getTime() - right.queuedDate.getTime() || left.id - right.id)
        .slice(0, limit)
    );
  }

  findNextNotBefore(triggerNames: string[], now: Date): Promise<Date | null> {
    const dates = this.tasks
      .filter(task => triggerNames.includes(task.triggerName) && task.status === TaskStatus.QUEUED)
      .flatMap(task => (task.notBeforeDate !== null && task.notBeforeDate > now ? [task.notBeforeDate] : []))
      .sort((left, right) => left.getTime() - right.getTime());

    return Promise.resolve(dates[0] ?? null);
  }

  startRun(task: Task, configId: number | null, agent: IRunAgent | null): Promise<Run | null> {
    if (task.status !== TaskStatus.QUEUED) {
      return Promise.resolve(null);
    }

    task.status = TaskStatus.RUNNING;
    task.configId ??= configId;

    const { list, step } = task;
    const number =
      this.runs.filter(existing => existing.taskId === task.id && existing.list === list && existing.step === step)
        .length + 1;

    const run = new Run({ taskId: task.id, number, list, step, startDate: new Date(), configId: task.configId, agent });

    run.id = this.runs.length + 1;
    this.runs.push(run);

    return Promise.resolve(run);
  }

  recordReport(run: Run, report: IRunReport): Promise<void> {
    Object.assign(run, { ...report, endDate: new Date() });

    return Promise.resolve();
  }

  finishRun(task: Task, run: Run, judgement: IRunJudgement, next: TaskNext): Promise<void> {
    Object.assign(run, judgement);
    task.status = next.status;

    if (next.status === TaskStatus.QUEUED) {
      task.list = next.list;
      task.step = next.step;
      task.notBeforeDate = next.notBeforeDate;
    }

    return Promise.resolve();
  }

  endFailed(task: Task): Promise<boolean> {
    if (task.status !== TaskStatus.QUEUED) {
      return Promise.resolve(false);
    }

    task.status = TaskStatus.FAILED;

    return Promise.resolve(true);
  }

  cancel(task: Task, reason: string): Promise<boolean> {
    task.status = TaskStatus.CANCELLED;
    task.cancelReason = reason;

    return Promise.resolve(true);
  }

  delay(task: Task, notBeforeDate: Date): Promise<void> {
    task.notBeforeDate = notBeforeDate;

    return Promise.resolve();
  }

  releaseRun(task: Task, run: Run): Promise<void> {
    this.runs.splice(this.runs.indexOf(run), 1);
    task.status = TaskStatus.QUEUED;

    if (!this.runs.some(existing => existing.taskId === task.id)) {
      task.configId = null;
    }

    return Promise.resolve();
  }

  findPinnedConfigIds(): Promise<Set<number>> {
    return Promise.resolve(
      new Set(
        this.tasks
          .filter(task => task.status === TaskStatus.QUEUED || task.status === TaskStatus.RUNNING)
          .flatMap(task => (task.configId === null ? [] : [task.configId]))
      )
    );
  }

  findQueuedFrom(triggerName: string, list: StepList, step: number): Promise<Task[]> {
    return Promise.resolve(
      this.tasks.filter(
        task =>
          task.triggerName === triggerName &&
          task.list === list &&
          task.step >= step &&
          task.status === TaskStatus.QUEUED
      )
    );
  }

  findQueuedOutside(triggerNames: readonly string[], list: StepList): Promise<Task[]> {
    return Promise.resolve(
      this.tasks.filter(
        task => !triggerNames.includes(task.triggerName) && task.list === list && task.status === TaskStatus.QUEUED
      )
    );
  }

  private isAt(task: Task, at: IListSteps): boolean {
    return task.list === at.list && at.steps.includes(task.step);
  }
}

/** Settles each static step at once with `report`, which a test may change. */
class FakeStaticHandler implements IActionHandler<IStaticStepConfig> {
  readonly requests: IStepRequest<IStaticStepConfig>[] = [];

  report: IRunReport = { exitCode: null, result: 'Done', error: null };

  isReady = () => true;
  agentOf = () => null;
  secretsOf = () => [];
  failureMessage = () => Promise.resolve(null);
  removeLeftoversExcept = () => Promise.resolve();

  run(request: IStepRequest<IStaticStepConfig>): Promise<IRunReport> {
    this.requests.push(request);

    return Promise.resolve(this.report);
  }

  resume(request: IStepRequest<IStaticStepConfig>): Promise<IRunReport> {
    return this.run(request);
  }

  judge(_step: IStaticStepConfig, report: IRunReport): IRunJudgement {
    return report.error === null
      ? PASSED
      : {
          outcome: RunOutcome.FAILED,
          error: report.error,
          deploymentFault: report.deploymentFault ?? null,
        };
  }
}

/** Holds each run open until the test settles it, or the queue stops. */
class FakeAgentRunner implements IAgentRunner {
  readonly started: (number | null)[] = [];
  readonly requests: IAgentRunRequest[] = [];

  private readonly pending = new Map<
    number | null,
    { resolve: (report: IRunReport) => void; reject: (error: unknown) => void }
  >();

  run(request: IAgentRunRequest): Promise<IRunReport> {
    this.started.push(request.task.issueIid);
    this.requests.push(request);

    return new Promise((resolve, reject) => {
      this.pending.set(request.task.issueIid, { resolve, reject });
      request.signal.addEventListener('abort', () => resolve({ exitCode: null, result: null, error: 'Shut down' }));
    });
  }

  readonly resumed: number[] = [];

  resume(request: IAgentRunRequest): Promise<IRunReport> {
    this.resumed.push(request.run.id);

    return this.run(request);
  }

  removeSandboxesExcept(): Promise<void> {
    return Promise.resolve();
  }

  finish(issueIid: number, report: IRunReport = SUCCESS): void {
    this.pending.get(issueIid)?.resolve(report);
  }

  fail(issueIid: number, error: unknown): void {
    this.pending.get(issueIid)?.reject(error);
  }
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('TaskQueueService', () => {
  let taskService: FakeTaskService;
  let runner: FakeAgentRunner;
  let triggers: ITriggerConfig[];
  let revisionId: number | null;
  let revisions: Map<number, ITriggerConfig[]>;
  let retainRevisions: ReturnType<typeof vi.fn<(configIds: ReadonlySet<number>) => void>>;
  let foundryConfigService: FoundryConfigService;

  const swap = (configId: number, next: ITriggerConfig[]): void => {
    revisionId = configId;
    triggers = next;
    revisions.set(configId, next);
  };
  let check: ReturnType<typeof vi.fn<(trigger: ITriggerConfig, task: Task) => Promise<TaskCheck>>>;
  let judgeExpect: ReturnType<typeof vi.fn<RunJudgeService['judgeExpect']>>;
  let logFailure: ReturnType<typeof vi.fn<FailureReportService['logFailure']>>;
  let failureContext: ReturnType<typeof vi.fn<FailureReportService['context']>>;
  let staticHandler: FakeStaticHandler;
  let service: TaskQueueService;

  const createService = (agentRunner?: IAgentRunner) =>
    new TaskQueueService(
      foundryConfigService,
      taskService as unknown as TaskService,
      { check } as unknown as TaskCheckService,
      { judgeExpect } as unknown as RunJudgeService,
      { logFailure, context: failureContext } as unknown as FailureReportService,
      new StepExecutorService(
        new ActionRegistryService(
          new AgentActionService(foundryConfigService, taskService as unknown as TaskService, agentRunner),
          staticHandler as unknown as IssueActionService
        )
      )
    );

  beforeEach(() => {
    taskService = new FakeTaskService();
    runner = new FakeAgentRunner();
    triggers = [trigger('implement', 2)];

    revisionId = null;
    revisions = new Map();
    retainRevisions = vi.fn();

    foundryConfigService = {
      get triggers() {
        return triggers;
      },
      get revisionId() {
        return revisionId;
      },
      triggerAt: (configId: number | null, name: string) =>
        (configId === null ? triggers : revisions.get(configId))?.find(existing => existing.name === name),
      retainRevisions,
      redact: (value: unknown) => (typeof value === 'string' ? value.replaceAll(SECRET, '[redacted]') : value),
    } as unknown as FoundryConfigService;

    check = vi.fn().mockResolvedValue({ kind: 'start' });
    judgeExpect = vi.fn<RunJudgeService['judgeExpect']>().mockResolvedValue(PASSED);
    logFailure = vi.fn<FailureReportService['logFailure']>();
    failureContext = vi
      .fn<FailureReportService['context']>()
      .mockResolvedValue({ report: 'The report', reason: '` exit 1 `' });
    staticHandler = new FakeStaticHandler();

    service = createService(runner);

    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('concurrency', () => {
    it('starts no more tasks than the trigger allows', async () => {
      for (const issueIid of [1, 2, 3]) {
        taskService.add('implement', issueIid);
      }

      await service.requestDispatch();

      expect(runner.started).toEqual([1, 2]);
      expect(taskService.statusOf(3)).toBe(TaskStatus.QUEUED);
    });

    it('starts queued tasks in arrival order as slots free', async () => {
      for (const issueIid of [3, 1, 4, 2]) {
        taskService.add('implement', issueIid);
      }

      await service.requestDispatch();
      expect(runner.started).toEqual([1, 2]);

      runner.finish(2);
      await settle();
      expect(runner.started).toEqual([1, 2, 3]);

      runner.finish(1);
      await settle();
      expect(runner.started).toEqual([1, 2, 3, 4]);
    });

    it('counts tasks already running, such as those a restart left', async () => {
      taskService.add('implement', 1).status = TaskStatus.RUNNING;
      taskService.add('implement', 2);
      taskService.add('implement', 3);

      await service.requestDispatch();

      expect(runner.started).toEqual([2]);
    });

    it('keeps each trigger to its own concurrency', async () => {
      triggers = [trigger('implement', 1), trigger('review', 1)];
      taskService.add('implement', 1);
      taskService.add('implement', 2);
      taskService.add('review', 3);

      await service.requestDispatch();

      expect(runner.started).toEqual([1, 3]);
    });

    describe('per agent', () => {
      const capped: ITestAgent = { name: 'subscription', concurrency: 2 };

      it("starts no more tasks across the agent's triggers than the agent allows", async () => {
        triggers = [trigger('implement', 2, capped), trigger('review', 2, capped)];

        for (const issueIid of [1, 2, 3, 4]) {
          taskService.add(issueIid % 2 === 0 ? 'review' : 'implement', issueIid);
        }

        await service.requestDispatch();

        expect(runner.started).toEqual([1, 2]);
        expect(taskService.statusOf(3)).toBe(TaskStatus.QUEUED);
        expect(taskService.statusOf(4)).toBe(TaskStatus.QUEUED);
      });

      it('starts the oldest queued task across the triggers when a slot frees, so a busy trigger starves none', async () => {
        triggers = [trigger('implement', 5, capped), trigger('review', 5, capped)];

        for (const issueIid of [1, 2, 3, 5]) {
          taskService.add('implement', issueIid);
        }

        taskService.add('review', 4);

        await service.requestDispatch();
        expect(runner.started).toEqual([1, 2]);

        runner.finish(1);
        await settle();
        expect(runner.started).toEqual([1, 2, 3]);

        runner.finish(2);
        await settle();
        expect(runner.started).toEqual([1, 2, 3, 4]);
      });

      it("still keeps each trigger to its own concurrency under the agent's", async () => {
        triggers = [trigger('implement', 1, capped), trigger('review', 2, capped)];
        taskService.add('implement', 1);
        taskService.add('implement', 2);
        taskService.add('review', 3);

        await service.requestDispatch();

        expect(runner.started).toEqual([1, 3]);
      });

      it('counts tasks already running on any of its triggers, such as those a restart left', async () => {
        triggers = [trigger('implement', 2, capped), trigger('review', 2, capped)];
        taskService.add('implement', 1).status = TaskStatus.RUNNING;
        taskService.add('review', 2).status = TaskStatus.RUNNING;
        taskService.add('implement', 3);

        await service.requestDispatch();

        expect(runner.started).toEqual([]);
        expect(taskService.statusOf(3)).toBe(TaskStatus.QUEUED);
      });

      it("leaves another agent's triggers out of the cap", async () => {
        triggers = [
          trigger('implement', 2, { name: 'subscription', concurrency: 1 }),
          trigger('review', 2, { name: 'api' }),
        ];
        taskService.add('implement', 1);
        taskService.add('implement', 2);
        taskService.add('review', 3);
        taskService.add('review', 4);

        await service.requestDispatch();

        expect(runner.started).toEqual([1, 3, 4]);
      });

      it('gives the slot of a task cancelled before it starts to the next oldest', async () => {
        const single: ITestAgent = { name: 'subscription', concurrency: 1 };
        triggers = [trigger('implement', 2, single), trigger('review', 2, single)];
        taskService.add('implement', 1);
        taskService.add('review', 2);
        check.mockResolvedValueOnce({ kind: 'cancel', reason: 'The issue is closed' });

        await service.requestDispatch();

        expect(taskService.statusOf(1)).toBe(TaskStatus.CANCELLED);
        expect(runner.started).toEqual([2]);
      });
    });

    it('leaves alone the tasks of a trigger no longer in the config', async () => {
      taskService.add('removed', 1);

      await service.requestDispatch();

      expect(runner.started).toEqual([]);
      expect(taskService.statusOf(1)).toBe(TaskStatus.QUEUED);
    });

    it('starts each task once when dispatch is requested again mid-pass', async () => {
      taskService.add('implement', 1);

      await Promise.all([service.requestDispatch(), service.requestDispatch(), service.requestDispatch()]);

      expect(runner.started).toEqual([1]);
    });

    it('picks up a task queued while a pass is going', async () => {
      taskService.add('implement', 1);

      const pass = service.requestDispatch();
      taskService.add('implement', 2);
      await service.requestDispatch();
      await pass;

      expect(runner.started).toEqual([1, 2]);
    });
  });

  describe('finishing', () => {
    it('ends a task whose run the judge passed as succeeded, reporting nothing', async () => {
      taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1);
      await settle();

      expect(judgeExpect).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'implement' }),
        expect.objectContaining({ issueIid: 1 }),
        expect.any(AbortSignal)
      );
      expect(taskService.statusOf(1)).toBe(TaskStatus.SUCCEEDED);
      expect(taskService.runs[0]).toMatchObject({ number: 1, exitCode: 0, outcome: RunOutcome.SUCCEEDED });
      expect(logFailure).not.toHaveBeenCalled();
    });

    it("fails a task whose run the judge failed, storing the judge's reason", async () => {
      taskService.add('implement', 1);
      await service.requestDispatch();
      judgeExpect.mockResolvedValueOnce(MISSED_EXPECT);

      runner.finish(1);
      await settle();

      expect(taskService.statusOf(1)).toBe(TaskStatus.FAILED);
      expect(taskService.runs[0]).toMatchObject({
        exitCode: 0,
        outcome: RunOutcome.FAILED,
        error: 'The issue lacks workflow::review',
      });
    });

    it('records a runner rejection as a transient deployment fault, with secrets redacted, and retries its step', async () => {
      taskService.add('implement', 1);
      await service.requestDispatch();

      runner.fail(1, new Error(`docker refused ${SECRET}`));
      await settle();

      expect(taskService.statusOf(1)).toBe(TaskStatus.QUEUED);
      expect(taskService.runs[0]).toMatchObject({
        exitCode: null,
        outcome: RunOutcome.FAILED,
        error: 'docker refused [redacted]',
        deploymentFault: DeploymentFault.TRANSIENT,
      });
    });

    it('starts the next queued task once a slot frees', async () => {
      triggers = [trigger('implement', 1)];
      taskService.add('implement', 1);
      taskService.add('implement', 2);
      await service.requestDispatch();

      runner.finish(1);
      await settle();

      expect(runner.started).toEqual([1, 2]);
    });

    it('hands the runner the trigger, its step, the task and its run', async () => {
      taskService.add('implement', 1);
      await service.requestDispatch();

      expect(runner.requests[0]).toMatchObject({
        trigger: { name: 'implement' },
        task: { issueIid: 1 },
        run: { number: 1, step: 0 },
      });
      expect(runner.requests[0].step).toBe(triggers[0].steps[0]);
    });

    it('fails a run whose agent exited cleanly without a result, judging nothing more', async () => {
      taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1, { exitCode: 0, result: null, error: null });
      await settle();

      expect(taskService.runs[0]).toMatchObject({
        outcome: RunOutcome.FAILED,
        error: 'Claude exited without a result',
      });
      expect(judgeExpect).not.toHaveBeenCalled();
    });
  });

  describe('retries', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
      triggers = [trigger('implement', 1)];
    });

    it('gives a step that failed on a transient deployment fault 3 tries, 5m then 15m apart, then fails the task and reports once', async () => {
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      for (const [index, delayMs] of STEP_TRY_DELAYS_MS.entries()) {
        const failedAt = Date.now();

        runner.finish(1, { ...INFRASTRUCTURE_FAILURE, error: `try ${index + 1}` });
        await vi.advanceTimersByTimeAsync(0);

        expect(task).toMatchObject({ status: TaskStatus.QUEUED, step: 0, notBeforeDate: new Date(failedAt + delayMs) });
        expect(logFailure).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(delayMs);
      }

      runner.finish(1, { ...INFRASTRUCTURE_FAILURE, error: 'try 3' });
      await vi.advanceTimersByTimeAsync(0);

      expect(STEP_TRY_DELAYS_MS).toEqual([300_000, 900_000]);
      expect(taskService.runs.map(run => run.number)).toEqual([1, 2, 3]);
      expect(taskService.runs.at(-1)).toMatchObject({
        outcome: RunOutcome.FAILED,
        deploymentFault: DeploymentFault.TRANSIENT,
      });
      expect(task.status).toBe(TaskStatus.FAILED);
      expect(logFailure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: 'implement' }),
        expect.objectContaining({ issueIid: 1 }),
        expect.objectContaining({ number: 3 }),
        { outcome: RunOutcome.FAILED, error: 'try 3', deploymentFault: DeploymentFault.TRANSIENT }
      );
    });

    it.each([
      ['crashed', CRASH],
      ['timed out', { exitCode: null, result: null, error: 'Timed out after 1 hour, stopped with SIGINT' }],
      ['ended without a result', { exitCode: 0, result: null, error: null }],
    ])('fails the task at once, with no retry, when its agent %s', async (_case, failure: IRunReport) => {
      taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1, failure);
      await vi.advanceTimersByTimeAsync(STEP_TRY_DELAYS_MS[0]);

      expect(taskService.statusOf(1)).toBe(TaskStatus.FAILED);
      expect(runner.started).toEqual([1]);
      expect(logFailure).toHaveBeenCalledOnce();
    });

    it('fails the task at once, with no retry, when the issue misses expect', async () => {
      taskService.add('implement', 1);
      judgeExpect.mockResolvedValueOnce(MISSED_EXPECT);
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(STEP_TRY_DELAYS_MS[0]);

      expect(taskService.statusOf(1)).toBe(TaskStatus.FAILED);
      expect(runner.started).toEqual([1]);
      expect(logFailure).toHaveBeenCalledOnce();
    });

    it('retries a run whose report was stored as a transient deployment fault before a restart', async () => {
      const task = taskService.add('implement', 1);
      task.status = TaskStatus.RUNNING;

      const run = new Run({
        taskId: task.id,
        number: 1,
        list: StepList.STEPS,
        step: 0,
        startDate: new Date(),
        configId: null,
        agent: null,
      });
      Object.assign(run, {
        endDate: new Date(),
        error: 'Docker answered 500',
        deploymentFault: DeploymentFault.TRANSIENT,
      });
      taskService.runs.push(run);

      service.resumeRun(task, run);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.resumed).toEqual([]);
      expect(task).toMatchObject({ status: TaskStatus.QUEUED, step: 0 });
      expect(run).toMatchObject({ outcome: RunOutcome.FAILED, deploymentFault: DeploymentFault.TRANSIENT });
    });
  });

  describe('pre-start check', () => {
    it('cancels a task whose issue no longer matches, and starts the next in its slot', async () => {
      triggers = [trigger('implement', 1)];
      taskService.add('implement', 1);
      taskService.add('implement', 2);
      check.mockResolvedValueOnce({ kind: 'cancel', reason: 'The issue lacks workflow::in-progress' });

      await service.requestDispatch();

      expect(taskService.tasks[0]).toMatchObject({
        status: TaskStatus.CANCELLED,
        cancelReason: 'The issue lacks workflow::in-progress',
      });
      expect(taskService.runs).toHaveLength(1);
      expect(runner.started).toEqual([2]);
    });

    it('holds a task back when its issue could not be read', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
      const task = taskService.add('implement', 1);
      check.mockResolvedValueOnce({ kind: 'defer', error: 'GitLab answered 502' });

      await service.requestDispatch();

      expect(task).toMatchObject({ status: TaskStatus.QUEUED, notBeforeDate: new Date(Date.now() + CHECK_RETRY_MS) });
      expect(runner.started).toEqual([]);

      await vi.advanceTimersByTimeAsync(CHECK_RETRY_MS);

      expect(runner.started).toEqual([1]);
    });

    it('checks the issue before every run, retries included', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      triggers = [trigger('implement', 1)];
      taskService.add('implement', 1);
      await service.requestDispatch();

      check.mockResolvedValueOnce({ kind: 'cancel', reason: 'The issue is closed' });
      runner.finish(1, INFRASTRUCTURE_FAILURE);
      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);

      expect(check).toHaveBeenCalledTimes(2);
      expect(taskService.statusOf(1)).toBe(TaskStatus.CANCELLED);
      expect(runner.started).toEqual([1]);
      expect(logFailure).not.toHaveBeenCalled();
    });
  });

  describe('resumeRun', () => {
    const runningTask = (issueIid: number): { task: Task; run: Run } => {
      const task = taskService.add('implement', issueIid);
      task.status = TaskStatus.RUNNING;

      const run = new Run({
        taskId: task.id,
        number: 1,
        list: StepList.STEPS,
        step: 0,
        startDate: new Date(),
        configId: null,
        agent: null,
      });
      run.id = 100 + issueIid;
      taskService.runs.push(run);

      return { task, run };
    };

    it('follows an unfinished run through the runner, then judges it', async () => {
      const { task, run } = runningTask(1);

      service.resumeRun(task, run);
      await settle();

      expect(runner.resumed).toEqual([101]);

      runner.finish(1);
      await settle();

      expect(task.status).toBe(TaskStatus.SUCCEEDED);
    });

    it('resumes a failure step at its own list and step, with the failure', async () => {
      const report: IStepConfig = { kind: 'comment', body: '{{failure.report}}' };
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [report])];
      const { task, run } = runningTask(1);
      Object.assign(task, { list: StepList.FAILURE_STEPS });
      Object.assign(run, { list: StepList.FAILURE_STEPS });

      service.resumeRun(task, run);
      await settle();

      expect(runner.resumed).toEqual([]);
      expect(staticHandler.requests).toEqual([
        expect.objectContaining({ step: report, failure: { report: 'The report', reason: '` exit 1 `' } }),
      ]);
      expect(task.status).toBe(TaskStatus.FAILED);
    });

    it('still follows a resumed agent failure step whose failure cannot be read', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [{ kind: 'agent', agent: CLAUDE } as unknown as IStepConfig])];
      const { task, run } = runningTask(1);
      Object.assign(task, { list: StepList.FAILURE_STEPS });
      Object.assign(run, { list: StepList.FAILURE_STEPS });
      failureContext.mockRejectedValueOnce(new Error('connection lost'));

      service.resumeRun(task, run);
      await settle();

      expect(runner.resumed).toEqual([101]);
      expect(runner.requests[0].failure).toBeUndefined();
    });

    it('judges a run whose report was stored without asking the runner, keeping its end date', async () => {
      const { task, run } = runningTask(1);
      const endDate = new Date('2026-10-14T09:00:00Z');
      Object.assign(run, { endDate, exitCode: 0, result: CLEAN_RESULT, error: null });
      const recordReport = vi.spyOn(taskService, 'recordReport');

      service.resumeRun(task, run);
      await settle();

      expect(runner.resumed).toEqual([]);
      expect(recordReport).not.toHaveBeenCalled();
      expect(run.endDate).toBe(endDate);
      expect(judgeExpect).toHaveBeenCalledWith(expect.anything(), task, expect.anything());
      expect(task.status).toBe(TaskStatus.SUCCEEDED);
    });

    it('queues a task whose resumed agent never started again, without spending a run', async () => {
      const { task, run } = runningTask(1);

      service.resumeRun(task, run);
      await settle();
      runner.finish(1, { exitCode: null, result: null, error: 'gone', neverStarted: true });
      await settle();

      expect(judgeExpect).not.toHaveBeenCalled();
      expect(logFailure).not.toHaveBeenCalled();
      expect(runner.started).toEqual([1, 1]);
      expect(taskService.runs.map(existing => existing.number)).toEqual([1]);
      expect(task.status).toBe(TaskStatus.RUNNING);
    });

    it('fails the task of a trigger no longer in the config, reporting nothing', async () => {
      const { task, run } = runningTask(1);
      task.triggerName = 'removed';

      service.resumeRun(task, run);
      await settle();

      expect(runner.resumed).toEqual([]);
      expect(task.status).toBe(TaskStatus.FAILED);
      expect(run.error).toBe('Trigger removed is no longer in the config');
      expect(run.endReason).toBe(RunEndReason.RUNNER_ERROR);
      expect(logFailure).not.toHaveBeenCalled();
    });
  });

  describe('pinning', () => {
    const CONFIG_A = 11;
    const CONFIG_B = 12;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
      swap(CONFIG_A, [trigger('implement', 1)]);
    });

    it('runs and checks a retry on the revision its first run started on, after a swap', async () => {
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      const [pinned] = triggers;
      swap(CONFIG_B, [trigger('implement', 1)]);

      runner.finish(1, INFRASTRUCTURE_FAILURE);
      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);

      expect(runner.started).toEqual([1, 1]);
      expect(runner.requests[1].trigger).toBe(pinned);
      expect(check.mock.calls[1][0]).toBe(pinned);
      expect(taskService.runs.map(run => run.configId)).toEqual([CONFIG_A, CONFIG_A]);
      expect(task.configId).toBe(CONFIG_A);
    });

    it('pins a task queued before a swap to the revision running when its first run starts', async () => {
      taskService.add('implement', 1);
      const second = taskService.add('implement', 2);
      await service.requestDispatch();

      swap(CONFIG_B, [trigger('implement', 1)]);
      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.requests[1].trigger).toBe(triggers[0]);
      expect(second.configId).toBe(CONFIG_B);
    });

    it("counts a pinned retry against the running revision's trigger of the same name", async () => {
      taskService.add('implement', 1);
      await service.requestDispatch();

      taskService.add('implement', 2);
      swap(CONFIG_B, [trigger('implement', 2)]);

      runner.finish(1, INFRASTRUCTURE_FAILURE);
      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);

      expect(runner.started).toEqual([1, 2, 1]);
    });

    it('cancels a queued task whose pinned revision is not loaded', async () => {
      const task = taskService.add('implement', 1);
      task.configId = CONFIG_B;

      await service.requestDispatch();

      expect(runner.started).toEqual([]);
      expect(task).toMatchObject({
        status: TaskStatus.CANCELLED,
        cancelReason: `The config revision the task is pinned to, config_revision ${CONFIG_B}, does not load`,
      });
    });

    it('fails a run whose pinned revision is not loaded, reporting nothing', async () => {
      const task = taskService.add('implement', 1);
      task.status = TaskStatus.RUNNING;
      task.configId = CONFIG_B;

      const run = new Run({
        taskId: task.id,
        number: 1,
        list: StepList.STEPS,
        step: 0,
        startDate: new Date(),
        configId: CONFIG_B,
        agent: null,
      });
      taskService.runs.push(run);

      service.resumeRun(task, run);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.resumed).toEqual([]);
      expect(task.status).toBe(TaskStatus.FAILED);
      expect(run.error).toBe(`The config revision the task is pinned to, config_revision ${CONFIG_B}, does not load`);
      expect(run.endReason).toBe(RunEndReason.RUNNER_ERROR);
      expect(logFailure).not.toHaveBeenCalled();
    });

    it('keeps loaded only the revisions an unfinished task is pinned to', async () => {
      taskService.add('implement', 1).configId = CONFIG_B;
      taskService.add('implement', 2).configId = CONFIG_A;
      taskService.add('implement', 3).status = TaskStatus.SUCCEEDED;

      await service.requestDispatch();

      expect(retainRevisions).toHaveBeenCalledWith(new Set([CONFIG_A, CONFIG_B]));
    });

    it('pins a task whose first run never started to the revision running when it starts again', async () => {
      const task = taskService.add('implement', 1);
      let endRun: (report: IRunReport) => void = () => undefined;

      vi.spyOn(runner, 'run').mockImplementationOnce(
        () =>
          new Promise(resolve => {
            endRun = resolve;
          })
      );

      await service.requestDispatch();
      expect(task.configId).toBe(CONFIG_A);

      swap(CONFIG_B, [trigger('implement', 1)]);
      endRun({ ...SUCCESS, neverStarted: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(task.configId).toBe(CONFIG_B);
      expect(runner.requests.at(-1)?.trigger).toBe(triggers[0]);
    });
  });

  describe('steps', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
    });

    it('runs each step in order as a run of its own, judging expect once after the last', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(judgeExpect).not.toHaveBeenCalled();
      expect(task).toMatchObject({ status: TaskStatus.RUNNING, step: 1 });

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.requests.map(request => request.step)).toEqual(triggers[0].steps);
      expect(taskService.runs.map(run => [run.number, run.step, run.outcome])).toEqual([
        [1, 0, RunOutcome.SUCCEEDED],
        [1, 1, RunOutcome.SUCCEEDED],
      ]);
      expect(judgeExpect).toHaveBeenCalledOnce();
      expect(task.status).toBe(TaskStatus.SUCCEEDED);
    });

    it("runs a task's next step ahead of newer tasks, under the trigger's one concurrency", async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      const first = taskService.add('implement', 1);
      const second = taskService.add('implement', 2);
      await service.requestDispatch();

      expect(runner.started).toEqual([1]);

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.started).toEqual([1, 1]);
      expect([first.step, second.step]).toEqual([1, 0]);
      expect(second.status).toBe(TaskStatus.QUEUED);
    });

    it("counts a trigger's tasks running at any step against its concurrency", async () => {
      triggers = [stepsTrigger('implement', [{ name: 'subscription' }, { name: 'api' }])];
      Object.assign(taskService.add('implement', 1), { status: TaskStatus.RUNNING, step: 1 });
      taskService.add('implement', 2);

      await service.requestDispatch();

      expect(runner.started).toEqual([]);
    });

    it('holds no slot between steps, so a task waiting on a full agent lets a newer task start', async () => {
      const api: ITestAgent = { name: 'api', concurrency: 1 };
      triggers = [stepsTrigger('implement', [{ name: 'subscription' }, api]), trigger('review', 1, api)];
      Object.assign(taskService.add('review', 1), { status: TaskStatus.RUNNING });
      const waiting = Object.assign(taskService.add('implement', 2), { step: 1 });
      taskService.add('implement', 3);

      await service.requestDispatch();

      expect(runner.started).toEqual([3]);
      expect(waiting.status).toBe(TaskStatus.QUEUED);
    });

    it('starts an older task between steps on one agent before a newer first step on another', async () => {
      triggers = [stepsTrigger('implement', [{ name: 'subscription' }, { name: 'api' }])];
      taskService.add('implement', 1).step = 1;
      taskService.add('implement', 2);

      await service.requestDispatch();

      expect(runner.started).toEqual([1]);
      expect(runner.requests[0].step.agent.name).toBe('api');
    });

    it("shares the agent's cap across a trigger's steps, starting the oldest task first", async () => {
      const single: ITestAgent = { name: 'subscription', concurrency: 1 };
      triggers = [stepsTrigger('implement', [single, single], 2)];
      taskService.add('implement', 1);
      taskService.add('implement', 2);
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.started).toEqual([1, 1]);
      expect(taskService.statusOf(2)).toBe(TaskStatus.QUEUED);
    });

    it('retries only the step that failed on a transient deployment fault, as its next try, never the steps before it', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);
      runner.finish(1, INFRASTRUCTURE_FAILURE);
      await vi.advanceTimersByTimeAsync(0);

      expect(task).toMatchObject({
        status: TaskStatus.QUEUED,
        step: 1,
        notBeforeDate: new Date(Date.now() + FIRST_RETRY_MS),
      });

      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.requests.at(-1)?.step).toBe(triggers[0].steps[1]);
      expect(taskService.runs.map(run => [run.step, run.number, run.outcome])).toEqual([
        [0, 1, RunOutcome.SUCCEEDED],
        [1, 1, RunOutcome.FAILED],
        [1, 2, RunOutcome.SUCCEEDED],
      ]);
      expect(task.status).toBe(TaskStatus.SUCCEEDED);
    });

    it("gives each step its own retries, so an earlier step's retry spends none of a later step's", async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1, INFRASTRUCTURE_FAILURE);
      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      for (const delayMs of STEP_TRY_DELAYS_MS) {
        runner.finish(1, INFRASTRUCTURE_FAILURE);
        await vi.advanceTimersByTimeAsync(delayMs);
      }

      expect(taskService.statusOf(1)).toBe(TaskStatus.RUNNING);

      runner.finish(1, INFRASTRUCTURE_FAILURE);
      await vi.advanceTimersByTimeAsync(0);

      expect(taskService.statusOf(1)).toBe(TaskStatus.FAILED);
      expect(runner.requests.map(request => [request.run.step, request.run.number])).toEqual([
        [0, 1],
        [0, 2],
        [1, 1],
        [1, 2],
        [1, 3],
      ]);
      expect(logFailure).toHaveBeenCalledOnce();
    });

    it('starts a later step again, at that step, when its agent never started', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);
      runner.finish(1, { exitCode: null, result: null, error: 'gone', neverStarted: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.requests.map(request => request.run.step)).toEqual([0, 1, 1]);
      expect(task).toMatchObject({ status: TaskStatus.RUNNING, step: 1 });
      expect(check).toHaveBeenCalledTimes(3);
    });

    it('fails the task once an earlier step runs out of retries, running no later step', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      taskService.add('implement', 1);
      await service.requestDispatch();

      for (const delayMs of STEP_TRY_DELAYS_MS) {
        runner.finish(1, INFRASTRUCTURE_FAILURE);
        await vi.advanceTimersByTimeAsync(delayMs);
      }

      runner.finish(1, INFRASTRUCTURE_FAILURE);
      await vi.advanceTimersByTimeAsync(0);

      expect(taskService.statusOf(1)).toBe(TaskStatus.FAILED);
      expect(runner.requests.map(request => request.run.step)).toEqual([0, 0, 0]);
      expect(logFailure).toHaveBeenCalledOnce();
    });

    it('fails the task with no retry when expect fails after the last step', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      const task = taskService.add('implement', 1);
      judgeExpect.mockResolvedValueOnce(MISSED_EXPECT);
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);
      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(taskService.runs.at(-1)).toMatchObject({ step: 1, error: 'The issue lacks workflow::review' });
      expect(task.status).toBe(TaskStatus.FAILED);
      expect(logFailure).toHaveBeenCalledOnce();
    });

    it('fails the task at a step whose agent crashed, running no later step, and reports that run', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1, CRASH);
      await vi.advanceTimersByTimeAsync(0);

      expect(taskService.statusOf(1)).toBe(TaskStatus.FAILED);
      expect(runner.started).toEqual([1]);
      expect(logFailure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: 'implement' }),
        expect.objectContaining({ issueIid: 1 }),
        expect.objectContaining({ number: 1, step: 0 }),
        expect.objectContaining({ error: 'exit 1', deploymentFault: null })
      );
    });

    it('checks the issue before every step', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      taskService.add('implement', 1);
      await service.requestDispatch();

      check.mockResolvedValueOnce({ kind: 'cancel', reason: 'The issue is closed' });
      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(check).toHaveBeenCalledTimes(2);
      expect(taskService.statusOf(1)).toBe(TaskStatus.CANCELLED);
    });

    it('caps each step by its own agent, so steps on different agents run side by side', async () => {
      const single = (name: string): ITestAgent => ({ name, concurrency: 1 });
      triggers = [stepsTrigger('implement', [single('subscription'), single('api')], 2)];
      taskService.add('implement', 1);
      taskService.add('implement', 2);
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.started).toEqual([1, 1, 2]);
      expect(runner.requests.map(request => request.step.agent.name)).toEqual(['subscription', 'api', 'subscription']);
    });

    it('runs a later step on the revision the first step started on, after a swap', async () => {
      swap(11, [stepsTrigger('implement', [CLAUDE, CLAUDE])]);
      const [pinned] = triggers;
      taskService.add('implement', 1);
      await service.requestDispatch();

      swap(12, [stepsTrigger('implement', [CLAUDE, CLAUDE])]);
      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.requests[1].step).toBe(pinned.steps[1]);
      expect(taskService.runs.map(run => run.configId)).toEqual([11, 11]);
    });

    it('queues the next step for a step whose report was stored before a restart', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      const task = taskService.add('implement', 1);
      task.status = TaskStatus.RUNNING;

      const run = new Run({
        taskId: task.id,
        number: 1,
        list: StepList.STEPS,
        step: 0,
        startDate: new Date(),
        configId: null,
        agent: null,
      });
      Object.assign(run, { endDate: new Date(), exitCode: 0, result: CLEAN_RESULT, error: null });
      taskService.runs.push(run);

      service.resumeRun(task, run);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.resumed).toEqual([]);
      expect(judgeExpect).not.toHaveBeenCalled();
      expect(run.outcome).toBe(RunOutcome.SUCCEEDED);
      expect(runner.requests.map(request => request.step)).toEqual([triggers[0].steps[1]]);
      expect(task).toMatchObject({ status: TaskStatus.RUNNING, step: 1 });
    });

    it("leaves a task pinned past the running config's last step queued", async () => {
      swap(11, [stepsTrigger('implement', [CLAUDE, CLAUDE, CLAUDE])]);
      const task = taskService.add('implement', 1);
      Object.assign(task, { configId: 11, step: 2 });
      swap(12, [stepsTrigger('implement', [CLAUDE, CLAUDE])]);

      await service.requestDispatch();

      expect(runner.started).toEqual([]);
      expect(task.status).toBe(TaskStatus.QUEUED);
    });

    it('starts a step that holds no agent slot past a full agent', async () => {
      const single: ITestAgent = { name: 'subscription', concurrency: 1 };
      triggers = [trigger('implement', 1, single), trigger('relabel', 5, single)];
      vi.spyOn(StepExecutorService.prototype, 'agentOf').mockImplementation(step =>
        triggers[1].steps.includes(step) ? null : { ...single, model: 'claude-opus-5-5', auth: 'oauth' }
      );
      taskService.add('implement', 1);
      taskService.add('relabel', 2);
      taskService.add('relabel', 3);

      await service.requestDispatch();

      expect(runner.started).toEqual([1, 2, 3]);
    });

    it('resumes the step that was in flight at a restart', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      const task = taskService.add('implement', 1);
      Object.assign(task, { status: TaskStatus.RUNNING, step: 1 });

      const run = new Run({
        taskId: task.id,
        number: 1,
        list: StepList.STEPS,
        step: 1,
        startDate: new Date(),
        configId: null,
        agent: null,
      });
      run.id = 101;
      taskService.runs.push(run);

      service.resumeRun(task, run);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.resumed).toEqual([101]);
      expect(runner.requests[0].step).toBe(triggers[0].steps[1]);
    });

    it('cancels a queued task at a step its trigger no longer has', async () => {
      const task = taskService.add('implement', 1);
      task.step = 1;
      triggers = [stepsTrigger('implement', [CLAUDE, CLAUDE])];
      const narrowed = [trigger('implement', 1)];
      revisions.set(7, narrowed);
      task.configId = 7;

      await service.requestDispatch();

      expect(runner.started).toEqual([]);
      expect(task).toMatchObject({
        status: TaskStatus.CANCELLED,
        cancelReason: 'Trigger implement has no steps[1] any more',
      });
    });

    it('fails a running step its trigger no longer has for good, without a retry', async () => {
      triggers = [trigger('implement', 1)];
      const task = taskService.add('implement', 1);
      Object.assign(task, { status: TaskStatus.RUNNING, step: 1 });

      const run = new Run({
        taskId: task.id,
        number: 1,
        list: StepList.STEPS,
        step: 1,
        startDate: new Date(),
        configId: null,
        agent: null,
      });
      taskService.runs.push(run);

      service.resumeRun(task, run);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.resumed).toEqual([]);
      expect(task.status).toBe(TaskStatus.FAILED);
      expect(run.error).toBe('Step 1 is no longer in the config');
      expect(run.endReason).toBe(RunEndReason.RUNNER_ERROR);
      expect(logFailure).toHaveBeenCalledOnce();
    });
  });

  describe('static steps', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
    });

    it('retries a static step that failed on a transient deployment fault at that step, running no earlier step again', async () => {
      const relabel: IStepConfig = { kind: 'relabel', add: ['workflow::test'], remove: [] };
      triggers = [
        { ...stepsTrigger('implement', [CLAUDE]), steps: [{ kind: 'agent', agent: CLAUDE }, relabel] },
      ] as ITriggerConfig[];
      const task = taskService.add('implement', 1);
      staticHandler.report = {
        exitCode: null,
        result: null,
        error: 'GitLab answered 502',
        deploymentFault: DeploymentFault.TRANSIENT,
      };
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(task).toMatchObject({ status: TaskStatus.QUEUED, list: StepList.STEPS, step: 1 });

      staticHandler.report = { exitCode: null, result: 'Relabelled', error: null };
      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);

      expect(task.status).toBe(TaskStatus.SUCCEEDED);
      expect(runner.started).toEqual([1]);
      expect(taskService.runs.map(run => [run.step, run.number, run.outcome])).toEqual([
        [0, 1, RunOutcome.SUCCEEDED],
        [1, 1, RunOutcome.FAILED],
        [1, 2, RunOutcome.SUCCEEDED],
      ]);
    });

    it('holds no agent slot for a static step', async () => {
      const relabel: IStepConfig = { kind: 'relabel', add: ['workflow::test'], remove: [] };
      const capped = { name: 'claude', concurrency: 1 };
      triggers = [
        { ...stepsTrigger('merged', [capped], 2), steps: [relabel] },
        stepsTrigger('implement', [capped], 2),
      ] as ITriggerConfig[];
      taskService.add('implement', 1);
      taskService.add('merged', 2);

      await service.requestDispatch();

      expect(runner.started).toEqual([1]);
      expect(staticHandler.requests.map(request => request.task.issueIid)).toEqual([2]);
    });

    it("records an agent step's agent on its run, and none on a static step's", async () => {
      const relabel: IStepConfig = { kind: 'relabel', add: ['workflow::test'], remove: [] };
      const claude: IActionAgent = { name: 'claude', model: 'claude-opus-5-5', auth: 'apiKey' };
      triggers = [
        { ...stepsTrigger('implement', [claude]), steps: [{ kind: 'agent', agent: claude }, relabel] },
      ] as ITriggerConfig[];
      taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(taskService.runs.map(run => [run.agentName, run.agentModel, run.agentAuth])).toEqual([
        ['claude', 'claude-opus-5-5', 'apiKey'],
        [null, null, null],
      ]);
    });
  });

  describe('failureSteps', () => {
    const LABEL_FAILED: IStepConfig = { kind: 'relabel', add: ['foundry::failed'], remove: [] };
    const REPORT: IStepConfig = { kind: 'comment', body: '{{failure.report}}' };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
    });

    it('queues a task that failed for good for its failureSteps, runs each once in order, then ends it failed', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [LABEL_FAILED, REPORT])];
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1, CRASH);
      await vi.advanceTimersByTimeAsync(0);

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(staticHandler.requests.map(request => request.step)).toEqual([LABEL_FAILED, REPORT]);
      expect(taskService.runs.map(run => [run.list, run.step, run.number, run.outcome])).toEqual([
        [StepList.STEPS, 0, 1, RunOutcome.FAILED],
        [StepList.FAILURE_STEPS, 0, 1, RunOutcome.SUCCEEDED],
        [StepList.FAILURE_STEPS, 1, 1, RunOutcome.SUCCEEDED],
      ]);
      expect(logFailure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: 'implement' }),
        task,
        expect.objectContaining({ list: StepList.STEPS, step: 0 }),
        expect.objectContaining({ error: 'exit 1', deploymentFault: null })
      );
    });

    it('ends a task whose step ran out of tries on a transient deployment fault without its failureSteps', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [LABEL_FAILED, REPORT])];
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      for (const delayMs of STEP_TRY_DELAYS_MS) {
        runner.finish(1, INFRASTRUCTURE_FAILURE);
        await vi.advanceTimersByTimeAsync(delayMs);
      }

      runner.finish(1, INFRASTRUCTURE_FAILURE);
      await vi.advanceTimersByTimeAsync(0);

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(taskService.runs.map(run => run.list)).toEqual([StepList.STEPS, StepList.STEPS, StepList.STEPS]);
      expect(staticHandler.requests).toEqual([]);
      expect(failureContext).not.toHaveBeenCalled();
      expect(logFailure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: 'implement' }),
        task,
        expect.objectContaining({ number: 3 }),
        expect.objectContaining({ deploymentFault: DeploymentFault.TRANSIENT })
      );
    });

    it('ends a task at once on a permanent deployment fault, with no retry and no failureSteps', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [LABEL_FAILED, REPORT])];
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1, {
        ...INFRASTRUCTURE_FAILURE,
        error: 'No GITLAB_TOKEN',
        deploymentFault: DeploymentFault.PERMANENT,
      });
      await vi.advanceTimersByTimeAsync(STEP_TRY_DELAYS_MS[0]);

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(runner.started).toEqual([1]);
      expect(taskService.runs[0]).toMatchObject({ deploymentFault: DeploymentFault.PERMANENT });
      expect(staticHandler.requests).toEqual([]);
      expect(logFailure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: 'implement' }),
        task,
        expect.objectContaining({ number: 1 }),
        { outcome: RunOutcome.FAILED, error: 'No GITLAB_TOKEN', deploymentFault: DeploymentFault.PERMANENT }
      );
    });

    it('hands each failure step the failure read from the task, and no step of steps any', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [REPORT])];
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1, CRASH);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.requests[0].failure).toBeUndefined();
      expect(failureContext).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'implement' }), task);
      expect(staticHandler.requests[0].failure).toEqual({ report: 'The report', reason: '` exit 1 `' });
    });

    it('runs an agent failure step through the runner, with the failure', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [{ kind: 'agent', agent: CLAUDE } as unknown as IStepConfig])];
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1, CRASH);
      await vi.advanceTimersByTimeAsync(0);

      expect(task).toMatchObject({ status: TaskStatus.RUNNING, list: StepList.FAILURE_STEPS, step: 0 });
      expect(runner.requests[1].failure).toEqual({ report: 'The report', reason: '` exit 1 `' });

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(judgeExpect).not.toHaveBeenCalled();
    });

    it('skips the failure steps after one that fails, retrying none, even on a transient deployment fault', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [LABEL_FAILED, REPORT])];
      const task = taskService.add('implement', 1);
      staticHandler.report = {
        exitCode: null,
        result: null,
        error: 'GitLab answered 502',
        deploymentFault: DeploymentFault.TRANSIENT,
      };
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await service.requestDispatch();

      runner.finish(1, CRASH);
      await vi.advanceTimersByTimeAsync(STEP_TRY_DELAYS_MS[0]);

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(staticHandler.requests).toHaveLength(1);
      expect(taskService.runs.at(-1)).toMatchObject({
        list: StepList.FAILURE_STEPS,
        step: 0,
        outcome: RunOutcome.FAILED,
        error: 'GitLab answered 502',
      });
      expect(logFailure).toHaveBeenCalledOnce();
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: task.id,
          issue: 1,
          step: 0,
          deploymentFault: DeploymentFault.TRANSIENT,
          error: 'GitLab answered 502',
        }),
        'concludeFailureStep(): Deployment fault: failureSteps[0] of task 1 failed, skipping the 1 after it'
      );
    });

    it('runs a failure step without the failure when it cannot be read', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [LABEL_FAILED])];
      const task = taskService.add('implement', 1);
      failureContext.mockRejectedValueOnce(new Error('Task 1 has no failed run to report'));
      await service.requestDispatch();

      runner.finish(1, CRASH);
      await vi.advanceTimersByTimeAsync(0);

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(staticHandler.requests).toEqual([expect.objectContaining({ step: LABEL_FAILED })]);
      expect(staticHandler.requests[0].failure).toBeUndefined();
      expect(taskService.runs.at(-1)).toMatchObject({ list: StepList.FAILURE_STEPS, outcome: RunOutcome.SUCCEEDED });
    });

    it('ends a task queued for failure steps of a trigger the running config no longer has', async () => {
      const task = taskService.add('removed', 1);
      Object.assign(task, { list: StepList.FAILURE_STEPS, step: 0 });
      const kept = taskService.add('removed', 2);

      await service.requestDispatch();

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(kept.status).toBe(TaskStatus.QUEUED);
    });

    it('ends no task for failure steps while no trigger is configured', async () => {
      triggers = [];
      const task = taskService.add('implement', 1);
      Object.assign(task, { list: StepList.FAILURE_STEPS, step: 0 });

      await service.requestDispatch();

      expect(task.status).toBe(TaskStatus.QUEUED);
    });

    it('ends a task with no failureSteps failed at once', async () => {
      const task = taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1, CRASH);
      await vi.advanceTimersByTimeAsync(0);

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(taskService.runs).toHaveLength(1);
      expect(logFailure).toHaveBeenCalledOnce();
    });

    it('runs no failureSteps for a task that succeeded, or one retrying a step', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [REPORT])];
      const succeeded = taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      const retrying = taskService.add('implement', 2);
      await service.requestDispatch();

      runner.finish(2, INFRASTRUCTURE_FAILURE);
      await vi.advanceTimersByTimeAsync(0);

      expect(succeeded.status).toBe(TaskStatus.SUCCEEDED);
      expect(retrying).toMatchObject({ status: TaskStatus.QUEUED, list: StepList.STEPS, step: 0 });
      expect(staticHandler.requests).toEqual([]);
    });

    it('ends a task queued for a failure step its pinned revision no longer loads, rather than cancelling it', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [REPORT])];
      const task = taskService.add('implement', 1);
      Object.assign(task, { list: StepList.FAILURE_STEPS, step: 0, configId: 9 });

      await service.requestDispatch();

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(staticHandler.requests).toEqual([]);
    });

    it('ends a task queued at a failure step its pinned revision does not have', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [REPORT, REPORT])];
      revisions.set(9, [stepsTrigger('implement', [CLAUDE], 1, [REPORT])]);
      const task = taskService.add('implement', 1);
      Object.assign(task, { list: StepList.FAILURE_STEPS, step: 1, configId: 9 });

      await service.requestDispatch();

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(staticHandler.requests).toEqual([]);
    });

    it("ends a task queued past the end of its trigger's failureSteps, such as after a merge emptied them", async () => {
      const task = taskService.add('implement', 1);
      Object.assign(task, { list: StepList.FAILURE_STEPS, step: 0 });
      const queued = taskService.add('implement', 2);

      await service.requestDispatch();

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(queued.status).toBe(TaskStatus.RUNNING);
    });

    it('runs failureSteps after expect fails', async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [REPORT])];
      const task = taskService.add('implement', 1);
      judgeExpect.mockResolvedValueOnce(MISSED_EXPECT);
      await service.requestDispatch();

      runner.finish(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(staticHandler.requests).toHaveLength(1);
      expect(logFailure).toHaveBeenCalledExactlyOnceWith(expect.anything(), task, expect.anything(), MISSED_EXPECT);
    });

    it("holds a failure step to its trigger's concurrency", async () => {
      triggers = [stepsTrigger('implement', [CLAUDE], 1, [REPORT])];
      const failing = taskService.add('implement', 1);
      Object.assign(failing, { list: StepList.FAILURE_STEPS, step: 0 });
      const running = taskService.add('implement', 2);
      running.status = TaskStatus.RUNNING;

      await service.requestDispatch();

      expect(failing.status).toBe(TaskStatus.QUEUED);
      expect(staticHandler.requests).toEqual([]);
    });
  });

  describe('delayed tasks', () => {
    it('waits for notBeforeDate, then starts the task', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));

      taskService.add('implement', 1, new Date('2026-10-14T10:05:00Z'));
      await service.requestDispatch();

      expect(runner.started).toEqual([]);

      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(runner.started).toEqual([1]);
    });
  });

  describe('failed passes', () => {
    it('retries a failed pass after DISPATCH_RETRY_MS', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      taskService.add('implement', 1);
      vi.spyOn(taskService, 'countRunning').mockRejectedValueOnce(new Error('connection lost'));

      await service.requestDispatch();
      expect(runner.started).toEqual([]);

      await vi.advanceTimersByTimeAsync(DISPATCH_RETRY_MS);

      expect(runner.started).toEqual([1]);
    });

    it("starts the tasks after one that failed to start, and retries that one's pass", async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      triggers = [trigger('implement', 1), trigger('review', 1)];
      taskService.add('implement', 1);
      taskService.add('review', 2);
      check.mockRejectedValueOnce(new Error('connection lost'));

      await service.requestDispatch();
      expect(runner.started).toEqual([2]);

      await vi.advanceTimersByTimeAsync(DISPATCH_RETRY_MS);

      expect(runner.started).toEqual([2, 1]);
    });
  });

  describe('without a runner', () => {
    it('starts nothing and leaves the tasks queued', async () => {
      const unbound = createService();
      taskService.add('implement', 1);

      await unbound.requestDispatch();

      expect(taskService.statusOf(1)).toBe(TaskStatus.QUEUED);

      await unbound.stop();
    });
  });

  describe('stop', () => {
    it('leaves a run stopped mid-judgement running, with its report stored', async () => {
      taskService.add('implement', 1);
      await service.requestDispatch();

      judgeExpect.mockImplementationOnce(async (_trigger, _task, signal) => {
        await new Promise(resolve => signal.addEventListener('abort', resolve));
        signal.throwIfAborted();

        return PASSED;
      });

      runner.finish(1);
      await settle();
      await service.stop();

      expect(taskService.statusOf(1)).toBe(TaskStatus.RUNNING);
      expect(taskService.runs[0]).toMatchObject({ exitCode: 0, outcome: null, endDate: expect.any(Date) as Date });
    });

    it('claims nothing when shutdown lands during the pre-start check', async () => {
      taskService.add('implement', 1);
      check.mockImplementationOnce(() => {
        void service.stop();

        return Promise.resolve({ kind: 'start' });
      });

      await service.requestDispatch();

      expect(taskService.statusOf(1)).toBe(TaskStatus.QUEUED);
      expect(taskService.runs).toEqual([]);
    });

    it('queues a task whose agent had not started at shutdown again, without spending a run', async () => {
      taskService.add('implement', 1);
      await service.requestDispatch();

      runner.finish(1, { exitCode: null, result: null, error: 'Shut down', neverStarted: true });
      await service.stop();

      expect(taskService.statusOf(1)).toBe(TaskStatus.QUEUED);
      expect(taskService.runs).toEqual([]);
      expect(logFailure).not.toHaveBeenCalled();
    });

    it('aborts the runners and records nothing for the tasks still running', async () => {
      taskService.add('implement', 1);
      await service.requestDispatch();

      await service.stop();

      expect(runner.requests[0].signal.aborted).toBe(true);

      expect(taskService.statusOf(1)).toBe(TaskStatus.RUNNING);
    });

    it('claims and launches nothing further once stopped mid-pass', async () => {
      triggers = [trigger('implement', 3)];

      for (const issueIid of [1, 2, 3]) {
        taskService.add('implement', issueIid);
      }

      const stopped: Promise<void>[] = [];
      const startRun = taskService.startRun.bind(taskService);

      vi.spyOn(taskService, 'startRun').mockImplementation((task, configId, agent) => {
        if (stopped.length === 0) {
          stopped.push(service.stop());
        }

        return startRun(task, configId, agent);
      });

      await service.requestDispatch();
      await Promise.all(stopped);

      expect(runner.started).toEqual([]);
      expect([taskService.statusOf(2), taskService.statusOf(3)]).toEqual([TaskStatus.QUEUED, TaskStatus.QUEUED]);
    });

    it('starts nothing after stopping', async () => {
      await service.stop();
      taskService.add('implement', 1);

      await service.requestDispatch();

      expect(runner.started).toEqual([]);
    });
  });
});
