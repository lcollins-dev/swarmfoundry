import { describe, expect, it, vi } from 'vitest';

import { Task } from '@/core/task/entities/task.entity';

import { CHECK_LIMITS, TaskCheckService } from './task-check.service';
import { TriggerMatchService } from './trigger-match.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import type { IssueSourceService } from '@/core/issue-source/issue-source.service';
import type { TaskService } from '@/core/task/task.service';

import type {
  IIssueTriggerConfig,
  IMergeRequestTriggerConfig,
  IScheduleTriggerConfig,
} from '@/core/foundry-config/foundry-config.types';
import type { IIssueState } from '@/core/issue-source/issue-source.types';
import { StepList } from '@/core/task/task.types';

const TOKEN = 'glpat-orchestrator';

const trigger = {
  name: 'implement',
  source: { name: 'gitlab', type: 'gitlab', url: 'https://gitlab.test', token: TOKEN },
  issue: { labels: ['workflow::in-progress'], notLabels: ['foundry::failed'], anyAssignee: [], projects: [] },
} as unknown as IIssueTriggerConfig;

const assignedTrigger = {
  ...trigger,
  issue: {
    labels: ['workflow::ready'],
    notLabels: ['foundry::failed'],
    anyAssignee: ['swarmfoundry-bot'],
    projects: [],
  },
} as unknown as IIssueTriggerConfig;

const task = new Task({
  triggerName: 'implement',
  sourceName: 'gitlab',
  projectId: 7,
  projectPath: 'group/project',
  projectUrl: 'https://gitlab.test/group/project',
  issueIid: 3,
  issueTitle: 'Fix it',
  issueUrl: 'https://gitlab.test/group/project/-/issues/3',
  matchedIssue: null,
  change: { kind: 'label', id: 42, createdAt: new Date('2026-10-14T10:00:00Z'), actor: 'ada' },
  fireTime: null,
  cron: null,
  mergeRequest: null,
  queuedDate: new Date(),
});

const laterStep = Object.assign(Object.create(task) as Task, { step: 1 });

const scheduledTrigger = {
  name: 'friction',
  source: trigger.source,
  schedule: { cron: '0 9 * * 1', project: 'group/project' },
} as unknown as IScheduleTriggerConfig;

const scheduledTask = new Task({
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
  fireTime: new Date('2026-10-19T09:00:00Z'),
  cron: '0 9 * * 1',
  mergeRequest: null,
  queuedDate: new Date(),
});

const mergeRequestTrigger = {
  name: 'merged',
  source: trigger.source,
  mergeRequest: { event: 'merged', labels: [], notLabels: [], projects: [] },
} as unknown as IMergeRequestTriggerConfig;

const mergeRequestTask = new Task({
  triggerName: 'merged',
  sourceName: 'gitlab',
  projectId: 7,
  projectPath: 'group/project',
  projectUrl: 'https://gitlab.test/group/project',
  issueIid: 3,
  issueTitle: 'Fix it',
  issueUrl: 'https://gitlab.test/group/project/-/issues/3',
  matchedIssue: null,
  change: null,
  fireTime: null,
  cron: null,
  mergeRequest: {
    iid: 5,
    event: 'merged',
    title: 'Fix it (#3)',
    url: 'https://gitlab.test/group/project/-/merge_requests/5',
    sourceBranch: '3-fix-it',
    targetBranch: 'master',
  },
  queuedDate: new Date(),
});

const newerTask = { id: 9, changeId: 43 };

const checkWith = (
  readIssue: () => Promise<IIssueState | null>,
  runs = 0,
  newer: Pick<Task, 'id' | 'changeId'> | null = null
) => {
  const issueSourceService = { readIssue: vi.fn(readIssue) };
  const taskService = {
    countRuns: vi.fn().mockResolvedValue(runs),
    findNewer: vi.fn().mockResolvedValue(newer),
  };
  const foundryConfigService = {
    redactText: (text: string) => text.replaceAll(TOKEN, '[redacted]'),
  } as unknown as FoundryConfigService;

  const service = new TaskCheckService(
    foundryConfigService,
    issueSourceService as unknown as IssueSourceService,
    new TriggerMatchService(),
    taskService as unknown as TaskService
  );

  return { service, issueSourceService, taskService };
};

