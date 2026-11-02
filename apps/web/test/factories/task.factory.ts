import { StepList, TaskStatus, type ListTaskDto, type RunDto, type TaskDto } from '@libs/dto';

export const QUEUED_DATE = new Date('2026-10-25T09:00:00Z');
export const START_DATE = new Date('2026-10-25T09:03:00Z');

export const listTaskWith = (overrides: Partial<ListTaskDto> = {}): ListTaskDto => ({
  id: 1080,
  kind: 'issue',
  triggerName: 'implement',
  sourceName: 'gitlab',
  projectPath: 'group/project',
  projectUrl: 'https://gitlab.example.com/group/project',
  issue: {
    iid: 214,
    title: 'Relabel drops scoped labels',
    url: 'https://gitlab.example.com/group/project/-/issues/214',
  },
  mergeRequest: null,
  fireTime: null,
  status: TaskStatus.RUNNING,
  list: StepList.STEPS,
  step: 0,
  runCount: 1,
  furthestStep: 0,
  totalTokens: 1_700_000,
  costUsd: 13.04,
  configSha: 'a41c9e2f00000000000000000000000000000000',
  queuedDate: QUEUED_DATE,
  startDate: START_DATE,
  endDate: null,
  notBeforeDate: null,
  cancelReason: null,
  ...overrides,
});

export const taskWith = (overrides: Partial<TaskDto> = {}): TaskDto => ({
  ...listTaskWith(),
  matchedIssue: { labels: ['workflow::ready'], author: 'ann', assignees: ['foundry-bot'] },
  change: { kind: 'label', date: QUEUED_DATE, actor: 'ann' },
  cron: null,
  runs: [],
  ...overrides,
});

export const runWith = (overrides: Partial<RunDto> = {}): RunDto => ({
  id: 3405,
  taskId: 1080,
  list: StepList.STEPS,
  step: 0,
  number: 1,
  outcome: null,
  endReason: null,
  exitCode: null,
  configSha: 'a41c9e2f00000000000000000000000000000000',
  startDate: START_DATE,
  endDate: null,
  error: null,
  agent: { name: 'claude', model: 'claude-opus-5-5', auth: 'apiKey' },
  turns: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  costUsd: null,
  ...overrides,
});
