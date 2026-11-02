import { describe, expect, it } from 'vitest';

import { StepList } from '@libs/dto';

import { triggerWith } from '../../test/factories/trigger.factory';
import { queueWaitLabel, stepTimeoutMs, sumStats, triggerPath, triggerRules, triggerSummary } from './trigger';

describe('triggerSummary', () => {
  it('reads an issue trigger as its kind and the labels it needs', () => {
    const issue = {
      labels: ['workflow::plan', 'state::untriaged'],
      notLabels: ['foundry::failed'],
      anyAssignee: ['ann'],
      projects: [],
      expect: { anyLabel: [] },
    };

    expect(triggerSummary(triggerWith({ issue }))).toBe('Issue · workflow::plan, state::untriaged');
    expect(triggerSummary(triggerWith({ issue: { ...issue, labels: [] } }))).toBe('Issue · any');
  });

  it('reads a merge request trigger as its kind, event and branch', () => {
    const mergeRequest = { event: 'merged' as const, targetBranch: 'main', labels: [], notLabels: [], projects: [] };

    expect(triggerSummary(triggerWith({ kind: 'mergeRequest', issue: null, mergeRequest }))).toBe(
      'MR · merged to main'
    );
    expect(
      triggerSummary(
        triggerWith({ kind: 'mergeRequest', issue: null, mergeRequest: { ...mergeRequest, targetBranch: null } })
      )
    ).toBe('MR · merged to any branch');
  });

  it('reads a scheduled trigger as its kind and cron', () => {
    const trigger = triggerWith({ kind: 'schedule', issue: null, schedule: { cron: '0 3 * * 1', project: 'group/a' } });

    expect(triggerSummary(trigger)).toBe('Cron · 0 3 * * 1');
  });
});

describe('triggerRules', () => {
  it('lists the rules an issue trigger sets, with every project when it names none', () => {
    const trigger = triggerWith({
      issue: { labels: ['workflow::ready'], notLabels: [], anyAssignee: [], projects: [], expect: { anyLabel: [] } },
    });

    expect(triggerRules(trigger)).toEqual([
      { label: 'Source', key: 'source', values: ['gitlab'] },
      { label: 'Has all labels', key: 'issue.labels', values: ['workflow::ready'] },
      { label: 'Projects', key: 'issue.projects', values: [], note: 'All projects in this source.' },
      { label: 'Concurrency', key: 'concurrency', values: ['2'] },
    ]);
  });

  it('notes the labels expected after the steps', () => {
    const expected = triggerRules(triggerWith()).find(rule => rule.key === 'issue.expect.anyLabel');

    expect(expected?.values).toEqual(['workflow::review', 'foundry::needs-human']);
    expect(expected?.note).toBe('The issue must have at least one of these labels when the steps finish.');
  });
});

describe('queueWaitLabel', () => {
  it('names what each queued task waits for', () => {
    expect(queueWaitLabel({ reason: 'noFreeSlot', on: 'agent', name: 'claude', inUse: 3, limit: 3 })).toBe(
      'No free slot · claude 3/3'
    );
    expect(queueWaitLabel({ reason: 'heldBack', until: new Date(2026, 9, 25, 14, 5) })).toBe(
      'Held back · 25 Oct, 14:05'
    );
    expect(queueWaitLabel({ reason: 'ready' })).toBe('Ready');
    expect(queueWaitLabel({ reason: 'notInConfig' })).toBe('Not in config');
  });
});

describe('sumStats', () => {
  it("adds every trigger's counts and costs, and rates success over them", () => {
    const other = triggerWith({
      stats: { ...triggerWith().stats, finishedCount: 2, succeededCount: 2, succeededCostUsd: 1, failedCostUsd: 0 },
    });

    expect(sumStats([triggerWith(), other])).toEqual({
      finishedCount: 10,
      succeededCount: 8,
      successRate: 0.8,
      succeededCostUsd: 62.61,
      failedCostUsd: 71.36,
    });
  });

  it('rates no success with nothing finished', () => {
    expect(sumStats([]).successRate).toBeNull();
  });
});

describe('stepTimeoutMs', () => {
  it("is an agent step's timeout, and null for a static step or one not in the config", () => {
    expect(stepTimeoutMs(triggerWith(), StepList.STEPS, 1)).toBe(120 * 60_000);
    expect(stepTimeoutMs(triggerWith(), StepList.STEPS, 0)).toBeNull();
    expect(stepTimeoutMs(triggerWith(), StepList.STEPS, 5)).toBeNull();
    expect(stepTimeoutMs(undefined, StepList.STEPS, 1)).toBeNull();
  });
});

describe('triggerPath', () => {
  it('encodes the name', () => {
    expect(triggerPath('a b')).toBe('/triggers/a%20b');
  });
});
