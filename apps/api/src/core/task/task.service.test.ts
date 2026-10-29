import type { Repository } from 'typeorm';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { RunTranscriptLine } from './entities/run-transcript-line.entity';
import { Run } from './entities/run.entity';
import { Task } from './entities/task.entity';

import { TaskService } from './task.service';

import { DeploymentFault, RunEndReason, RunOutcome, StepList, TaskStatus } from './task.types';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import type { IIssueChange, IIssueEvent, IMergeRequestEvent } from '@/core/issue-source/issue-source.types';

vi.mock('typeorm-transactional', () => {
  const transactionalDecorator = () => () => undefined;
  return { Transactional: transactionalDecorator };
});

const event: IIssueEvent = {
  source: 'gitlab',
  project: { id: 7, path: 'group/project', url: 'https://gitlab.test/group/project' },
  issue: {
    iid: 3,
    title: 'Fix it',
    url: 'https://gitlab.test/i/3',
    labels: ['workflow::ready'],
    author: 'ada',
    assignees: ['swarmfoundry-bot'],
    updatedAt: new Date(),
  },
  labelEvents: [],
  assignments: [],
};

const change: IIssueChange = {
  kind: 'assignment',
  id: 42,
  createdAt: new Date('2026-10-14T10:00:00.000Z'),
  actor: 'ada',
};

const queuedTask = (): Task => {
  const task = new Task({
    triggerName: 'implement',
    sourceName: 'gitlab',
    projectId: 7,
    projectPath: 'group/project',
    projectUrl: 'https://gitlab.test/group/project',
    issueIid: 3,
    issueTitle: 'Fix it',
    issueUrl: 'https://gitlab.test/i/3',
    matchedIssue: null,
    change,
    fireTime: null,
    cron: null,
    mergeRequest: null,
    queuedDate: new Date(),
  });

  task.id = 5;

  return task;
};

const FIRE_TIME = new Date('2026-10-19T09:00:00.000Z');

const scheduledTask = (): Task => {
  const task = new Task({
    triggerName: 'friction',
    sourceName: 'gitlab',
    projectId: null,
    projectPath: 'group/project',
    projectUrl: 'https://gitlab.test/group/project',
    issueIid: null,
    issueTitle: null,
    issueUrl: null,
    matchedIssue: null,
    change: null,
    fireTime: FIRE_TIME,
    cron: '0 9 * * 1',
    mergeRequest: null,
    queuedDate: new Date(),
  });

  task.id = 6;

  return task;
};

const labelTrigger = { name: 'implement', issue: { labels: ['workflow::in-progress'] } } as unknown as ITriggerConfig;
const scheduledTrigger = {
  name: 'friction',
  schedule: { cron: '0 9 * * 1', project: 'group/project' },
} as unknown as ITriggerConfig;

const mergeRequestTrigger = {
  name: 'merged',
  mergeRequest: { event: 'merged', labels: [], notLabels: [], projects: [] },
} as unknown as ITriggerConfig;

const mergeRequestEvent: IMergeRequestEvent = {
  source: 'gitlab',
  project: event.project,
  event: 'merged',
  mergeRequest: {
    iid: 5,
    title: 'Fix it (#3)',
    url: 'https://gitlab.test/mr/5',
    sourceBranch: '3-fix-it',
    targetBranch: 'master',
    labels: ['backend'],
  },
  relatedIssue: { iid: 3, title: 'Fix it', url: 'https://gitlab.test/i/3' },
};

const firstRun = (): Run => {
  const run = new Run({
    taskId: 5,
    number: 1,
    list: StepList.STEPS,
    step: 0,
    startDate: new Date(),
    configId: null,
    agent: null,
  });
  run.id = 9;

  return run;
};

