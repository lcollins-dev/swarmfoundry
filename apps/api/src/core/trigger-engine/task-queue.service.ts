import { Injectable, Logger } from '@nestjs/common';
import { inspect } from 'node:util';

import type { Run } from '@/core/task/entities/run.entity';
import type { Task } from '@/core/task/entities/task.entity';

import { FailureReportService } from './failure-report.service';
import { RunJudgeService } from './run-judge.service';
import { TaskCheckService } from './task-check.service';
import { StepExecutorService } from '@/core/actions/step-executor.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { TaskService } from '@/core/task/task.service';

import type { IActionAgent, IStepRequest } from '@/core/actions/actions.types';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import { stepsIn } from '@/core/task/step-list';
import {
  DeploymentFault,
  RunEndReason,
  RunOutcome,
  StepList,
  TaskStatus,
  type IRunJudgement,
  type IRunReport,
  type TaskNext,
} from '@/core/task/task.types';

const ERROR_MAX_LENGTH = 2000;
const NO_ERROR_MESSAGE = 'The runner failed without a message';
const RESTARTED_ERROR = 'The orchestrator restarted during the run';

// setTimeout overflows above this and fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

export const DISPATCH_RETRY_MS = 30_000;

export const CHECK_RETRY_MS = 60_000;

/** A step that failed on a transient deployment fault gets 3 tries, with these waits between them. */
export const STEP_TRY_DELAYS_MS: readonly number[] = [300_000, 900_000];

type RunStep = (request: IStepRequest) => Promise<IRunReport>;

/** The steps of one list of a trigger in the running config that resolve to one agent, or to none. */
interface ILane {
  trigger: ITriggerConfig;
  list: StepList;
  steps: number[];
  agent: IActionAgent | null;
}

interface IStartable {
  trigger: ITriggerConfig;
  task: Task;
}

interface IConclusion {
  judgement: IRunJudgement;
  next: TaskNext;

  /** The run failed the task's `steps` for good. */
  failedForGood: boolean;
}

const FAILED: TaskNext = { status: TaskStatus.FAILED };

const SUCCEEDED: IRunJudgement = { outcome: RunOutcome.SUCCEEDED, error: null, deploymentFault: null };

/**
 * Holds no queue in memory: the queue and the running counts are read from Postgres on every pass. A task runs each step
 * of its trigger's `steps` as a run of its own, queued again between steps, so it holds a slot only while a step runs.
 * A task that fails for good runs its trigger's `failureSteps` the same way, once each.
 */
@Injectable()
export class TaskQueueService {
  private readonly logger = new Logger(TaskQueueService.name);

  private readonly controller = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();

