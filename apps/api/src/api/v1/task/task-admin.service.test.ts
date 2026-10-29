import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RunEndReason, RunOutcome, StepList, TaskStatus, TranscriptEventType } from '@libs/dto';

import { ConfigRevision } from '@/core/foundry-config/entities/config-revision.entity';
import { Run } from '@/core/task/entities/run.entity';
import { Task } from '@/core/task/entities/task.entity';

import { TaskAdminService, TRANSCRIPT_PAGE_EVENTS, TRANSCRIPT_PAGE_LINES } from '@/api/v1/task/task-admin.service';
import { ConfigService } from '@/config/config.service';
import { TaskReadService, type IRunTotals } from '@/core/task/task-read.service';

import { ConfigRevisionStatus } from '@/core/foundry-config/foundry-config.types';

const PAGE_SIZE = 20;
const QUEUED = new Date('2026-10-26T09:00:00Z');
const STARTED = new Date('2026-10-26T09:01:00Z');

const config = (): ConfigRevision => {
  const revision = new ConfigRevision({
    sha: 'a41c9e2',
    status: ConfigRevisionStatus.LOADED,
    errors: [],
    seenDate: QUEUED,
  });
  revision.id = 3;

  return revision;
};

const fields = {
  triggerName: 'implement',
  sourceName: 'gitlab',
  projectId: 7,
  projectPath: 'group/project',
  projectUrl: 'https://gitlab.test/group/project',
  issueIid: null,
  issueTitle: null,
  issueUrl: null,
  matchedIssue: null,
  change: null,
  fireTime: null,
  cron: null,
  mergeRequest: null,
  queuedDate: QUEUED,
};

const issueTask = (): Task => {
  const task = new Task({
    ...fields,
    issueIid: 36,
    issueTitle: 'Read API',
    issueUrl: 'https://gitlab.test/i/36',
    matchedIssue: { labels: ['workflow::in-progress'], author: 'ada', assignees: ['swarmfoundry'] },
    change: { kind: 'label', id: 100, createdAt: QUEUED, actor: 'ada' },
  });

  task.id = 5;

  return task;
};

const scheduledTask = (): Task => {
  const task = new Task({ ...fields, projectId: null, fireTime: QUEUED, cron: '0 3 * * 1' });
  task.id = 6;

  return task;
};

const mergeRequestTask = (): Task => {
  const task = new Task({
    ...fields,
    mergeRequest: {
      iid: 118,
      event: 'merged',
      title: 'Fix it (#3)',
      url: 'https://gitlab.test/mr/118',
      sourceBranch: '36-read-api',
      targetBranch: 'master',
    },
  });

  task.id = 7;

  return task;
};

const agentRun = (): Run => {
  const run = new Run({
    taskId: 5,
    number: 2,
    list: StepList.STEPS,
    step: 1,
    startDate: STARTED,
    configId: 3,
    agent: { name: 'claude', model: 'claude-opus-5-5', auth: 'oauth' },
  });

  Object.assign(run, {
    id: 40,
    config: config(),
    outcome: RunOutcome.FAILED,
    endReason: RunEndReason.TIMEOUT,
    error: 'Timed out',
    turns: 12,
    inputTokens: 40,
    outputTokens: 3000,
    cacheReadTokens: 900000,
    cacheWriteTokens: 5000,
    costUsd: 1.23,
  });

  return run;
};

const totals: IRunTotals = { runCount: 2, startDate: STARTED, totalTokens: 908040, costUsd: 1.23 };
const noRuns: IRunTotals = { runCount: 0, startDate: null, totalTokens: null, costUsd: null };

