import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, In, IsNull, LessThanOrEqual, Like, MoreThan, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { RunTranscriptLine } from './entities/run-transcript-line.entity';
import { Run } from './entities/run.entity';
import { Task } from './entities/task.entity';

import { runEndReasonOf } from './run-end-reason';
import { taskKindOf } from './task-kind';
import {
  RunOutcome,
  StepList,
  TaskStatus,
  type IRunAgent,
  type IRunJudgement,
  type IRunningTask,
  type IRunReport,
  type IScheduledTaskFields,
  type TaskNext,
} from './task.types';
import { fireTimeAfter, fireTimeBefore } from '@/core/foundry-config/cron-schedule';
import type {
  IMergeRequestContext,
  IPromptContext,
  IScheduleContext,
  ITriggerConfig,
} from '@/core/foundry-config/foundry-config.types';
import { triggerKindOf } from '@/core/foundry-config/trigger-kind';
import type { IIssueChange, IIssueEvent, IMergeRequestEvent } from '@/core/issue-source/issue-source.types';

/** Some steps of one of a trigger's lists. */
export interface IListSteps {
  list: StepList;
  steps: readonly number[];
}

@Injectable()
export class TaskService {
  constructor(
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>,
    @InjectRepository(Run)
    private readonly runRepository: Repository<Run>,
    @InjectRepository(RunTranscriptLine)
    private readonly runTranscriptLineRepository: Repository<RunTranscriptLine>
  ) {}

  /** Returns null when the trigger already has a task for this change. */
  async enqueue(triggerName: string, event: IIssueEvent, change: IIssueChange): Promise<Task | null> {
    const task = new Task({
      triggerName,
      sourceName: event.source,
      projectId: event.project.id,
      projectPath: event.project.path,
      projectUrl: event.project.url,
      issueIid: event.issue.iid,
      issueTitle: event.issue.title,
      issueUrl: event.issue.url,
      matchedIssue: { labels: event.issue.labels, author: event.issue.author, assignees: event.issue.assignees },
      change,
      fireTime: null,
      cron: null,
      mergeRequest: null,
      queuedDate: new Date(),
    });

    return this.insertOrIgnore(task);
  }

  /** Returns null when the trigger already has a task for this fire time. */
  enqueueScheduled(fields: IScheduledTaskFields): Promise<Task | null> {
    const task = new Task({
      ...fields,
      projectId: null,
      issueIid: null,
      issueTitle: null,
      issueUrl: null,
      matchedIssue: null,
      change: null,
      mergeRequest: null,
      queuedDate: new Date(),
    });

    return this.insertOrIgnore(task);
  }

  /** Returns null when the trigger already has a task for this event on the merge request. */
  enqueueMergeRequest(triggerName: string, event: IMergeRequestEvent): Promise<Task | null> {
    const { mergeRequest, relatedIssue } = event;

    const task = new Task({
      triggerName,
      sourceName: event.source,
      projectId: event.project.id,
      projectPath: event.project.path,
      projectUrl: event.project.url,
      issueIid: relatedIssue?.iid ?? null,
      issueTitle: relatedIssue?.title ?? null,
      issueUrl: relatedIssue?.url ?? null,
      matchedIssue: null,
      change: null,
      fireTime: null,
      cron: null,
      mergeRequest: {
        iid: mergeRequest.iid,
        event: event.event,
        title: mergeRequest.title,
        url: mergeRequest.url,
        sourceBranch: mergeRequest.sourceBranch,
        targetBranch: mergeRequest.targetBranch,
      },
      queuedDate: new Date(),
    });

    return this.insertOrIgnore(task);
  }

  /** In any status. */
  findLatestScheduled(triggerName: string): Promise<Task | null> {
    return this.taskRepository.findOne({
      where: { triggerName, fireTime: Not(IsNull()) },
      order: { fireTime: 'DESC' },
    });
  }