  private dispatching: Promise<void> | null = null;
  private dispatchRequests = 0;
  private wakeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly taskService: TaskService,
    private readonly taskCheckService: TaskCheckService,
    private readonly runJudgeService: RunJudgeService,
    private readonly failureReportService: FailureReportService,
    private readonly stepExecutorService: StepExecutorService
  ) {}

  /** Never rejects. A call during a pass makes that pass run once more. */
  requestDispatch(): Promise<void> {
    this.dispatchRequests++;

    if (this.dispatching !== null) {
      return this.dispatching;
    }

    this.dispatching = this.dispatchUntilSettled().finally(() => {
      this.dispatching = null;
    });

    return this.dispatching;
  }

  /**
   * Judges the run of a step, then queues the task for its next step, or judges `expect` after the last step. A step
   * that failed on a transient deployment fault queues the task again at that step while `STEP_TRY_DELAYS_MS` has a wait
   * left. Any other deployment fault ends the task, and any other failure queues it for its `failureSteps`, or ends it
   * when there are none. A failure step never retries, and the task ends `failed` after its last one or the first that
   * fails. Frees the task's slot and starts the next queued task.
   */
  async finishRun(task: Task, run: Run, report: IRunReport): Promise<void> {
    // A report stored before a restart keeps its end date when judged again.
    if (run.endDate === null) {
      await this.taskService.recordReport(run, report);
    }

    const trigger = this.triggerOf(task);
    const { judgement, next, failedForGood } =
      trigger === undefined
        ? { judgement: this.failure(this.missingTriggerError(task)), next: FAILED, failedForGood: false }
        : await this.conclude(trigger, task, run, report);

    await this.taskService.finishRun(task, run, judgement, next);

    this.logger.log(
      {
        taskId: task.id,
        trigger: task.triggerName,
        runId: run.id,
        run: run.number,
        list: run.list,
        step: run.step,
        outcome: judgement.outcome,
        exitCode: report.exitCode,
        error: judgement.error,
        status: next.status,
        nextList: next.status === TaskStatus.QUEUED ? next.list : undefined,
        nextStep: next.status === TaskStatus.QUEUED ? next.step : undefined,
        notBeforeDate: next.status === TaskStatus.QUEUED ? next.notBeforeDate : undefined,
      },
      `finishRun(): Run ${run.number} of ${run.list}[${run.step}] of task ${task.id} ${judgement.outcome}, so the task is ${next.status}`
    );

    void this.requestDispatch();

    if (trigger !== undefined && failedForGood) {
      this.failureReportService.logFailure(trigger, task, run, judgement);
    }
  }

  /**
   * Picks up a task a restart left running: judges a run whose report was stored, and resumes the step of any other. A
   * task whose trigger or step left the config fails.
   */
  resumeRun(task: Task, run: Run): void {
    const trigger = this.triggerOf(task);
    const step = trigger === undefined ? undefined : stepsIn(trigger, run.list).at(run.step);

    if (trigger === undefined || step === undefined || run.endDate !== null || !this.stepExecutorService.isReady()) {
      const report: IRunReport =
        run.endDate === null
          ? { exitCode: null, result: null, error: RESTARTED_ERROR, deploymentFault: DeploymentFault.TRANSIENT }
          : {
              exitCode: run.exitCode,
              result: run.result,
              error: run.error,
              deploymentFault: run.deploymentFault ?? undefined,
            };

      this.track(task, run, this.finishRun(task, run, report));

      return;
    }

    this.logger.log(
      { taskId: task.id, runId: run.id, list: run.list, step: run.step },
      `resumeRun(): Resuming run ${run.number} of ${run.list}[${run.step}] of task ${task.id}`
    );

    this.launch({ trigger, step, task, run, signal: this.controller.signal }, async request =>
      this.stepExecutorService.resume(await this.withFailure(request))
    );
  }

  /** Aborts every runner's signal and waits for them. A task still running stays `running` in the database. */
  async stop(): Promise<void> {
    this.controller.abort();

    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }

    await this.dispatching;
    await Promise.all(this.inFlight);
  }

  private async dispatchUntilSettled(): Promise<void> {
    let handledRequests = 0;

    while (handledRequests !== this.dispatchRequests && !this.isStopping()) {
      handledRequests = this.dispatchRequests;

      await this.dispatchOnce();
    }
  }

  private async dispatchOnce(): Promise<void> {
    if (!this.stepExecutorService.isReady()) {
      return;
    }

    // Before reading the running revision, so a swap during the read cannot unload the revision this pass pins.
    await this.retainPinnedRevisions();

    const triggers = this.foundryConfigService.triggers;
    const revisionId = this.foundryConfigService.revisionId;
    const now = new Date();
    let failed = false;

    try {
      failed = await this.dispatchStartable(triggers, revisionId, now);
    } catch (error) {
      if (this.isStopping()) {
        return;
      }

      this.logger.error({ error }, 'dispatchOnce(): Failed to start queued tasks');
      failed = true;
    }

    await this.scheduleWake(triggers, now, failed);
  }

  /**
   * `triggers` come from `revisionId`, the running config, which counts the slots and pins a task's first run. True
   * when a task failed to start, which holds back none of the tasks after it.
   */
  private async dispatchStartable(
    triggers: readonly ITriggerConfig[],
    revisionId: number | null,
    now: Date
  ): Promise<boolean> {
    let failed = false;

    await this.endStrandedFailureSteps(triggers);

    for (const startable of await this.pickStartable(triggers, now)) {
      if (this.isStopping()) {
        return failed;
      }

      try {
        await this.startTask(startable, revisionId);
      } catch (error) {
        if (this.isStopping()) {
          return failed;
        }

        this.logger.error({ taskId: startable.task.id, error }, 'dispatchStartable(): Failed to start a queued task');
        failed = true;
      }
    }

    return failed;
  }

  /** A pinned task runs, and is checked, on the trigger of its own revision. */
  private async startTask(startable: IStartable, revisionId: number | null): Promise<void> {
    const { task } = startable;
    const trigger = task.configId === null ? startable.trigger : this.triggerOf(task);

    if (trigger === undefined) {
      await this.cancelUnloaded(task);

      return;
    }

    const step = stepsIn(trigger, task.list).at(task.step);

    if (step === undefined) {
      await this.cancelMissingStep(task);

      return;
    }

    if (!(await this.passesCheck(trigger, task))) {
      return;
    }

    const agent = this.stepExecutorService.agentOf(step);
    const run = await this.taskService.startRun(
      task,
      revisionId,
      agent === null ? null : { name: agent.name, model: agent.model, auth: agent.auth }
    );

    if (run === null) {
      return;
    }

    if (this.isStopping()) {
      this.logger.log(
        { taskId: task.id, runId: run.id },
        'startTask(): Shutting down, so the claimed task waits for restart recovery'
      );

      return;
    }

    this.logger.log(
      {
        taskId: task.id,
        trigger: trigger.name,
        project: task.projectPath,
        issue: task.issueIid,
        fireTime: task.fireTime,
        mergeRequest: task.mergeRequestIid,
        runId: run.id,
        run: run.number,
        list: run.list,
        step: run.step,
        configId: run.configId,
      },
      `startTask(): Starting ${run.list}[${run.step}] of task ${task.id}`
    );

    this.launch({ trigger, step, task, run, signal: this.controller.signal }, async request =>
      this.stepExecutorService.run(await this.withFailure(request))
    );
  }

  /**
   * The oldest startable tasks across every trigger and step, each holding a slot of its trigger's `concurrency` and of
   * its step's agent's, so a task between steps on two agents keeps its place against newer tasks.
   */
  private async pickStartable(triggers: readonly ITriggerConfig[], now: Date): Promise<IStartable[]> {
    const lanes = this.lanesOf(triggers);
    const [triggerRunning, laneRunning] = await Promise.all([
      Promise.all(triggers.map(trigger => this.taskService.countRunning(trigger.name))),
      Promise.all(lanes.map(lane => this.taskService.countRunning(lane.trigger.name, lane))),
    ]);

    const triggerFree = new Map(
      triggers.map((trigger, index) => [trigger.name, trigger.concurrency - triggerRunning[index]])
    );
    const agentFree = new Map<string, number>();

    for (const [index, { agent }] of lanes.entries()) {
      if (agent !== null) {
        agentFree.set(agent.name, (agentFree.get(agent.name) ?? agent.concurrency ?? Infinity) - laneRunning[index]);
      }
    }

    const freeSlots = ({ trigger, agent }: ILane): number =>
      Math.min(triggerFree.get(trigger.name) ?? 0, agent === null ? Infinity : (agentFree.get(agent.name) ?? 0));

    const byArrival = (left: Task, right: Task): number => {
      const byDate = left.queuedDate.getTime() - right.queuedDate.getTime();

      return byDate === 0 ? left.id - right.id : byDate;
    };

    const candidates = (
      await Promise.all(
        lanes.map(async lane => {
          const free = freeSlots(lane);
          const tasks = free > 0 ? await this.taskService.findStartable(lane.trigger.name, lane, now, free) : [];

          return tasks.map(task => ({ lane, task }));
        })
      )
    )
      .flat()
      .sort((left, right) => byArrival(left.task, right.task));

    const picked: IStartable[] = [];

    for (const { lane, task } of candidates) {
      if (freeSlots(lane) > 0) {
        picked.push({ trigger: lane.trigger, task });
        triggerFree.set(lane.trigger.name, (triggerFree.get(lane.trigger.name) ?? 0) - 1);

        if (lane.agent !== null) {
          agentFree.set(lane.agent.name, (agentFree.get(lane.agent.name) ?? 0) - 1);
        }
      }
    }

    return picked;
  }

  private lanesOf(triggers: readonly ITriggerConfig[]): ILane[] {
    return triggers.flatMap(trigger =>
      [StepList.STEPS, StepList.FAILURE_STEPS].flatMap(list => {
        const byAgent = new Map<string | null, ILane>();

        for (const [index, step] of stepsIn(trigger, list).entries()) {
          const agent = this.stepExecutorService.agentOf(step);
          const lane = byAgent.get(agent?.name ?? null);

          if (lane === undefined) {
            byAgent.set(agent?.name ?? null, { trigger, list, steps: [index], agent });
          } else {
            lane.steps.push(index);
          }
        }

        return [...byAgent.values()];
      })
    );
  }

  /** Cancels a task whose issue no longer wants it, and holds back one whose issue could not be read. */
  private async passesCheck(trigger: ITriggerConfig, task: Task): Promise<boolean> {
    const check = await this.taskCheckService.check(trigger, task, this.controller.signal);
    const log = { taskId: task.id, trigger: trigger.name, project: task.projectPath, issue: task.issueIid };

    if (this.isStopping()) {
      return false;
    }

    if (check.kind === 'start') {
      return true;
    }

    if (check.kind === 'cancel') {
      if (await this.taskService.cancel(task, check.reason)) {
        this.logger.log({ ...log, reason: check.reason }, `passesCheck(): Cancelled task ${task.id}`);
      }
    } else {
      const notBeforeDate = new Date(Date.now() + CHECK_RETRY_MS);

      await this.taskService.delay(task, notBeforeDate);

      this.logger.warn(
        { ...log, error: check.error, notBeforeDate },
        'passesCheck(): Failed to read the issue before starting the task, trying again later'
      );
    }

    // The slot this task would have taken is still free, so run the pass again for the next queued task.
    void this.requestDispatch();

    return false;
  }

  private async cancelUnloaded(task: Task): Promise<void> {
    const reason = this.missingTriggerError(task);

    if (task.list === StepList.FAILURE_STEPS) {
      await this.skipFailureSteps(task, reason);
    } else if (await this.taskService.cancel(task, reason)) {
      this.logger.warn(
        { taskId: task.id, trigger: task.triggerName, configId: task.configId, reason },
        `cancelUnloaded(): Cancelled task ${task.id}`
      );
    }

    void this.requestDispatch();
  }

  private async cancelMissingStep(task: Task): Promise<void> {
    const reason = `Trigger ${task.triggerName} has no ${task.list}[${task.step}] any more`;

    if (task.list === StepList.FAILURE_STEPS) {
      await this.skipFailureSteps(task, reason);
    } else if (await this.taskService.cancel(task, reason)) {
      this.logger.warn(
        { taskId: task.id, trigger: task.triggerName, reason },
        `cancelMissingStep(): Cancelled task ${task.id}`
      );
    }

    void this.requestDispatch();
  }

  private async conclude(trigger: ITriggerConfig, task: Task, run: Run, report: IRunReport): Promise<IConclusion> {
    if (run.list === StepList.FAILURE_STEPS) {
      return this.concludeFailureStep(trigger, task, run, report);
    }

    const failed = (judgement: IRunJudgement): IConclusion => ({
      judgement,
      next: judgement.deploymentFault === null ? this.failureStepsOrEnd(trigger) : FAILED,
      failedForGood: true,
    });

    // No dispatch pass starts a step the running config lacks, so a retry of it would wait for ever.
    if (trigger.steps.at(run.step) === undefined) {
      return failed(this.failure(`Step ${run.step} is no longer in the config`));
    }

    const after = this.stepExecutorService.after(trigger.steps, run.step, report);

    if (after.kind === 'next') {
      return { judgement: SUCCEEDED, next: this.queuedAt(StepList.STEPS, after.index, null), failedForGood: false };
    }

    if (after.judgement.outcome === RunOutcome.FAILED) {
      const retry = this.retryOf(run, after.judgement);

      return retry === null
        ? failed(after.judgement)
        : { judgement: after.judgement, next: retry, failedForGood: false };
    }

    const judgement = await this.runJudgeService.judgeExpect(trigger, task, this.controller.signal);

    return judgement.outcome === RunOutcome.SUCCEEDED
      ? { judgement, next: { status: TaskStatus.SUCCEEDED }, failedForGood: false }
      : failed(judgement);
  }

  /** A failure step never retries. One that fails skips the rest, and the task ends failed either way. */
  private concludeFailureStep(trigger: ITriggerConfig, task: Task, run: Run, report: IRunReport): IConclusion {
    const after = this.stepExecutorService.after(trigger.failureSteps, run.step, report);

    if (after.kind === 'next') {
      return {
        judgement: SUCCEEDED,
        next: this.queuedAt(StepList.FAILURE_STEPS, after.index, null),
        failedForGood: false,
      };
    }

    if (after.judgement.outcome === RunOutcome.FAILED) {
      const skipped = trigger.failureSteps.length - run.step - 1;

      const { error, deploymentFault } = after.judgement;
      const fault = deploymentFault === null ? '' : 'Deployment fault: ';

      this.logger.error(
        {
          taskId: task.id,
          trigger: trigger.name,
          project: task.projectPath,
          issue: task.issueIid,
          fireTime: task.fireTime,
          mergeRequest: task.mergeRequestIid,
          runId: run.id,
          step: run.step,
          deploymentFault: deploymentFault ?? undefined,
          error,
        },
        `concludeFailureStep(): ${fault}failureSteps[${run.step}] of task ${task.id} failed, skipping the ${skipped} after it`
      );
    }

    return { judgement: after.judgement, next: FAILED, failedForGood: false };
  }

  private failureStepsOrEnd(trigger: ITriggerConfig): TaskNext {
    return trigger.failureSteps.length === 0 ? FAILED : this.queuedAt(StepList.FAILURE_STEPS, 0, null);
  }

  /** Null once the step has had its tries, or for a failure a retry cannot fix. */
  private retryOf(run: Run, judgement: IRunJudgement): TaskNext | null {
    const delayMs = STEP_TRY_DELAYS_MS.at(run.number - 1);

    if (judgement.deploymentFault !== DeploymentFault.TRANSIENT || delayMs === undefined) {
      return null;
    }

    return this.queuedAt(StepList.STEPS, run.step, new Date(Date.now() + delayMs));
  }

  private queuedAt(list: StepList, step: number, notBeforeDate: Date | null): TaskNext {
    return { status: TaskStatus.QUEUED, list, step, notBeforeDate };
  }

  /**
   * A pass picks a task only at a step the running config has, so a task queued for failure steps past the end of its
   * trigger's, such as after a merge shortened or removed them, would otherwise wait for ever. Ending one frees no slot.
   * Never rejects.
   */
  private async endStrandedFailureSteps(triggers: readonly ITriggerConfig[]): Promise<void> {
    // With no trigger configured, such as when the config is missing, every task would look stranded.
    if (triggers.length === 0) {
      return;
    }

    try {
      const stranded = await Promise.all([
        ...triggers.map(trigger =>
          this.taskService.findQueuedFrom(trigger.name, StepList.FAILURE_STEPS, trigger.failureSteps.length)
        ),
        this.taskService.findQueuedOutside(
          triggers.map(trigger => trigger.name),
          StepList.FAILURE_STEPS
        ),
      ]);

      for (const task of stranded.flat()) {
        await this.skipFailureSteps(
          task,
          `The running config has no failureSteps[${task.step}] for ${task.triggerName}`
        );
      }
    } catch (error) {
      if (!this.isStopping()) {
        this.logger.error({ error }, 'endStrandedFailureSteps(): Failed to end the tasks no pass would pick');
      }
    }
  }

  /** Ends a task whose failure steps can no longer run, such as one whose pinned revision no longer loads. */
  private async skipFailureSteps(task: Task, reason: string): Promise<void> {
    if (await this.taskService.endFailed(task)) {
      this.logger.error(
        { taskId: task.id, trigger: task.triggerName, reason },
        `skipFailureSteps(): Ended task ${task.id} without running the rest of its failureSteps`
      );
    }
  }

  /** The engine's own failure of the run, such as for a trigger gone from the config. */
  private failure(error: string): IRunJudgement {
    return { outcome: RunOutcome.FAILED, error, deploymentFault: null, endReason: RunEndReason.RUNNER_ERROR };
  }

  private triggerOf(task: Task): ITriggerConfig | undefined {
    return this.foundryConfigService.triggerAt(task.configId, task.triggerName);
  }

  /** A pinned revision always defines its task's trigger, so only an unpinned task's trigger can leave the config. */
  private missingTriggerError(task: Task): string {
    return task.configId === null
      ? `Trigger ${task.triggerName} is no longer in the config`
      : `The config revision the task is pinned to, config_revision ${task.configId}, does not load`;
  }

  private async retainPinnedRevisions(): Promise<void> {
    try {
      this.foundryConfigService.retainRevisions(await this.taskService.findPinnedConfigIds());
    } catch (error) {
      this.logger.error({ error }, 'retainPinnedRevisions(): Failed to read the pinned config revisions');
    }
  }

  /** Wakes the queue when the next delayed task may start, or after `DISPATCH_RETRY_MS` when this pass failed. */
  private async scheduleWake(triggers: readonly ITriggerConfig[], now: Date, failed: boolean): Promise<void> {
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }

    let delayMs = failed ? DISPATCH_RETRY_MS : Infinity;

    try {
      const next = await this.taskService.findNextNotBefore(
        triggers.map(trigger => trigger.name),
        now
      );

      if (next !== null) {
        delayMs = Math.min(delayMs, next.getTime() - now.getTime());
      }
    } catch (error) {
      this.logger.error({ error }, 'scheduleWake(): Failed to find the next delayed task');
      delayMs = DISPATCH_RETRY_MS;
    }

    if (delayMs === Infinity || this.isStopping()) {
      return;
    }

    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        void this.requestDispatch();
      },
      Math.min(delayMs, MAX_TIMER_MS)
    );
  }

  private launch(request: IStepRequest, runStep: RunStep): void {
    this.track(request.task, request.run, this.runToEnd(request, runStep));
  }

  /** Shutdown waits for `work`. */
  private track(task: Task, run: Run, work: Promise<void>): void {
    const finished = work.catch((error: unknown) => {
      if (this.isStopping()) {
        this.logger.log(
          { taskId: task.id, runId: run.id },
          'track(): Shutting down mid-judgement, so the task stays running for restart recovery'
        );

        return;
      }

      this.logger.error({ taskId: task.id, runId: run.id, error }, 'track(): Failed to record the end of the run');
    });

    this.inFlight.add(finished);
    void finished.finally(() => this.inFlight.delete(finished));
  }

  private async runToEnd(request: IStepRequest, runStep: RunStep): Promise<void> {
    // A rejection handler, not a trailing catch, so a failed write in finishRun never counts as the run failing.
    const report = await runStep(request).then(
      result => result,
      (error: unknown): IRunReport => ({
        exitCode: null,
        result: null,
        error: this.errorMessage(error),
        deploymentFault: DeploymentFault.TRANSIENT,
      })
    );

    if (report.neverStarted === true) {
      await this.taskService.releaseRun(request.task, request.run);

      this.logger.log(
        { taskId: request.task.id, runId: request.run.id },
        `runToEnd(): The agent never started, so task ${request.task.id} is queued again without spending a run`
      );

      void this.requestDispatch();

      return;
    }

    if (request.signal.aborted) {
      this.logger.log(
        { taskId: request.task.id, runId: request.run.id },
        'runToEnd(): Shutting down, so the task stays running for restart recovery'
      );

      return;
    }

    await this.finishRun(request.task, request.run, report);
  }

  /**
   * A step of `failureSteps` gets `{{failure.*}}`, read from the run that failed the task. One that cannot be read is
   * left out, so a step that never uses it, or a resumed agent, still runs, and one that renders it fails saying why.
   */
  private async withFailure(request: IStepRequest): Promise<IStepRequest> {
    if (request.run.list !== StepList.FAILURE_STEPS) {
      return request;
    }

    try {
      return { ...request, failure: await this.failureReportService.context(request.trigger, request.task) };
    } catch (error) {
      this.logger.warn(
        { taskId: request.task.id, runId: request.run.id, error: this.errorMessage(error) },
        'withFailure(): Failed to read the failure, so the failure step runs without it'
      );

      return request;
    }
  }

  private isStopping(): boolean {
    return this.controller.signal.aborted;
  }

  /** Redacted, since it may reach a log line or an issue comment. */
  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : inspect(error);
    const redacted = this.foundryConfigService.redact(message === '' ? NO_ERROR_MESSAGE : message);

    return String(redacted).slice(0, ERROR_MAX_LENGTH);
  }
}