describe('TaskService', () => {
  let insertResult: { raw: unknown };
  let taskRepository: {
    createQueryBuilder: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let runRepository: {
    count: ReturnType<typeof vi.fn>;
    maximum: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    createQueryBuilder: ReturnType<typeof vi.fn>;
  };
  let earlierRun: Mock<() => Promise<Run | null>>;
  let runTranscriptLineRepository: { insert: ReturnType<typeof vi.fn> };
  let values: Mock<(task: Task) => void>;
  let service: TaskService;

  beforeEach(() => {
    insertResult = { raw: [{ id: 5 }] };
    values = vi.fn<(task: Task) => void>();

    const insertQuery = {
      insert: () => insertQuery,
      into: () => insertQuery,
      values: (task: Task) => {
        values(task);

        return insertQuery;
      },
      orIgnore: () => insertQuery,
      execute: () => Promise.resolve(insertResult),
    };

    earlierRun = vi.fn<() => Promise<Run | null>>().mockResolvedValue(null);

    const runQuery = {
      innerJoin: () => runQuery,
      where: () => runQuery,
      andWhere: () => runQuery,
      orderBy: () => runQuery,
      getOne: earlierRun,
    };

    taskRepository = {
      createQueryBuilder: vi.fn(() => insertQuery),
      findOne: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
    };
    runRepository = {
      count: vi.fn().mockResolvedValue(0),
      maximum: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      createQueryBuilder: vi.fn(() => runQuery),
    };

    runTranscriptLineRepository = { insert: vi.fn().mockResolvedValue(undefined) };

    service = new TaskService(
      taskRepository as unknown as Repository<Task>,
      runRepository as unknown as Repository<Run>,
      runTranscriptLineRepository as unknown as Repository<RunTranscriptLine>
    );
  });

  describe('enqueue', () => {
    it('queues a task keyed on the trigger, the issue and the change, with the issue as it matched', async () => {
      const task = await service.enqueue('implement', event, change);

      expect(task).toMatchObject({
        triggerName: 'implement',
        sourceName: 'gitlab',
        projectId: 7,
        issueIid: 3,
        issueLabels: ['workflow::ready'],
        issueAuthor: 'ada',
        issueAssignees: ['swarmfoundry-bot'],
        changeKind: 'assignment',
        changeId: 42,
        changeDate: new Date('2026-10-14T10:00:00.000Z'),
        changeActor: 'ada',
        fireTime: null,
        cron: null,
        status: TaskStatus.QUEUED,
      });
      expect(values).toHaveBeenCalledWith(task);
    });

    it('returns null when the change already has a task', async () => {
      insertResult = { raw: [] };

      await expect(service.enqueue('implement', event, change)).resolves.toBeNull();
    });
  });

  describe('startRun', () => {
    it('claims the queued task and starts the first try of its step', async () => {
      const task = queuedTask();

      const run = await service.startRun(task, 11, { name: 'claude', model: 'claude-opus-5-5', auth: 'oauth' });

      expect(taskRepository.update).toHaveBeenCalledWith(
        { id: 5, status: TaskStatus.QUEUED },
        { status: TaskStatus.RUNNING, configId: 11 }
      );
      expect(runRepository.maximum).toHaveBeenCalledWith('number', { taskId: 5, list: StepList.STEPS, step: 0 });
      expect(run).toMatchObject({
        taskId: 5,
        number: 1,
        step: 0,
        configId: 11,
        agentName: 'claude',
        agentModel: 'claude-opus-5-5',
        agentAuth: 'oauth',
      });
      expect(task).toMatchObject({ status: TaskStatus.RUNNING, configId: 11 });
      expect(runRepository.insert).toHaveBeenCalledExactlyOnceWith(run);
    });

    it("counts tries per step, so a later step's first run is its try 1", async () => {
      const task = queuedTask();
      task.step = 1;

      const run = await service.startRun(task, 11, null);

      expect(runRepository.maximum).toHaveBeenCalledWith('number', { taskId: 5, list: StepList.STEPS, step: 1 });
      expect(run).toMatchObject({ number: 1, step: 1 });
    });

    it('starts a retry as the next try of the same step, recording no other run', async () => {
      runRepository.maximum.mockResolvedValue(2);
      const task = queuedTask();
      task.step = 2;

      const run = await service.startRun(task, 11, null);

      expect(run).toMatchObject({ number: 3, step: 2 });
      expect(runRepository.insert).toHaveBeenCalledExactlyOnceWith(run);
    });

    it('keeps a pinned task on its revision', async () => {
      const task = queuedTask();
      task.configId = 12;

      const run = await service.startRun(task, 11, null);

      expect(taskRepository.update).toHaveBeenCalledWith(
        { id: 5, status: TaskStatus.QUEUED },
        { status: TaskStatus.RUNNING, configId: 12 }
      );
      expect(run?.configId).toBe(12);
    });

    it('starts nothing when the task was no longer queued', async () => {
      taskRepository.update.mockResolvedValue({ affected: 0 });

      await expect(service.startRun(queuedTask(), null, null)).resolves.toBeNull();
      expect(runRepository.insert).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('ends a queued task with its reason', async () => {
      const task = queuedTask();

      await expect(service.cancel(task, 'The issue is closed')).resolves.toBe(true);

      expect(taskRepository.update).toHaveBeenCalledWith(
        { id: 5, status: TaskStatus.QUEUED },
        expect.objectContaining({ status: TaskStatus.CANCELLED, cancelReason: 'The issue is closed' })
      );
      expect(task).toMatchObject({ status: TaskStatus.CANCELLED, cancelReason: 'The issue is closed' });
    });

    it('leaves a task no longer queued alone', async () => {
      taskRepository.update.mockResolvedValue({ affected: 0 });
      const task = queuedTask();

      await expect(service.cancel(task, 'The issue is closed')).resolves.toBe(false);
      expect(task.status).toBe(TaskStatus.QUEUED);
    });
  });

  it('stores the report on the run before it is judged', async () => {
    const run = firstRun();

    await service.recordReport(run, { exitCode: 0, result: '{}', error: null });

    expect(runRepository.update).toHaveBeenCalledWith(
      { id: 9 },
      expect.objectContaining({
        exitCode: 0,
        result: '{}',
        error: null,
        deploymentFault: null,
        endReason: null,
        turns: null,
        inputTokens: null,
        costUsd: null,
        endDate: expect.any(Date) as Date,
      })
    );
    expect(run.outcome).toBeNull();
  });

  it("stores an agent's usage and the runner's end reason with the report", async () => {
    const run = firstRun();
    const usage = {
      turns: 12,
      inputTokens: 40,
      outputTokens: 3000,
      cacheReadTokens: 900_000,
      cacheWriteTokens: 25_000,
      costUsd: 1.234567,
    };

    await service.recordReport(run, {
      exitCode: null,
      result: '{"type":"result"}',
      error: 'Timed out after 2 hours, stopped with SIGINT',
      endReason: RunEndReason.TIMEOUT,
      usage,
    });

    expect(runRepository.update).toHaveBeenCalledWith(
      { id: 9 },
      expect.objectContaining({ ...usage, endReason: RunEndReason.TIMEOUT })
    );
    expect(run).toMatchObject({ ...usage, endReason: RunEndReason.TIMEOUT });
  });

  it("stores the runner's deployment fault with the report, so a restart judges it the same", async () => {
    const run = firstRun();

    await service.recordReport(run, {
      exitCode: null,
      result: null,
      error: 'pull failed',
      deploymentFault: DeploymentFault.TRANSIENT,
    });

    expect(runRepository.update).toHaveBeenCalledWith(
      { id: 9 },
      expect.objectContaining({ error: 'pull failed', deploymentFault: DeploymentFault.TRANSIENT })
    );
    expect(run.deploymentFault).toBe(DeploymentFault.TRANSIENT);
  });

  describe('releaseRun', () => {
    it('deletes a run that never started and queues its task again, unpinned when it has no other run', async () => {
      const task = queuedTask();
      task.status = TaskStatus.RUNNING;
      task.configId = 11;

      await service.releaseRun(task, firstRun());

      expect(runRepository.delete).toHaveBeenCalledWith({ id: 9 });
      expect(taskRepository.update).toHaveBeenCalledWith(
        { id: 5, status: TaskStatus.RUNNING },
        { status: TaskStatus.QUEUED, configId: null }
      );
      expect(task).toMatchObject({ status: TaskStatus.QUEUED, configId: null });
    });

    it('keeps the pin of a task with an earlier run', async () => {
      runRepository.count.mockResolvedValue(1);
      const task = queuedTask();
      task.status = TaskStatus.RUNNING;
      task.configId = 11;

      await service.releaseRun(task, firstRun());

      expect(taskRepository.update).toHaveBeenCalledWith(
        { id: 5, status: TaskStatus.RUNNING },
        { status: TaskStatus.QUEUED, configId: 11 }
      );
    });
  });

  describe('finishRun', () => {
    it.each([
      ['a success', RunOutcome.SUCCEEDED, null, null, RunEndReason.SUCCESS],
      ["the step's own failure", RunOutcome.FAILED, null, null, RunEndReason.ERROR],
      ['a deployment fault', RunOutcome.FAILED, DeploymentFault.PERMANENT, null, RunEndReason.RUNNER_ERROR],
      ["the runner's timeout", RunOutcome.FAILED, null, RunEndReason.TIMEOUT, RunEndReason.TIMEOUT],
      ["the runner's own error", RunOutcome.FAILED, null, RunEndReason.RUNNER_ERROR, RunEndReason.RUNNER_ERROR],
    ] as const)('stores %s as its end reason', async (_case, outcome, deploymentFault, reported, endReason) => {
      const run = firstRun();
      run.endReason = reported;

      await service.finishRun(
        queuedTask(),
        run,
        { outcome, error: null, deploymentFault },
        { status: TaskStatus.FAILED }
      );

      expect(runRepository.update).toHaveBeenCalledWith({ id: 9 }, expect.objectContaining({ endReason }));
      expect(run.endReason).toBe(endReason);
    });

    it("stores the engine's own failure of a run, such as an issue it could not read, as a runner error", async () => {
      const run = firstRun();
      const judgement = {
        outcome: RunOutcome.FAILED,
        error: "Failed to read the issue's labels to judge the run: GitLab answered 503",
        deploymentFault: null,
        endReason: RunEndReason.RUNNER_ERROR,
      } as const;

      await service.finishRun(queuedTask(), run, judgement, { status: TaskStatus.FAILED });

      expect(run.endReason).toBe(RunEndReason.RUNNER_ERROR);
    });

    it.each([
      [RunOutcome.SUCCEEDED, TaskStatus.SUCCEEDED],
      [RunOutcome.FAILED, TaskStatus.FAILED],
    ] as const)('ends a task whose run %s as %s', async (outcome, status) => {
      const task = queuedTask();

      await service.finishRun(task, firstRun(), { outcome, error: null, deploymentFault: null }, { status });

      expect(runRepository.update).toHaveBeenCalledWith({ id: 9 }, expect.objectContaining({ outcome, error: null }));
      expect(taskRepository.update).toHaveBeenCalledWith({ id: 5 }, expect.objectContaining({ status }));
      expect(task.status).toBe(status);
      expect(task.endDate).toBeInstanceOf(Date);
    });

    it('queues a task to retry, keeping its queued date', async () => {
      const task = queuedTask();
      const queuedDate = task.queuedDate;
      const notBeforeDate = new Date(Date.now() + 60_000);

      await service.finishRun(
        task,
        firstRun(),
        { outcome: RunOutcome.FAILED, error: 'pull failed', deploymentFault: DeploymentFault.TRANSIENT },
        { status: TaskStatus.QUEUED, list: StepList.STEPS, step: 0, notBeforeDate }
      );

      expect(runRepository.update).toHaveBeenCalledWith(
        { id: 9 },
        {
          outcome: RunOutcome.FAILED,
          error: 'pull failed',
          deploymentFault: DeploymentFault.TRANSIENT,
          endReason: RunEndReason.RUNNER_ERROR,
        }
      );

      expect(taskRepository.update).toHaveBeenCalledWith(
        { id: 5 },
        { status: TaskStatus.QUEUED, list: StepList.STEPS, step: 0, notBeforeDate }
      );
      expect(task).toMatchObject({ status: TaskStatus.QUEUED, notBeforeDate, queuedDate, endDate: null });
    });

    it('queues a task for its next step at once', async () => {
      const task = queuedTask();

      await service.finishRun(
        task,
        firstRun(),
        { outcome: RunOutcome.SUCCEEDED, error: null, deploymentFault: null },
        { status: TaskStatus.QUEUED, list: StepList.STEPS, step: 1, notBeforeDate: null }
      );

      expect(taskRepository.update).toHaveBeenCalledWith(
        { id: 5 },
        { status: TaskStatus.QUEUED, list: StepList.STEPS, step: 1, notBeforeDate: null }
      );
      expect(task).toMatchObject({ status: TaskStatus.QUEUED, step: 1, notBeforeDate: null, endDate: null });
    });

    it('queues a task that failed for good for the first of its failureSteps', async () => {
      const task = queuedTask();

      await service.finishRun(
        task,
        firstRun(),
        { outcome: RunOutcome.FAILED, error: 'exit 1', deploymentFault: null },
        { status: TaskStatus.QUEUED, list: StepList.FAILURE_STEPS, step: 0, notBeforeDate: null }
      );

      expect(task).toMatchObject({ status: TaskStatus.QUEUED, list: StepList.FAILURE_STEPS, step: 0, endDate: null });
    });
  });

  describe('endFailed', () => {
    it('ends a queued task failed', async () => {
      const task = queuedTask();

      await expect(service.endFailed(task)).resolves.toBe(true);

      expect(taskRepository.update).toHaveBeenCalledWith(
        { id: 5, status: TaskStatus.QUEUED },
        { status: TaskStatus.FAILED, endDate: task.endDate }
      );
      expect(task.status).toBe(TaskStatus.FAILED);
      expect(task.endDate).toBeInstanceOf(Date);
    });

    it('leaves a task no longer queued alone', async () => {
      const task = queuedTask();
      taskRepository.update.mockResolvedValueOnce({ affected: 0 });

      await expect(service.endFailed(task)).resolves.toBe(false);
      expect(task.status).toBe(TaskStatus.QUEUED);
    });
  });

  it("starts a failure step's run in the task's list", async () => {
    const task = queuedTask();
    task.list = StepList.FAILURE_STEPS;

    const run = await service.startRun(task, null, null);

    expect(runRepository.maximum).toHaveBeenCalledWith('number', { taskId: 5, list: StepList.FAILURE_STEPS, step: 0 });
    expect(run).toMatchObject({ list: StepList.FAILURE_STEPS, step: 0, number: 1 });
  });

  it('records the container on the run', async () => {
    const run = firstRun();

    await service.setContainerId(run, 'abc123');

    expect(runRepository.update).toHaveBeenCalledWith({ id: 9 }, { containerId: 'abc123' });
    expect(run.containerId).toBe('abc123');
  });

  describe('appendTranscriptLines', () => {
    it('inserts a batch in one statement', async () => {
      const lines = [
        new RunTranscriptLine({ runId: 9, lineNumber: 1, line: '{}' }),
        new RunTranscriptLine({ runId: 9, lineNumber: 2, line: '{}' }),
      ];

      await service.appendTranscriptLines(lines);

      expect(runTranscriptLineRepository.insert).toHaveBeenCalledExactlyOnceWith(lines);
    });

    it('skips an empty batch', async () => {
      await service.appendTranscriptLines([]);

      expect(runTranscriptLineRepository.insert).not.toHaveBeenCalled();
    });
  });

  it('builds the prompt context from the task, with the task and run ids', async () => {
    expect(await service.promptContext(labelTrigger, queuedTask(), firstRun())).toEqual({
      issue: { iid: 3, title: 'Fix it', url: 'https://gitlab.test/i/3' },
      project: { path: 'group/project', url: 'https://gitlab.test/group/project' },
      trigger: { name: 'implement' },
      task: { id: 5 },
      run: { id: 9 },
    });
  });

  it("gives a scheduled task its own cron's fire times either side of its own", async () => {
    expect(await service.promptContext(scheduledTrigger, scheduledTask(), firstRun())).toMatchObject({
      schedule: {
        fireTime: '2026-10-19T09:00:00.000Z',
        previousFireTime: '2026-10-12T09:00:00.000Z',
        nextFireTime: '2026-10-26T09:00:00.000Z',
      },
      project: { path: 'group/project', url: 'https://gitlab.test/group/project' },
      trigger: { name: 'friction' },
      task: { id: 6 },
      run: { id: 9 },
    });
  });

  it('keeps the cron the task was queued by after the trigger changes its cron', async () => {
    const changed = { name: 'friction', schedule: { cron: '0 12 * * *', project: 'group/project' } } as ITriggerConfig;

    expect(await service.promptContext(changed, scheduledTask(), firstRun())).toMatchObject({
      schedule: { previousFireTime: '2026-10-12T09:00:00.000Z', nextFireTime: '2026-10-26T09:00:00.000Z' },
    });
  });

  it("refuses a task that is not of its trigger's kind", async () => {
    await expect(service.promptContext(scheduledTrigger, queuedTask(), firstRun())).rejects.toThrow(/not of the kind/);
    await expect(service.promptContext(labelTrigger, scheduledTask(), firstRun())).rejects.toThrow(/not of the kind/);
  });

  describe('enqueueScheduled', () => {
    it('queues a task with the fire time and its cron, and no issue', async () => {
      const task = await service.enqueueScheduled({
        triggerName: 'friction',
        sourceName: 'gitlab',
        projectPath: 'group/project',
        projectUrl: 'https://gitlab.test/group/project',
        fireTime: FIRE_TIME,
        cron: '0 9 * * 1',
      });

      expect(task).toMatchObject({
        triggerName: 'friction',
        fireTime: FIRE_TIME,
        cron: '0 9 * * 1',
        projectId: null,
        issueIid: null,
        issueLabels: null,
        issueAuthor: null,
        issueAssignees: null,
        changeId: null,
        status: TaskStatus.QUEUED,
      });
      expect(values).toHaveBeenCalledWith(task);
    });
  });

  it('finds no newer task for a scheduled task, which has no issue change', async () => {
    expect(await service.findNewer(scheduledTask())).toBeNull();
    expect(taskRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  describe('enqueueMergeRequest', () => {
    it('queues a task keyed on the merge request and its event, with its related issue and no issue change', async () => {
      const task = await service.enqueueMergeRequest('merged', mergeRequestEvent);

      expect(task).toMatchObject({
        triggerName: 'merged',
        sourceName: 'gitlab',
        projectId: 7,
        projectPath: 'group/project',
        projectUrl: 'https://gitlab.test/group/project',
        issueIid: 3,
        issueTitle: 'Fix it',
        issueUrl: 'https://gitlab.test/i/3',
        issueLabels: null,
        issueAuthor: null,
        issueAssignees: null,
        changeKind: null,
        changeId: null,
        changeDate: null,
        changeActor: null,
        fireTime: null,
        mergeRequestIid: 5,
        mergeRequestEvent: 'merged',
        mergeRequestTitle: 'Fix it (#3)',
        mergeRequestUrl: 'https://gitlab.test/mr/5',
        sourceBranch: '3-fix-it',
        targetBranch: 'master',
        status: TaskStatus.QUEUED,
      });
      expect(values).toHaveBeenCalledWith(task);
    });

    it('queues one with no issue when the merge request relates to none', async () => {
      const task = await service.enqueueMergeRequest('merged', { ...mergeRequestEvent, relatedIssue: null });

      expect(task).toMatchObject({ issueIid: null, issueTitle: null, issueUrl: null, mergeRequestIid: 5 });
    });
  });

  describe('promptContext for a merge request task', () => {
    const mergeRequestTask = async (relatedIssue = mergeRequestEvent.relatedIssue) => {
      const task = await service.enqueueMergeRequest('merged', { ...mergeRequestEvent, relatedIssue });

      if (task === null) {
        throw new Error('Expected a task');
      }

      task.id = 8;

      return task;
    };

    it('gives the merge request and its related issue', async () => {
      expect(await service.promptContext(mergeRequestTrigger, await mergeRequestTask(), firstRun())).toEqual({
        mergeRequest: {
          iid: 5,
          title: 'Fix it (#3)',
          url: 'https://gitlab.test/mr/5',
          sourceBranch: '3-fix-it',
          targetBranch: 'master',
        },
        issue: { iid: 3, title: 'Fix it', url: 'https://gitlab.test/i/3' },
        project: { path: 'group/project', url: 'https://gitlab.test/group/project' },
        trigger: { name: 'merged' },
        task: { id: 8 },
        run: { id: 9 },
      });
    });

    it('leaves the issue out when the merge request relates to none', async () => {
      const context = await service.promptContext(mergeRequestTrigger, await mergeRequestTask(null), firstRun());

      expect(context.mergeRequest?.iid).toBe(5);
      expect(context).not.toHaveProperty('issue');
    });

    it("refuses a task that is not of its trigger's kind", async () => {
      const task = await mergeRequestTask();

      await expect(service.promptContext(labelTrigger, task, firstRun())).rejects.toThrow(/not of the kind/);
      await expect(service.promptContext(mergeRequestTrigger, queuedTask(), firstRun())).rejects.toThrow(
        /not of the kind/
      );
    });
  });
});