  /** Counts every step of the trigger unless `at` names some of one list. */
  countRunning(triggerName: string, at?: IListSteps): Promise<number> {
    return this.taskRepository.count({
      where: {
        triggerName,
        status: TaskStatus.RUNNING,
        ...(at === undefined ? {} : { list: at.list, step: In([...at.steps]) }),
      },
    });
  }

  /** The trigger's tasks queued at one of `at.steps` that may start at `now`, in arrival order. */
  findStartable(triggerName: string, at: IListSteps, now: Date, limit: number): Promise<Task[]> {
    const where = { triggerName, list: at.list, step: In([...at.steps]), status: TaskStatus.QUEUED };

    return this.taskRepository.find({
      where: [
        { ...where, notBeforeDate: IsNull() },
        { ...where, notBeforeDate: LessThanOrEqual(now) },
      ],
      order: { queuedDate: 'ASC', id: 'ASC' },
      take: limit,
    });
  }

  /** The trigger's tasks queued in `list` at `step` or later. */
  findQueuedFrom(triggerName: string, list: StepList, step: number): Promise<Task[]> {
    return this.taskRepository.find({
      where: { triggerName, list, step: MoreThanOrEqual(step), status: TaskStatus.QUEUED },
      order: { id: 'ASC' },
    });
  }

  /** Tasks queued in `list` of any trigger but `triggerNames`. */
  findQueuedOutside(triggerNames: readonly string[], list: StepList): Promise<Task[]> {
    return this.taskRepository.find({
      where: { triggerName: Not(In([...triggerNames])), list, status: TaskStatus.QUEUED },
      order: { id: 'ASC' },
    });
  }

  async findNextNotBefore(triggerNames: string[], now: Date): Promise<Date | null> {
    const task = await this.taskRepository.findOne({
      where: { triggerName: In(triggerNames), status: TaskStatus.QUEUED, notBeforeDate: MoreThan(now) },
      order: { notBeforeDate: 'ASC' },
    });

    return task?.notBeforeDate ?? null;
  }

  /**
   * In any status. Newer by GitLab's time of the change, then kind, then id, as the trigger match picks it, since GitLab
   * numbers label events and notes apart. Null for a task with no issue change.
   */
  findNewer(task: Task): Promise<Task | null> {
    const { projectId, issueIid, changeKind, changeId, changeDate } = task;

    if (projectId === null || issueIid === null || changeKind === null || changeId === null || changeDate === null) {
      return Promise.resolve(null);
    }

    return this.taskRepository
      .createQueryBuilder('task')
      .where({ triggerName: task.triggerName, sourceName: task.sourceName, projectId, issueIid })
      .andWhere('(task.changeDate, task.changeKind, task.changeId) > (:changeDate, :changeKind, :changeId)', {
        changeDate,
        changeKind,
        changeId,
      })
      .orderBy('task.changeDate', 'DESC')
      .addOrderBy('task.changeKind', 'DESC')
      .addOrderBy('task.changeId', 'DESC')
      .getOne();
  }

  /**
   * Starts a run of the task's `step` of its `list`, pinning a task not yet pinned to `configId`, the revision the run starts on, and
   * storing the pin and the step's `agent` on the run. A retry of the step is its next try. Sets `task.status` and
   * `task.configId`. Returns null when the task was no longer queued.
   */
  @Transactional()
  async startRun(task: Task, configId: number | null, agent: IRunAgent | null): Promise<Run | null> {
    const pinned = task.configId ?? configId;

    const claimed = await this.taskRepository.update(
      { id: task.id, status: TaskStatus.QUEUED },
      { status: TaskStatus.RUNNING, configId: pinned }
    );

    if (claimed.affected !== 1) {
      return null;
    }

    task.status = TaskStatus.RUNNING;
    task.configId = pinned;

    const { list, step } = task;
    const number = await this.nextTry(task.id, list, step);
    const run = new Run({ taskId: task.id, number, list, step, startDate: new Date(), configId: pinned, agent });

    await this.runRepository.insert(run);

    return run;
  }

