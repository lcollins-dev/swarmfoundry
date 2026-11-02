import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Task } from '@/core/task/entities/task.entity';

import { STATS_WINDOW_MS, TriggerAdminService } from './trigger-admin.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { REDACTED, SecretRedactionService } from '@/core/foundry-config/secret-redaction.service';
import type { IssueSourceService } from '@/core/issue-source/issue-source.service';
import { NO_ACTIVITY, type ITriggerActivity, type TaskReadService } from '@/core/task/task-read.service';
import type { QueueStatusService } from '@/core/trigger-engine/queue-status.service';

import type { ISourceConfig, ITriggerConfig } from '@/core/foundry-config/types/foundry-config.types';
import type { ISourcePollStatus } from '@/core/issue-source/types/issue-source.types';

const NOW = new Date('2026-10-30T12:00:00Z');
const SECRET = 'glpat-substituted';

const source: ISourceConfig = {
  name: 'gitlab',
  type: 'gitlab',
  url: 'https://gitlab.test',
  token: SECRET,
  pollInterval: 60_000,
  projects: ['group/project', 'group/other'],
  written: { url: 'https://gitlab.test' },
};

const implementIssue = {
  labels: ['workflow::ready'],
  notLabels: [],
  anyAssignee: [],
  projects: [],
  expect: { anyLabel: [] },
};

const implement = {
  name: 'implement',
  source,
  concurrency: 2,
  issue: implementIssue,
  steps: [
    {
      kind: 'agent',
      environment: { name: 'node' },
      agent: { name: 'claude', type: 'claude', auth: 'oauth', token: SECRET, model: 'claude-opus-5-5', concurrency: 1 },
      prompt: { path: '/config/prompts/implement/prompt.md', content: '' },
      timeout: 3_600_000,
      written: { model: 'claude-opus-5-5', prompt: 'prompts/implement/prompt.md' },
    },
  ],
  failureSteps: [{ kind: 'comment', body: `Failed, tell ${SECRET}`, written: { body: `Failed, tell ${SECRET}` } }],
  written: { issue: implementIssue },
} as unknown as ITriggerConfig;

const merged = {
  name: 'merged',
  source,
  concurrency: 1,
  mergeRequest: { event: 'merged', labels: [], notLabels: [], projects: [] },
  steps: [{ kind: 'relabel', add: ['workflow::test'], remove: [], written: { add: ['workflow::test'], remove: [] } }],
  failureSteps: [],
  written: { mergeRequest: { event: 'merged', labels: [], notLabels: [], projects: [] } },
} as unknown as ITriggerConfig;

const DEPLOY_PASSWORD = 'Sup3rDeployPw';

const deploy = {
  name: 'deploy',
  source,
  concurrency: 1,
  issue: { labels: ['workflow::deploy'], notLabels: [], anyAssignee: ['ada'], projects: [], expect: { anyLabel: [] } },
  steps: [
    {
      kind: 'agent',
      environment: { name: 'node' },
      agent: { name: 'claude', type: 'claude', auth: 'oauth', token: SECRET, model: 'claude-opus-5-5' },
      prompt: { path: '/config/prompts/deploy.md', content: '' },
      timeout: 60_000,
      written: { model: '${MODEL}', prompt: '${PROMPTS}/deploy.md', systemPrompt: '${PROMPTS}/system.md' },
    },
    {
      kind: 'comment',
      body: `Deploy with ${DEPLOY_PASSWORD} now`,
      written: { body: 'Deploy with ${DEPLOY_PASSWORD} now' },
    },
    { kind: 'relabel', add: ['workflow::deployed'], remove: [], written: { add: ['${DONE_LABEL}'], remove: [] } },
    { kind: 'assign', usernames: ['ada'], written: { usernames: ['${REVIEWER}'] } },
  ],
  failureSteps: [],
  written: {
    issue: {
      labels: ['${DEPLOY_LABEL}'],
      notLabels: [],
      anyAssignee: ['${REVIEWER}'],
      projects: [],
      expect: { anyLabel: [] },
    },
  },
} as unknown as ITriggerConfig;