describe('TaskCheckService', () => {
  const signal = new AbortController().signal;

  it('starts a task whose issue is open and still matches', async () => {
    const { service, issueSourceService } = checkWith(() =>
      Promise.resolve({ open: true, labels: ['workflow::in-progress', 'type::bug'], assignees: [] })
    );

    await expect(service.check(trigger, task, signal)).resolves.toEqual({ kind: 'start' });
    expect(issueSourceService.readIssue).toHaveBeenCalledWith(trigger.source, 7, 3, signal, CHECK_LIMITS);
    expect(CHECK_LIMITS).toEqual({ timeoutMs: 10_000, rateLimitRetries: 0 });
  });

  it.each([
    ['a closed issue', { open: false, labels: ['workflow::in-progress'], assignees: [] }, 'The issue is closed'],
    [
      'an issue without the label',
      { open: true, labels: ['workflow::review'], assignees: [] },
      'The issue lacks workflow::in-progress',
    ],
    [
      'an issue with a blocking label',
      { open: true, labels: ['workflow::in-progress', 'foundry::failed'], assignees: [] },
      'The issue carries foundry::failed',
    ],
    ['a deleted issue', null, 'The issue no longer exists'],
  ])('cancels the first run of %s', async (_case, issue, reason) => {
    const { service } = checkWith(() => Promise.resolve(issue));

    await expect(service.check(trigger, task, signal)).resolves.toEqual({ kind: 'cancel', reason });
  });

  it('starts a failure step whatever the issue now is, reading nothing', async () => {
    const { service, issueSourceService } = checkWith(() => Promise.resolve(null));
    const failing = Object.assign(Object.create(task) as Task, { list: StepList.FAILURE_STEPS, step: 0 });

    await expect(service.check(trigger, failing, signal)).resolves.toEqual({ kind: 'start' });
    expect(issueSourceService.readIssue).not.toHaveBeenCalled();
  });

  it('cancels the first run of an issue without any listed assignee', async () => {
    const { service } = checkWith(() => Promise.resolve({ open: true, labels: ['workflow::ready'], assignees: [] }));

    await expect(service.check(assignedTrigger, task, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'The issue is not assigned to swarmfoundry-bot',
    });
  });

  describe('once the task has started', () => {
    const movedOn = { open: true, labels: ['workflow::review', 'foundry::failed'], assignees: ['ada'] };

    it.each([
      ['a retry of the first step', task, 1],
      ['a later step, or its retry', laterStep, 1],
    ])('starts %s after the bot was unassigned and a blocking label added', async (_case, started, runs) => {
      const { service } = checkWith(() => Promise.resolve(movedOn), runs);

      await expect(service.check(assignedTrigger, started, signal)).resolves.toEqual({ kind: 'start' });
      await expect(service.check(trigger, started, signal)).resolves.toEqual({ kind: 'start' });
    });

    it("reads the retry from the task's own runs", async () => {
      const { service, taskService } = checkWith(() => Promise.resolve(movedOn), 1);

      await service.check(assignedTrigger, task, signal);

      expect(taskService.countRuns).toHaveBeenCalledWith(task.id);
    });

    it.each([
      ['a closed issue', { ...movedOn, open: false }, 'The issue is closed'],
      ['a deleted issue', null, 'The issue no longer exists'],
    ])('cancels a retry or a later step of %s', async (_case, issue, reason) => {
      const { service } = checkWith(() => Promise.resolve(issue), 1);

      await expect(service.check(assignedTrigger, task, signal)).resolves.toEqual({ kind: 'cancel', reason });
      await expect(service.check(assignedTrigger, laterStep, signal)).resolves.toEqual({ kind: 'cancel', reason });
    });
  });

  it('cancels a task on a project the trigger no longer lists, without reading the issue', async () => {
    const { service, issueSourceService } = checkWith(() =>
      Promise.resolve({ open: true, labels: ['workflow::in-progress'], assignees: [] })
    );
    const scoped = { ...trigger, issue: { ...trigger.issue, projects: ['other/app'] } };

    await expect(service.check(scoped, task, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'The trigger no longer applies to project group/project',
    });
    expect(issueSourceService.readIssue).not.toHaveBeenCalled();
  });

  describe('with a newer task for the same issue', () => {
    const superseded = { kind: 'cancel', reason: 'Task 9 was queued for a later change on the issue' };
    const matching = { open: true, labels: ['workflow::in-progress'], assignees: ['swarmfoundry-bot'] };

    it.each([
      ['the first run', trigger, 0, task],
      ['a retry of a trigger with no anyAssignee', trigger, 1, task],
      ['a retry of a trigger with anyAssignee', assignedTrigger, 1, task],
      ['a later step', trigger, 1, laterStep],
    ])('cancels %s, though the issue still matches', async (_case, taskTrigger, runs, checked) => {
      const { service, issueSourceService, taskService } = checkWith(() => Promise.resolve(matching), runs, newerTask);

      await expect(service.check(taskTrigger, checked, signal)).resolves.toEqual(superseded);
      expect(taskService.findNewer).toHaveBeenCalledWith(checked);
      expect(issueSourceService.readIssue).not.toHaveBeenCalled();
    });

    it('cancels the task while the issue cannot be read', async () => {
      const { service } = checkWith(() => Promise.reject(new Error('connection reset')), 1, newerTask);

      await expect(service.check(trigger, task, signal)).resolves.toEqual(superseded);
    });
  });

  it('defers the task when the issue could not be read, with the error redacted', async () => {
    const { service } = checkWith(() => Promise.reject(new Error(`connection reset near ${TOKEN}`)));

    await expect(service.check(trigger, task, signal)).resolves.toEqual({
      kind: 'defer',
      error: 'connection reset near [redacted]',
    });
  });

  it('rejects once the signal aborts', async () => {
    const controller = new AbortController();
    const { service } = checkWith(() => {
      controller.abort();

      return Promise.reject(new Error('aborted'));
    });

    await expect(service.check(trigger, task, controller.signal)).rejects.toThrow();
  });
});