  /** The latest try of the task's current step, or null when it has none. */
  findCurrentRun(task: Task): Promise<Run | null> {
    return this.runRepository.findOne({
      where: { taskId: task.id, list: task.list, step: task.step },
      order: { number: 'DESC' },
    });
  }

  /** The run of `steps` that failed the task for good, or null when it has none. */
  findFailedRun(taskId: number): Promise<Run | null> {
    return this.runRepository.findOne({
      where: { taskId, list: StepList.STEPS, outcome: RunOutcome.FAILED },
      order: { step: 'DESC', number: 'DESC' },
    });
  }

  /** Leaves out a run whose agent never started, since it is deleted. */
  countRuns(taskId: number): Promise<number> {
    return this.runRepository.count({ where: { taskId } });
  }

  /** Ends the task without a run. Returns false when the task was no longer queued. */
  async cancel(task: Task, reason: string): Promise<boolean> {
    const endDate = new Date();
    const cancelled = await this.taskRepository.update(
      { id: task.id, status: TaskStatus.QUEUED },
      { status: TaskStatus.CANCELLED, cancelReason: reason, endDate }
    );

    if (cancelled.affected !== 1) {
      return false;
    }

    task.status = TaskStatus.CANCELLED;
    task.cancelReason = reason;
    task.endDate = endDate;

    return true;
  }

  /** Holds a queued task back until `notBeforeDate`, keeping its place in the queue. */
  async delay(task: Task, notBeforeDate: Date): Promise<void> {
    await this.taskRepository.update({ id: task.id, status: TaskStatus.QUEUED }, { notBeforeDate });

    task.notBeforeDate = notBeforeDate;
  }

  /** Stores how the run ended before it is judged, so a restart mid-judgement can judge it again. */
  async recordReport(run: Run, report: IRunReport): Promise<void> {
    const endDate = new Date();

    const { exitCode, result, error } = report;
    const fields = {
      endDate,
      exitCode,
      result,
      error,
      deploymentFault: report.deploymentFault ?? null,
      endReason: report.endReason ?? null,
      turns: report.usage?.turns ?? null,
      inputTokens: report.usage?.inputTokens ?? null,
      outputTokens: report.usage?.outputTokens ?? null,
      cacheReadTokens: report.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: report.usage?.cacheWriteTokens ?? null,
      costUsd: report.usage?.costUsd ?? null,
    };

    await this.runRepository.update({ id: run.id }, fields);

    Object.assign(run, fields);
  }

  /** Frees the task's slot. Sets the fields it writes. */
  @Transactional()
  async finishRun(task: Task, run: Run, judgement: IRunJudgement, next: TaskNext): Promise<void> {
    const { outcome, error, deploymentFault } = judgement;
    const endReason = runEndReasonOf(judgement, run.endReason);

    await this.runRepository.update({ id: run.id }, { outcome, error, deploymentFault, endReason });

    Object.assign(run, { outcome, error, deploymentFault, endReason });

    if (next.status === TaskStatus.QUEUED) {
      const { list, step, notBeforeDate } = next;

      await this.taskRepository.update({ id: task.id }, { status: TaskStatus.QUEUED, list, step, notBeforeDate });

      task.status = TaskStatus.QUEUED;
      task.list = list;
      task.step = step;
      task.notBeforeDate = notBeforeDate;

      return;
    }

    const endDate = new Date();

    await this.taskRepository.update({ id: task.id }, { status: next.status, endDate });

    task.status = next.status;
    task.endDate = endDate;
  }

  /**
   * Deletes a run whose agent never started and queues its task again, so run numbers count only executions and the
   * retry count needs no filter. A task left with no run is unpinned, so its first run starts on the running revision.
   */
  @Transactional()
  async releaseRun(task: Task, run: Run): Promise<void> {
    await this.runRepository.delete({ id: run.id });

    const configId = (await this.countRuns(task.id)) === 0 ? null : task.configId;

    await this.taskRepository.update(
      { id: task.id, status: TaskStatus.RUNNING },
      { status: TaskStatus.QUEUED, configId }
    );

    task.status = TaskStatus.QUEUED;
    task.configId = configId;
  }