describe('TaskAdminService', () => {
  let service: TaskAdminService;
  let taskReadService: {
    findTasks: ReturnType<typeof vi.fn>;
    findTaskWithThrow: ReturnType<typeof vi.fn>;
    findRunWithThrow: ReturnType<typeof vi.fn>;
    readTranscript: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    taskReadService = {
      findTasks: vi.fn().mockResolvedValue([[], 0]),
      findTaskWithThrow: vi.fn(),
      findRunWithThrow: vi.fn(),
      readTranscript: vi.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TaskAdminService,
        { provide: ConfigService, useValue: { pageSize: PAGE_SIZE } },
        { provide: TaskReadService, useValue: taskReadService },
      ],
    }).compile();

    service = moduleRef.get(TaskAdminService);
  });

  describe('getTaskList', () => {
    it('reads the page asked for with its filters, and counts the pages', async () => {
      taskReadService.findTasks.mockResolvedValue([[], 45]);

      const response = await service.getTaskList({
        page: 3,
        status: TaskStatus.FAILED,
        trigger: 'implement',
        project: 'group/project',
      });

      expect(taskReadService.findTasks).toHaveBeenCalledWith(
        { status: TaskStatus.FAILED, triggerName: 'implement', projectPath: 'group/project' },
        2 * PAGE_SIZE,
        PAGE_SIZE
      );
      expect(response).toEqual({ taskList: [], pages: 3, total: 45 });
    });

    it('shapes an issue task with its totals and config revision', async () => {
      const task = issueTask();
      Object.assign(task, { status: TaskStatus.RUNNING, step: 1, config: config() });
      taskReadService.findTasks.mockResolvedValue([[{ task, totals }], 1]);

      const response = await service.getTaskList({ page: 1 });

      expect(response.taskList).toEqual([
        {
          id: 5,
          kind: 'issue',
          triggerName: 'implement',
          sourceName: 'gitlab',
          projectPath: 'group/project',
          projectUrl: 'https://gitlab.test/group/project',
          issue: { iid: 36, title: 'Read API', url: 'https://gitlab.test/i/36' },
          mergeRequest: null,
          fireTime: null,
          status: TaskStatus.RUNNING,
          list: StepList.STEPS,
          step: 1,
          runCount: 2,
          totalTokens: 908040,
          costUsd: 1.23,
          configSha: 'a41c9e2',
          queuedDate: QUEUED,
          startDate: STARTED,
          endDate: null,
          notBeforeDate: null,
          cancelReason: null,
        },
      ]);
    });

    it('shapes a scheduled task, which has no issue, and a merge request task', async () => {
      taskReadService.findTasks.mockResolvedValue([
        [
          { task: scheduledTask(), totals: noRuns },
          { task: mergeRequestTask(), totals: noRuns },
        ],
        2,
      ]);

      const [scheduled, mergeRequest] = (await service.getTaskList({ page: 1 })).taskList;

      expect(scheduled).toMatchObject({ kind: 'schedule', issue: null, mergeRequest: null, fireTime: QUEUED });
      expect(scheduled).toMatchObject({ runCount: 0, totalTokens: null, costUsd: null, configSha: null });
      expect(mergeRequest).toMatchObject({
        kind: 'mergeRequest',
        issue: null,
        mergeRequest: {
          iid: 118,
          event: 'merged',
          title: 'Fix it (#3)',
          url: 'https://gitlab.test/mr/118',
          sourceBranch: '36-read-api',
          targetBranch: 'master',
        },
      });
    });
  });

  describe('getTask', () => {
    it('adds the issue as it matched, the change and the runs', async () => {
      const task = issueTask();
      task.runs = [agentRun()];
      taskReadService.findTaskWithThrow.mockResolvedValue({ task, totals });

      const response = await service.getTask(5);

      expect(taskReadService.findTaskWithThrow).toHaveBeenCalledWith(5);
      expect(response).toMatchObject({
        matchedIssue: { labels: ['workflow::in-progress'], author: 'ada', assignees: ['swarmfoundry'] },
        change: { kind: 'label', date: QUEUED, actor: 'ada' },
        cron: null,
      });
      expect(response.runs.map(run => run.id)).toEqual([40]);
    });

    it('leaves the match-time issue and change null for a task that kept none', async () => {
      taskReadService.findTaskWithThrow.mockResolvedValue({ task: scheduledTask(), totals: noRuns });

      const response = await service.getTask(6);

      expect(response).toMatchObject({ matchedIssue: null, change: null, cron: '0 3 * * 1', runs: [] });
    });
  });

  describe('getRun', () => {
    it("shapes an agent step's run", async () => {
      taskReadService.findRunWithThrow.mockResolvedValue(agentRun());

      await expect(service.getRun(40)).resolves.toEqual({
        id: 40,
        taskId: 5,
        list: StepList.STEPS,
        step: 1,
        number: 2,
        outcome: RunOutcome.FAILED,
        endReason: RunEndReason.TIMEOUT,
        exitCode: null,
        configSha: 'a41c9e2',
        startDate: STARTED,
        endDate: null,
        error: 'Timed out',
        agent: { name: 'claude', model: 'claude-opus-5-5', auth: 'oauth' },
        turns: 12,
        inputTokens: 40,
        outputTokens: 3000,
        cacheReadTokens: 900000,
        cacheWriteTokens: 5000,
        costUsd: 1.23,
      });
    });

    it("leaves a static step's agent and usage null", async () => {
      const run = new Run({
        taskId: 5,
        number: 1,
        list: StepList.FAILURE_STEPS,
        step: 0,
        startDate: STARTED,
        configId: null,
        agent: null,
      });
      run.id = 41;
      taskReadService.findRunWithThrow.mockResolvedValue(run);

      await expect(service.getRun(41)).resolves.toMatchObject({
        list: StepList.FAILURE_STEPS,
        agent: null,
        turns: null,
        costUsd: null,
        configSha: null,
      });
    });
  });

  describe('getTranscript', () => {
    it('reads a page from the line asked for, of the types asked for', async () => {
      const page = { events: [], nextLine: 4, hasMore: false };
      taskReadService.readTranscript.mockResolvedValue(page);

      const response = await service.getTranscript(40, { fromLine: 4, types: [TranscriptEventType.RESULT] });

      expect(taskReadService.readTranscript).toHaveBeenCalledWith(40, {
        fromLine: 4,
        types: [TranscriptEventType.RESULT],
        eventLimit: TRANSCRIPT_PAGE_EVENTS,
        lineLimit: TRANSCRIPT_PAGE_LINES,
      });
      expect(response).toBe(page);
    });
  });
});