const activity: ITriggerActivity = {
  runningCount: 1,
  queuedCount: 3,
  lastFiredDate: NOW,
  stats: {
    finishedCount: 4,
    succeededCount: 3,
    successRate: 0.75,
    medianDurationMs: 600_000,
    p90DurationMs: 900_000,
    succeededCostUsd: 2.5,
    failedCostUsd: 1,
  },
};

describe('TriggerAdminService', () => {
  const secretRedactionService = new SecretRedactionService();

  let findTriggerActivity: ReturnType<typeof vi.fn<TaskReadService['findTriggerActivity']>>;
  let pollStatus: ISourcePollStatus[];
  let triggers: ITriggerConfig[];
  let service: TriggerAdminService;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });

    findTriggerActivity = vi.fn<TaskReadService['findTriggerActivity']>(() =>
      Promise.resolve(new Map([['implement', activity]]))
    );
    pollStatus = [];
    triggers = [implement, merged];

    service = new TriggerAdminService(
      {
        get triggers() {
          return triggers;
        },
        revision: 'abc123',
        path: '/config/swarmfoundry.yaml',
        maskWritten: (text: string) => secretRedactionService.maskCredentials(text.replaceAll(SECRET, REDACTED)),
      } as unknown as FoundryConfigService,
      { pollStatus: () => pollStatus } as unknown as IssueSourceService,
      { findTriggerActivity } as unknown as TaskReadService,
      { findQueued: () => Promise.resolve([]) } as unknown as QueueStatusService
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns each trigger of the running config with its rules, steps and activity', async () => {
    const { triggerList, configSha } = await service.getTriggerList();

    expect(configSha).toBe('abc123');

    expect(findTriggerActivity).toHaveBeenCalledWith(
      ['implement', 'merged'],
      new Date(NOW.getTime() - STATS_WINDOW_MS)
    );
    expect(triggerList[0]).toEqual({
      name: 'implement',
      kind: 'issue',
      sourceName: 'gitlab',
      issue: implement.issue,
      schedule: null,
      mergeRequest: null,
      steps: [
        {
          kind: 'agent',
          environment: 'node',
          agent: { name: 'claude', model: 'claude-opus-5-5', auth: 'oauth', concurrency: 1 },
          prompt: 'prompts/implement/prompt.md',
          systemPrompt: null,
          timeoutMs: 3_600_000,
        },
      ],
      failureSteps: [{ kind: 'comment', body: 'Failed, tell [redacted]' }],
      concurrency: 2,
      ...activity,
    });
  });

  it('serves the text the config writes, never a ${VAR} value substituted from the environment', async () => {
    triggers = [deploy];

    const [trigger] = (await service.getTriggerList()).triggerList;

    expect(trigger).toMatchObject({
      issue: { labels: ['${DEPLOY_LABEL}'], anyAssignee: ['${REVIEWER}'] },
      steps: [
        {
          kind: 'agent',
          agent: { model: '${MODEL}' },
          prompt: '${PROMPTS}/deploy.md',
          systemPrompt: '${PROMPTS}/system.md',
        },
        { kind: 'comment', body: 'Deploy with ${DEPLOY_PASSWORD} now' },
        { kind: 'relabel', add: ['${DONE_LABEL}'], remove: [] },
        { kind: 'assign', usernames: ['${REVIEWER}'] },
      ],
    });
    expect(JSON.stringify(trigger)).not.toContain(DEPLOY_PASSWORD);
  });

  it('masks a credential written inline by its shape, as the config files are served', async () => {
    const body = [
      'Clone https://bot:Hunter2Password@gitlab.test/group/app.git',
      'Send Authorization: Bearer abcdef0123456789',
      'Use ghp_example0123456789',
    ].join('\n');
    const comment = { kind: 'comment', body, written: { body } };
    triggers = [{ ...merged, steps: [comment], failureSteps: [comment] } as unknown as ITriggerConfig];

    const [trigger] = (await service.getTriggerList()).triggerList;
    const masked = [
      `Clone https://bot:${REDACTED}@gitlab.test/group/app.git`,
      `Send Authorization: Bearer ${REDACTED}`,
      `Use ${REDACTED}`,
    ].join('\n');

    expect(trigger.steps).toEqual([{ kind: 'comment', body: masked }]);
    expect(trigger.failureSteps).toEqual([{ kind: 'comment', body: masked }]);
  });

  it('reads a trigger with no task as idle, and any target branch as null', async () => {
    const [, mergedTrigger] = (await service.getTriggerList()).triggerList;

    expect(mergedTrigger).toMatchObject({
      kind: 'mergeRequest',
      mergeRequest: { event: 'merged', targetBranch: null },
      runningCount: 0,
      queuedCount: 0,
      lastFiredDate: null,
      stats: NO_ACTIVITY.stats,
    });
    expect(NO_ACTIVITY.stats.successRate).toBeNull();
  });

  it('carries the queue in order with why each task waits', async () => {
    const task = new Task({
      triggerName: 'implement',
      sourceName: 'gitlab',
      projectId: null,
      projectPath: 'group/project',
      projectUrl: 'https://gitlab.test/group/project',
      issueIid: null,
      issueTitle: null,
      issueUrl: null,
      matchedIssue: null,
      change: null,
      fireTime: NOW,
      cron: '0 9 * * 1',
      mergeRequest: null,
      queuedDate: NOW,
    });
    task.id = 8;

    service = new TriggerAdminService(
      {} as FoundryConfigService,
      {} as IssueSourceService,
      {} as TaskReadService,
      {
        findQueued: () =>
          Promise.resolve([
            {
              summary: {
                task,
                totals: { runCount: 0, startDate: null, totalTokens: null, costUsd: null, furthestStep: null },
              },
              wait: { reason: 'heldBack', until: NOW },
            },
          ]),
      } as unknown as QueueStatusService
    );

    const { queue } = await service.getQueue();

    expect(queue).toEqual([
      expect.objectContaining({ id: 8, kind: 'schedule', wait: { reason: 'heldBack', until: NOW } }),
    ]);
  });

  it('says a poll succeeded only when it read every project and did not fail outright', () => {
    const endDate = new Date(NOW.getTime() - 8_000);
    const nextPollDate = new Date(NOW.getTime() + 52_000);
    pollStatus = [
      { source, lastPoll: { endDate, failedProjects: [], error: null }, nextPollDate },
      {
        source: { ...source, name: 'second' },
        lastPoll: { endDate, failedProjects: [{ project: 'group/other', error: 'GitLab answered 404' }], error: null },
        nextPollDate,
      },
      { source: { ...source, name: 'third' }, lastPoll: null, nextPollDate: null },
      {
        source: { ...source, name: 'fourth' },
        lastPoll: { endDate, failedProjects: [], error: 'GitLab answered 503' },
        nextPollDate,
      },
    ];

    const { sourceList } = service.getSourceList();

    expect(sourceList[0]).toEqual({
      name: 'gitlab',
      type: 'gitlab',
      url: 'https://gitlab.test',
      projects: ['group/project', 'group/other'],
      pollIntervalMs: 60_000,
      lastPoll: { endDate, succeeded: true, error: null, failedProjects: [] },
      nextPollDate,
    });
    expect(sourceList[1].lastPoll?.succeeded).toBe(false);
    expect(sourceList[2].lastPoll).toBeNull();
    expect(sourceList[3].lastPoll?.succeeded).toBe(false);
    expect(JSON.stringify(sourceList)).not.toContain(SECRET);
  });

  it("serves a source's url as the config writes it, and its projects resolved for the task filter", () => {
    pollStatus = [{ source: { ...source, written: { url: '${GITLAB_URL}' } }, lastPoll: null, nextPollDate: null }];

    expect(service.getSourceList().sourceList[0]).toMatchObject({
      url: '${GITLAB_URL}',
      projects: ['group/project', 'group/other'],
    });
  });

  it("masks a password written inline in a source's url", () => {
    const written = { url: 'https://bot:Hunter2Password@gitlab.test' };
    pollStatus = [{ source: { ...source, written }, lastPoll: null, nextPollDate: null }];

    expect(service.getSourceList().sourceList[0].url).toBe(`https://bot:${REDACTED}@gitlab.test`);
  });
});
