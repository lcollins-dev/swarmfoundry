import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { Task } from '@/core/task/entities/task.entity';

import { LABEL_READ_DELAYS_MS, RunJudgeService } from './run-judge.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import type { IssueSourceService } from '@/core/issue-source/issue-source.service';

import type {
  IIssueTriggerConfig,
  IMergeRequestTriggerConfig,
  IScheduleTriggerConfig,
} from '@/core/foundry-config/foundry-config.types';
import type { IIssueState } from '@/core/issue-source/issue-source.types';
import { RunEndReason, RunOutcome } from '@/core/task/task.types';

const TOKEN = 'glpat-orchestrator';

const trigger = (anyLabel: string[] = ['workflow::review']) =>
  ({
    name: 'implement',
    source: { name: 'gitlab' },
    issue: { expect: { anyLabel } },
  }) as unknown as IIssueTriggerConfig;

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

describe('RunJudgeService', () => {
  let readIssue: ReturnType<typeof vi.fn<() => Promise<IIssueState | null>>>;
  let service: RunJudgeService;
  let sleep: MockInstance<RunJudgeService['sleep']>;
  const signal = new AbortController().signal;

  beforeEach(() => {
    readIssue = vi.fn().mockResolvedValue({ open: true, labels: ['workflow::review'], assignees: [] });

    service = new RunJudgeService(
      { redactText: (text: string) => text.replaceAll(TOKEN, '[redacted]') } as unknown as FoundryConfigService,
      { readIssue } as unknown as IssueSourceService
    );

    sleep = vi.spyOn(service, 'sleep').mockResolvedValue(undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes once the issue carries the expected label', async () => {
    await expect(service.judgeExpect(trigger(), task, signal)).resolves.toEqual({
      outcome: RunOutcome.SUCCEEDED,
      error: null,
      deploymentFault: null,
    });
    expect(readIssue).toHaveBeenCalledOnce();
  });

  it.each(['workflow::ready-for-release', 'qa::failed'])(
    'passes a run whose issue carries %s, one of the expected labels',
    async label => {
      readIssue.mockResolvedValue({ open: true, labels: ['workflow::test', label], assignees: [] });

      await expect(
        service.judgeExpect(trigger(['workflow::ready-for-release', 'qa::failed']), task, signal)
      ).resolves.toEqual({ outcome: RunOutcome.SUCCEEDED, error: null, deploymentFault: null });
    }
  );

  it('fails a run whose issue carries none of the expected labels, naming each', async () => {
    readIssue.mockResolvedValue({ open: true, labels: ['workflow::test'], assignees: [] });

    await expect(
      service.judgeExpect(trigger(['workflow::ready-for-release', 'qa::failed']), task, signal)
    ).resolves.toEqual({
      outcome: RunOutcome.FAILED,
      error: 'The run ended without the issue carrying workflow::ready-for-release or qa::failed',
      deploymentFault: null,
    });
  });

  it('passes a run whose issue already carried an expected label, since it judges labels carried, not gained', async () => {
    readIssue.mockResolvedValue({ open: true, labels: ['workflow::test', 'qa::failed'], assignees: [] });

    await expect(
      service.judgeExpect(trigger(['workflow::ready-for-release', 'qa::failed']), task, signal)
    ).resolves.toMatchObject({ outcome: RunOutcome.SUCCEEDED });
  });

  it('reads no labels when the trigger expects none', async () => {
    await expect(service.judgeExpect(trigger([]), task, signal)).resolves.toMatchObject({
      outcome: RunOutcome.SUCCEEDED,
    });
    expect(readIssue).not.toHaveBeenCalled();
  });

  it('fails a run whose issue was deleted', async () => {
    readIssue.mockResolvedValue(null);

    await expect(service.judgeExpect(trigger(), task, signal)).resolves.toEqual({
      outcome: RunOutcome.FAILED,
      error: 'The issue no longer exists, so the run could not be judged',
      deploymentFault: null,
      endReason: RunEndReason.RUNNER_ERROR,
    });
  });

  it('reads the labels again after a failed read', async () => {
    readIssue.mockRejectedValueOnce(new Error('GitLab answered 502 to GET /projects/7/issues/3'));

    await expect(service.judgeExpect(trigger(), task, signal)).resolves.toMatchObject({
      outcome: RunOutcome.SUCCEEDED,
    });
    expect(readIssue).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(LABEL_READ_DELAYS_MS[0], signal);
  });

  it('fails the run for good, redacted, once every read failed, since a retry would run the last step again', async () => {
    readIssue.mockRejectedValue(new Error(`socket hang up ${TOKEN}`));

    await expect(service.judgeExpect(trigger(), task, signal)).resolves.toEqual({
      outcome: RunOutcome.FAILED,
      error: "Failed to read the issue's labels to judge the run: socket hang up [redacted]",
      deploymentFault: null,
      endReason: RunEndReason.RUNNER_ERROR,
    });
    expect(readIssue).toHaveBeenCalledTimes(LABEL_READ_DELAYS_MS.length + 1);
  });

  it('rejects when shutdown aborts a wait between reads', async () => {
    const controller = new AbortController();
    readIssue.mockRejectedValue(new Error('GitLab answered 502'));
    sleep.mockImplementation(() => {
      controller.abort();

      return Promise.reject(new Error('aborted'));
    });

    await expect(service.judgeExpect(trigger(), task, controller.signal)).rejects.toThrow('aborted');
  });

  it('fails a run that expects labels on a task with no issue, reading nothing', async () => {
    const scheduled = Object.assign(Object.create(task) as Task, { projectId: null, issueIid: null });

    await expect(service.judgeExpect(trigger(), scheduled, signal)).resolves.toEqual({
      outcome: RunOutcome.FAILED,
      error: 'The task has no issue, so the run could not be judged by its labels',
      deploymentFault: null,
      endReason: RunEndReason.RUNNER_ERROR,
    });
    expect(readIssue).not.toHaveBeenCalled();
  });

  it('passes a schedule trigger, reading nothing', async () => {
    const scheduledTrigger = {
      name: 'friction',
      source: { name: 'gitlab' },
      schedule: { cron: '0 9 * * 1', project: 'group/project' },
    } as unknown as IScheduleTriggerConfig;
    const scheduled = Object.assign(Object.create(task) as Task, { projectId: null, issueIid: null });

    await expect(service.judgeExpect(scheduledTrigger, scheduled, signal)).resolves.toEqual({
      outcome: RunOutcome.SUCCEEDED,
      error: null,
      deploymentFault: null,
    });
    expect(readIssue).not.toHaveBeenCalled();
  });

  it('passes a merge request trigger, reading no labels off its related issue', async () => {
    const mergeRequestTrigger = {
      name: 'merged',
      source: { name: 'gitlab' },
      mergeRequest: { event: 'merged', labels: [], notLabels: [], projects: [] },
    } as unknown as IMergeRequestTriggerConfig;
    const mergeRequestTask = Object.assign(Object.create(task) as Task, {
      changeKind: null,
      changeId: null,
      changeDate: null,
      mergeRequestIid: 5,
    });

    await expect(service.judgeExpect(mergeRequestTrigger, mergeRequestTask, signal)).resolves.toEqual({
      outcome: RunOutcome.SUCCEEDED,
      error: null,
      deploymentFault: null,
    });
    expect(readIssue).not.toHaveBeenCalled();
  });
});