  /** Ends a task queued for its `failureSteps` without running the rest. Returns false when it was no longer queued. */
  async endFailed(task: Task): Promise<boolean> {
    const endDate = new Date();
    const ended = await this.taskRepository.update(
      { id: task.id, status: TaskStatus.QUEUED },
      { status: TaskStatus.FAILED, endDate }
    );

    if (ended.affected !== 1) {
      return false;
    }

    task.status = TaskStatus.FAILED;
    task.endDate = endDate;

    return true;
  }

  async findRunning(): Promise<IRunningTask[]> {
    const tasks = await this.taskRepository.find({ where: { status: TaskStatus.RUNNING }, order: { id: 'ASC' } });

    return Promise.all(
      tasks.map(async task => ({
        task,
        run: await this.findCurrentRun(task),
      }))
    );
  }

  /** Puts a running task that has no run back in the queue, keeping its place, and unpins it. */
  async release(task: Task): Promise<void> {
    await this.taskRepository.update(
      { id: task.id, status: TaskStatus.RUNNING },
      { status: TaskStatus.QUEUED, configId: null }
    );

    task.status = TaskStatus.QUEUED;
    task.configId = null;
  }

  /** The revisions that unfinished tasks are pinned to. */
  async findPinnedConfigIds(): Promise<Set<number>> {
    const rows = await this.taskRepository
      .createQueryBuilder('task')
      .select('task.configId', 'configId')
      .distinct()
      .where('task.status IN (:...statuses)', { statuses: [TaskStatus.QUEUED, TaskStatus.RUNNING] })
      .andWhere('task.configId IS NOT NULL')
      .getRawMany<{ configId: number }>();

    return new Set(rows.map(row => row.configId));
  }

  /** Sets `run.containerId`. */
  async setContainerId(run: Run, containerId: string): Promise<void> {
    await this.runRepository.update({ id: run.id }, { containerId });

    run.containerId = containerId;
  }

  /** One statement, so a batch lands whole or not at all. */
  async appendTranscriptLines(lines: RunTranscriptLine[]): Promise<void> {
    if (lines.length > 0) {
      await this.runTranscriptLineRepository.insert(lines);
    }
  }

  /** Lines are numbered from 1 without gaps, so the highest number is the count. */
  async countTranscriptLines(runId: number): Promise<number> {
    return (await this.runTranscriptLineRepository.maximum('lineNumber', { runId })) ?? 0;
  }

  /**
   * The run's last `count` assistant events of the main agent, newest first. A subagent's event carries a string
   * `parent_tool_use_id`. JSON escapes the quotes of either pattern inside a string, so quoted text never matches.
   */
  async findAssistantLines(runId: number, count: number): Promise<string[]> {
    const lines = await this.runTranscriptLineRepository.find({
      where: { runId, line: And(Like('%"type":"assistant"%'), Not(Like('%"parent_tool_use_id":"%'))) },
      order: { lineNumber: 'DESC' },
      take: count,
    });

    return lines.map(line => line.line);
  }