describe('TaskCheckService for a scheduled task', () => {
  const signal = new AbortController().signal;

  it('starts it without reading an issue or looking for a newer task', async () => {
    const { service, issueSourceService, taskService } = checkWith(() => Promise.resolve(null));

    await expect(service.check(scheduledTrigger, scheduledTask, signal)).resolves.toEqual({ kind: 'start' });
    expect(issueSourceService.readIssue).not.toHaveBeenCalled();
    expect(taskService.findNewer).not.toHaveBeenCalled();
  });

  it('cancels it once its trigger names another project', async () => {
    const { service } = checkWith(() => Promise.resolve(null));
    const moved = { ...scheduledTrigger, schedule: { ...scheduledTrigger.schedule, project: 'group/other' } };

    await expect(service.check(moved, scheduledTask, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'The trigger no longer applies to project group/project',
    });
  });

  it('cancels a task whose trigger changed kind under it', async () => {
    const { service, issueSourceService } = checkWith(() => Promise.resolve(null));
    const labelled = { ...trigger, name: 'friction' };

    await expect(service.check(labelled, scheduledTask, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'Trigger friction now starts on issue labels, not a schedule',
    });
    await expect(service.check(scheduledTrigger, task, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'Trigger friction now starts on a schedule, not issue labels',
    });
    expect(issueSourceService.readIssue).not.toHaveBeenCalled();
  });
});

describe('TaskCheckService for a merge request task', () => {
  const signal = new AbortController().signal;

  it('starts it without reading its related issue or looking for a newer task', async () => {
    const { service, issueSourceService, taskService } = checkWith(() => Promise.resolve(null));

    await expect(service.check(mergeRequestTrigger, mergeRequestTask, signal)).resolves.toEqual({ kind: 'start' });
    expect(issueSourceService.readIssue).not.toHaveBeenCalled();
    expect(taskService.findNewer).not.toHaveBeenCalled();
  });

  it('cancels it once its trigger starts on the other event', async () => {
    const { service } = checkWith(() => Promise.resolve(null));
    const opened = {
      ...mergeRequestTrigger,
      mergeRequest: { ...mergeRequestTrigger.mergeRequest, event: 'opened' as const },
    };

    await expect(service.check(opened, mergeRequestTask, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'Trigger merged now starts on merge requests opened, not merged',
    });
  });

  it('cancels it once its trigger names another target branch, and starts it on the one it names', async () => {
    const { service } = checkWith(() => Promise.resolve(null));
    const withBranch = (targetBranch: string) => ({
      ...mergeRequestTrigger,
      mergeRequest: { ...mergeRequestTrigger.mergeRequest, targetBranch },
    });

    await expect(service.check(withBranch('release'), mergeRequestTask, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'The trigger no longer applies to target branch master',
    });
    await expect(service.check(withBranch('master'), mergeRequestTask, signal)).resolves.toEqual({ kind: 'start' });
  });

  it('cancels it once its trigger leaves the project', async () => {
    const { service } = checkWith(() => Promise.resolve(null));
    const scoped = {
      ...mergeRequestTrigger,
      mergeRequest: { ...mergeRequestTrigger.mergeRequest, projects: ['group/other'] },
    };

    await expect(service.check(scoped, mergeRequestTask, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'The trigger no longer applies to project group/project',
    });
  });

  it('cancels a task whose trigger changed kind to or from merge request events', async () => {
    const { service, issueSourceService } = checkWith(() => Promise.resolve(null));

    await expect(service.check({ ...trigger, name: 'merged' }, mergeRequestTask, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'Trigger merged now starts on issue labels, not merge request events',
    });
    await expect(service.check(mergeRequestTrigger, task, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'Trigger merged now starts on merge request events, not issue labels',
    });
    await expect(service.check(mergeRequestTrigger, scheduledTask, signal)).resolves.toEqual({
      kind: 'cancel',
      reason: 'Trigger merged now starts on merge request events, not a schedule',
    });
    expect(issueSourceService.readIssue).not.toHaveBeenCalled();
  });
});
