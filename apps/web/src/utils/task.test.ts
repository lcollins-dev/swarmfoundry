import { describe, expect, it } from 'vitest';

import { RunOutcome, StepList, TaskStatus } from '@libs/dto';

import { listTaskWith, runWith } from '../../test/factories/task.factory';
import {
  formatTaskCount,
  groupRunsByStep,
  runStatus,
  runTotalTokens,
  spanMs,
  stepLabel,
  taskCurrentStep,
  taskSubject,
} from './task';

describe('taskSubject', () => {
  it("names an issue task by its issue's title and reference", () => {
    expect(taskSubject(listTaskWith())).toEqual({
      title: 'Relabel drops scoped labels',
      reference: 'group/project#214',
      url: 'https://gitlab.example.com/group/project/-/issues/214',
    });
  });

  it('names a merge request task by its merge request, over its related issue', () => {
    const task = listTaskWith({
      kind: 'mergeRequest',
      mergeRequest: {
        iid: 7,
        event: 'merged',
        title: 'Add run outcomes',
        url: 'https://gitlab.example.com/group/project/-/merge_requests/7',
        sourceBranch: '7-outcomes',
        targetBranch: 'master',
      },
    });

    expect(taskSubject(task)).toEqual({
      title: 'Add run outcomes',
      reference: 'group/project!7',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/7',
    });
  });

  it('names a scheduled task by its trigger, with no link', () => {
    const task = listTaskWith({ kind: 'schedule', issue: null, triggerName: 'dependency-audit' });

    expect(taskSubject(task)).toEqual({
      title: 'Scheduled · dependency-audit',
      reference: 'Scheduled',
      url: null,
    });
  });
});

describe('taskCurrentStep', () => {
  it.each([
    ['a queued task that never ran', { status: TaskStatus.QUEUED, runCount: 0 }, 'Not started'],
    ['a queued task waiting on a retry', { status: TaskStatus.QUEUED, runCount: 1, step: 1 }, 'Step 2'],
    ['a running failure step', { list: StepList.FAILURE_STEPS, step: 0 }, 'Failure step 1'],
    [
      'a failed task by the step that failed',
      { status: TaskStatus.FAILED, list: StepList.FAILURE_STEPS, step: 0, furthestStep: 1 },
      'Step 2',
    ],
    ['a succeeded task', { status: TaskStatus.SUCCEEDED }, 'Done'],
    ['a cancelled task', { status: TaskStatus.CANCELLED, runCount: 0 }, 'Cancelled'],
  ])('reads %s', (_name, overrides, expected) => {
    expect(taskCurrentStep(listTaskWith(overrides))).toBe(expected);
  });
});

describe('formatTaskCount', () => {
  it.each([
    ['a single page', 1, 1, 7, 7, '7 tasks'],
    ['a single task', 1, 1, 1, 1, '1 task'],
    ['no tasks', 1, 1, 0, 0, '0 tasks'],
    ['a full first page', 1, 2, 20, 27, '1-20 of 27 tasks'],
    ['a short last page', 2, 2, 7, 27, '21-27 of 27 tasks'],
    ['a middle page', 2, 3, 20, 45, '21-40 of 45 tasks'],
  ])('reads %s', (_name, page, pages, shown, total, expected) => {
    expect(formatTaskCount(page, pages, shown, total)).toBe(expected);
  });
});

describe('stepLabel', () => {
  it('counts steps from one', () => {
    expect(stepLabel(StepList.STEPS, 2)).toBe('Step 3');
  });
});

describe('spanMs', () => {
  const START = new Date('2026-10-25T09:00:00Z');

  it('runs from start to end', () => {
    expect(spanMs(START, new Date('2026-10-25T09:01:00Z'))).toBe(60_000);
  });

  it('runs up to now while not ended', () => {
    expect(spanMs(START, null, new Date('2026-10-25T09:00:05Z'))).toBe(5000);
  });

  it('is null before the start', () => {
    expect(spanMs(null, null)).toBeNull();
  });
});

describe('runStatus', () => {
  it('reads an unjudged run as running', () => {
    expect(runStatus(runWith())).toBe('running');
    expect(runStatus(runWith({ outcome: RunOutcome.FAILED }))).toBe(RunOutcome.FAILED);
  });
});

describe('runTotalTokens', () => {
  it('sums every kind it recorded', () => {
    expect(
      runTotalTokens(runWith({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: null }))
    ).toBe(115);
  });

  it('is null with no usage', () => {
    expect(runTotalTokens(runWith())).toBeNull();
  });
});

describe('groupRunsByStep', () => {
  it('groups tries under their step, in the order each step first ran', () => {
    const runs = [
      runWith({ id: 1, step: 0, number: 1 }),
      runWith({ id: 2, step: 0, number: 2 }),
      runWith({ id: 3, step: 1, number: 1 }),
      runWith({ id: 4, list: StepList.FAILURE_STEPS, step: 0, number: 1 }),
    ];

    expect(groupRunsByStep(runs).map(group => [group.list, group.step, group.runs.map(run => run.id)])).toEqual([
      [StepList.STEPS, 0, [1, 2]],
      [StepList.STEPS, 1, [3]],
      [StepList.FAILURE_STEPS, 0, [4]],
    ]);
  });
});