  /** Throws when the task is not of the trigger's kind, which the pre-start check rules out. */
  async promptContext(trigger: ITriggerConfig, task: Task, run: Run): Promise<IPromptContext> {
    const shared = {
      project: { path: task.projectPath, url: task.projectUrl },
      trigger: { name: task.triggerName },
      task: { id: task.id },
      run: { id: run.id },
    };

    const kind = triggerKindOf(trigger);
    const issue =
      task.issueIid !== null && task.issueTitle !== null && task.issueUrl !== null
        ? { iid: task.issueIid, title: task.issueTitle, url: task.issueUrl }
        : undefined;

    if (kind === 'schedule' && task.fireTime !== null && task.cron !== null) {
      return { ...shared, schedule: await this.scheduleContext(task.cron, task, run, task.fireTime) };
    }

    if (kind === 'mergeRequest' && taskKindOf(task) === 'mergeRequest') {
      return { ...shared, mergeRequest: this.mergeRequestContext(task), ...(issue === undefined ? {} : { issue }) };
    }

    if (kind === 'issue' && taskKindOf(task) === 'issue' && issue !== undefined) {
      return { ...shared, issue };
    }

    throw new Error(`promptContext(): Task ${task.id} is not of the kind trigger ${trigger.name} fires`);
  }

  private async nextTry(taskId: number, list: StepList, step: number): Promise<number> {
    const latest = await this.runRepository.maximum('number', { taskId, list, step });

    return (latest ?? 0) + 1;
  }

  private mergeRequestContext(task: Task): IMergeRequestContext {
    const { mergeRequestIid, mergeRequestTitle, mergeRequestUrl, sourceBranch, targetBranch } = task;

    if (
      mergeRequestIid === null ||
      mergeRequestTitle === null ||
      mergeRequestUrl === null ||
      sourceBranch === null ||
      targetBranch === null
    ) {
      throw new Error(`mergeRequestContext(): Task ${task.id} has no merge request`);
    }

    return { iid: mergeRequestIid, title: mergeRequestTitle, url: mergeRequestUrl, sourceBranch, targetBranch };
  }

  /**
   * Each `last*` time comes from the runs of the same step of the same list among the trigger's tasks with an earlier fire time, so a
   * retry sees what its first run saw.
   */
  private async scheduleContext(cron: string, task: Task, run: Run, fireTime: Date): Promise<IScheduleContext> {
    const [lastRun, lastSuccess, lastFailure] = await Promise.all([
      this.findEarlierRun(task, run, fireTime, 'startDate', null),
      this.findEarlierRun(task, run, fireTime, 'endDate', RunOutcome.SUCCEEDED),
      this.findEarlierRun(task, run, fireTime, 'endDate', RunOutcome.FAILED),
    ]);

    return {
      fireTime: fireTime.toISOString(),
      previousFireTime: fireTimeBefore(cron, fireTime).toISOString(),
      nextFireTime: fireTimeAfter(cron, fireTime).toISOString(),
      lastRunStart: lastRun?.startDate.toISOString() ?? '',
      lastSuccessEnd: lastSuccess?.endDate?.toISOString() ?? '',
      lastFailureEnd: lastFailure?.endDate?.toISOString() ?? '',
    };
  }

  /** A null `outcome` takes any run. */
  private findEarlierRun(
    task: Task,
    { list, step }: Run,
    fireTime: Date,
    column: 'startDate' | 'endDate',
    outcome: RunOutcome | null
  ): Promise<Run | null> {
    const query = this.runRepository
      .createQueryBuilder('run')
      .innerJoin('run.task', 'task')
      .where('task.triggerName = :triggerName', { triggerName: task.triggerName })
      .andWhere('task.fireTime < :fireTime', { fireTime })
      .andWhere('run.list = :list', { list })
      .andWhere('run.step = :step', { step });

    if (outcome !== null) {
      query.andWhere('run.outcome = :outcome', { outcome });
    }

    return query.orderBy(`run.${column}`, 'DESC', 'NULLS LAST').getOne();
  }

  private async insertOrIgnore(task: Task): Promise<Task | null> {
    // `repository.insert()` has no ON CONFLICT DO NOTHING, and a caught unique violation would log in Postgres.
    const result = await this.taskRepository.createQueryBuilder().insert().into(Task).values(task).orIgnore().execute();

    // Postgres returns the inserted rows, so a skipped insert returns none.
    const inserted: unknown = result.raw;

    return Array.isArray(inserted) && inserted.length > 0 ? task : null;
  }
}
