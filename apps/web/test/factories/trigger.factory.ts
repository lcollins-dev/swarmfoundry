import { TaskStatus, type QueuedTaskDto, type SourceDto, type TriggerDto } from '@libs/dto';

import { listTaskWith } from './task.factory';

export const triggerWith = (overrides: Partial<TriggerDto> = {}): TriggerDto => ({
  name: 'implement',
  kind: 'issue',
  sourceName: 'gitlab',
  issue: {
    labels: ['workflow::ready'],
    notLabels: ['foundry::failed'],
    anyAssignee: ['foundry-bot'],
    projects: ['group/project'],
    expect: { anyLabel: ['workflow::review', 'foundry::needs-human'] },
  },
  schedule: null,
  mergeRequest: null,
  steps: [
    { kind: 'relabel', add: ['foundry::running'], remove: [] },
    {
      kind: 'agent',
      environment: 'swarmfoundry',
      agent: { name: 'claude', model: 'claude-opus-5-5', auth: 'oauth', concurrency: null },
      prompt: 'prompts/implement/prompt.md',
      systemPrompt: 'prompts/implement/system-prompt.md',
      timeoutMs: 120 * 60_000,
    },
  ],
  failureSteps: [{ kind: 'comment', body: '{{failure.report}}' }],
  concurrency: 2,
  runningCount: 1,
  queuedCount: 1,
  lastFiredDate: new Date('2026-10-25T14:20:00Z'),
  stats: {
    finishedCount: 8,
    succeededCount: 6,
    successRate: 0.75,
    medianDurationMs: 15 * 60_000 + 52_000,
    p90DurationMs: 2 * 3_600_000 + 25 * 60_000,
    succeededCostUsd: 61.61,
    failedCostUsd: 71.36,
  },
  ...overrides,
});

export const sourceWith = (overrides: Partial<SourceDto> = {}): SourceDto => ({
  name: 'gitlab',
  type: 'gitlab',
  url: 'https://gitlab.example.com',
  projects: ['group/project'],
  pollIntervalMs: 60_000,
  lastPoll: {
    endDate: new Date('2026-10-25T14:31:52Z'),
    succeeded: true,
    error: null,
    failedProjects: [],
  },
  nextPollDate: new Date('2026-10-25T14:32:52Z'),
  ...overrides,
});

export const queuedTaskWith = (overrides: Partial<QueuedTaskDto> = {}): QueuedTaskDto => ({
  ...listTaskWith({ status: TaskStatus.QUEUED, runCount: 0, startDate: null }),
  wait: { reason: 'noFreeSlot', on: 'trigger', name: 'implement', inUse: 2, limit: 2 },
  ...overrides,
});
