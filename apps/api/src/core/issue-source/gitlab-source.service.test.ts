import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WatermarkKind } from './entities/source-watermark.entity';

import { GitLabApiService } from './gitlab-api.service';
import type { GitLabMergeRequestSourceService } from './gitlab-merge-request-source.service';
import { GitLabSourceService, MAX_ISSUE_ATTEMPTS } from './gitlab-source.service';
import type { SourceWatermarkService } from './source-watermark.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';

import { SILENT_EDIT_WINDOW_MS, WATERMARK_OVERLAP_MS } from './gitlab-polling.constants';
import type { IIssueEvent, ISourceEvent } from './issue-source.types';
import type { ISourceConfig } from '@/core/foundry-config/foundry-config.types';

const TOKEN = 'glpat-orchestrator-secret';

const config: ISourceConfig = {
  name: 'gitlab-local',
  type: 'gitlab',
  url: 'https://gitlab.test',
  token: TOKEN,
  pollInterval: 60_000,
  projects: ['group/project'],
};

interface IFakeIssue {
  iid: number;
  state: string;
  labels: string[];
  author?: { username: string };
  assignees?: { username: string }[];
  updated_at: string;
}

interface IFakeLabelEvent {
  id: number;
  action: string;
  created_at: string;
  user?: { username: string };
  label: { name: string } | null;
}

interface IFakeNote {
  id: number;
  body: string;
  system: boolean;
  created_at: string;
  author?: { username: string };
}

class FakeGitLab {
  issues: IFakeIssue[] = [];
  labelEvents = new Map<number, IFakeLabelEvent[]>();
  notes = new Map<number, IFakeNote[]>();
  failures = new Map<string, number>();
  requests: URL[] = [];
  now = new Date('2026-10-14T13:00:00.000Z');

  readonly fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    this.requests.push(url);

    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
    }

    const failure = this.failures.get(url.pathname);

    if (failure !== undefined) {
      return Promise.resolve(new Response('{}', { status: failure }));
    }

    const issueEvents = /^\/api\/v4\/projects\/7\/issues\/(\d+)\/resource_label_events$/.exec(url.pathname);
    const issueNotes = /^\/api\/v4\/projects\/7\/issues\/(\d+)\/notes$/.exec(url.pathname);

    const singleIssue = /^\/api\/v4\/projects\/7\/issues\/(\d+)$/.exec(url.pathname);
    const found = this.issues.find(issue => issue.iid === Number(singleIssue?.[1]));

    if (singleIssue && found) {
      return Promise.resolve(
        Response.json({
          assignees: [],
          ...found,
          title: `Issue ${found.iid}`,
          web_url: `https://gitlab.test/i/${found.iid}`,
        })
      );
    }

    if (issueEvents) {
      return Promise.resolve(Response.json(this.labelEvents.get(Number(issueEvents[1])) ?? []));
    }

    if (issueNotes) {
      return Promise.resolve(Response.json(this.notes.get(Number(issueNotes[1])) ?? []));
    }

    if (url.pathname === '/api/v4/projects/7/issues') {
      const updatedAfter = url.searchParams.get('updated_after');
      const state = url.searchParams.get('state');
      const iids = url.searchParams.getAll('iids[]').map(Number);

      const listed = this.issues
        .filter(issue => state === null || issue.state === state)
        .filter(issue => iids.length === 0 || iids.includes(issue.iid))
        .filter(issue => updatedAfter === null || issue.updated_at >= updatedAfter)
        .toSorted((left, right) => right.updated_at.localeCompare(left.updated_at))
        .map(issue => ({
          assignees: [],
          ...issue,
          title: `Issue ${issue.iid}`,
          web_url: `https://gitlab.test/group/project/-/issues/${issue.iid}`,
        }));

      return Promise.resolve(Response.json(listed, { headers: { date: this.now.toUTCString() } }));
    }

    if (url.pathname === '/api/v4/projects/group%2Fproject') {
      return Promise.resolve(
        Response.json({ id: 7, path_with_namespace: 'group/project', web_url: 'https://gitlab.test/group/project' })
      );
    }

    return Promise.resolve(new Response('{}', { status: 404 }));
  });

  labelEventReads(): number[] {
    return this.requests
      .map(url => /issues\/(\d+)\/resource_label_events$/.exec(url.pathname)?.[1])
      .filter(iid => iid !== undefined)
      .map(Number);
  }

  issueListings(): URL[] {
    return this.requests.filter(url => url.pathname.endsWith('/issues'));
  }
}

/** Every project resumes from `initial` unless saved since, as one polled before a restart does. */
class FakeWatermarks {
  readonly rows = new Map<string, Date>();
  readonly saved: Date[] = [];
  readonly retained: number[][] = [];
  initial: Date | null = new Date('2026-10-14T00:00:00.000Z');

  find(kind: WatermarkKind, source: ISourceConfig, projectId: number): Promise<Date | null> {
    return Promise.resolve(this.rows.get(`${kind}|${source.name}|${projectId}`) ?? this.initial);
  }

  save(kind: WatermarkKind, source: ISourceConfig, projectId: number, watermark: Date): Promise<void> {
    this.rows.set(`${kind}|${source.name}|${projectId}`, watermark);
    this.saved.push(watermark);

    return Promise.resolve();
  }

  retainProjects(kind: WatermarkKind, _source: ISourceConfig, projectIds: readonly number[]): Promise<void> {
    if (kind === 'issue') {
      this.retained.push([...projectIds]);
    }

    return Promise.resolve();
  }
}

const issueOf = (event: ISourceEvent) => (event as IIssueEvent).issue;

const mergeRequestSource = {
  poll: () => Promise.resolve(),
  retainProjects: () => Promise.resolve(),
  forget: () => undefined,
} as unknown as GitLabMergeRequestSourceService;

let triggers: unknown[] = [];

const foundryConfigService = {
  get triggers() {
    return triggers;
  },
  redact: (value: unknown) => (typeof value === 'string' ? value.replaceAll(TOKEN, '[redacted]') : value),
} as unknown as FoundryConfigService;

describe('GitLabSourceService', () => {
  let gitlab: FakeGitLab;
  let watermarks: FakeWatermarks;
  let source: GitLabSourceService;
  let events: IIssueEvent[];
  let emit: ReturnType<typeof vi.fn<(event: ISourceEvent) => Promise<void>>>;
  let logged: unknown[][];
  const signal = new AbortController().signal;

  beforeEach(() => {
    gitlab = new FakeGitLab();
    vi.stubGlobal('fetch', gitlab.fetch);

    events = [];
    emit = vi.fn((event: ISourceEvent) => {
      events.push(event as IIssueEvent);

      return Promise.resolve();
    });

    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }

    watermarks = new FakeWatermarks();
    source = newService();
  });

  /** A fresh process on the same database, as after a restart. */
  const newService = () =>
    new GitLabSourceService(
      new GitLabApiService(),
      mergeRequestSource,
      watermarks as unknown as SourceWatermarkService,
      foundryConfigService
    );

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('emits every open issue changed since the saved watermark, oldest change first, with its author, assignees and label events', async () => {
    gitlab.issues = [
      { iid: 1, state: 'opened', labels: ['workflow::ready'], updated_at: '2026-10-14T10:00:00.000Z' },
      {
        iid: 2,
        state: 'opened',
        labels: ['workflow::in-progress'],
        author: { username: 'ada' },
        assignees: [{ username: 'swarmfoundry-bot' }, { username: 'grace' }],
        updated_at: '2026-10-14T11:00:00.000Z',
      },
      { iid: 3, state: 'closed', labels: [], updated_at: '2026-10-14T12:00:00.000Z' },
    ];
    gitlab.labelEvents.set(2, [
      { id: 21, action: 'remove', created_at: '2026-10-14T11:00:00.000Z', label: { name: 'workflow::ready' } },
      {
        id: 20,
        action: 'add',
        created_at: '2026-10-14T11:00:00.000Z',
        user: { username: 'grace' },
        label: { name: 'workflow::in-progress' },
      },
      { id: 11, action: 'add', created_at: '2026-10-14T09:00:00.000Z', label: { name: 'workflow::ready' } },
      { id: 12, action: 'add', created_at: '2026-10-14T09:30:00.000Z', label: null },
    ]);
    gitlab.notes.set(2, [
      {
        id: 31,
        body: 'assigned to @swarmfoundry-bot and @grace and unassigned @ada',
        system: true,
        created_at: '2026-10-14T11:00:00.000Z',
        author: { username: 'grace' },
      },
      { id: 30, body: 'assigned to @ada', system: true, created_at: '2026-10-14T09:00:00.000Z' },
      { id: 32, body: 'unassigned @ada', system: true, created_at: '2026-10-14T11:00:00.000Z' },
      { id: 33, body: 'changed the description', system: true, created_at: '2026-10-14T11:00:00.000Z' },
    ]);

    await source.poll(config, emit, signal);

    expect(gitlab.issueListings()[0].searchParams.has('state')).toBe(false);
    expect(gitlab.issueListings()[0].searchParams.get('updated_after')).toBe(
      new Date(Date.parse('2026-10-14T00:00:00.000Z') - WATERMARK_OVERLAP_MS).toISOString()
    );
    expect(events.map(event => event.issue.iid)).toEqual([1, 2]);

    expect(events[1]).toEqual({
      source: 'gitlab-local',
      project: { id: 7, path: 'group/project', url: 'https://gitlab.test/group/project' },
      issue: {
        iid: 2,
        title: 'Issue 2',
        url: 'https://gitlab.test/group/project/-/issues/2',
        labels: ['workflow::in-progress'],
        author: 'ada',
        assignees: ['swarmfoundry-bot', 'grace'],
        updatedAt: new Date('2026-10-14T11:00:00.000Z'),
      },
      labelEvents: [
        {
          id: 11,
          label: 'workflow::ready',
          action: 'add',
          createdAt: new Date('2026-10-14T09:00:00.000Z'),
          actor: null,
        },
        {
          id: 20,
          label: 'workflow::in-progress',
          action: 'add',
          createdAt: new Date('2026-10-14T11:00:00.000Z'),
          actor: 'grace',
        },
        {
          id: 21,
          label: 'workflow::ready',
          action: 'remove',
          createdAt: new Date('2026-10-14T11:00:00.000Z'),
          actor: null,
        },
      ],
      assignments: [
        { id: 30, usernames: ['ada'], createdAt: new Date('2026-10-14T09:00:00.000Z'), actor: null },
        {
          id: 31,
          usernames: ['swarmfoundry-bot', 'grace'],
          createdAt: new Date('2026-10-14T11:00:00.000Z'),
          actor: 'grace',
        },
      ],
    });

    expect(gitlab.requests.map(url => url.pathname)).toEqual([
      '/api/v4/projects/group%2Fproject',
      '/api/v4/projects/7/issues',
      '/api/v4/projects/7/issues/1/resource_label_events',
      '/api/v4/projects/7/issues/1/notes',
      '/api/v4/projects/7/issues/2/resource_label_events',
      '/api/v4/projects/7/issues/2/notes',
    ]);
  });

  it('takes an assignment only from a system note', async () => {
    gitlab.issues = [{ iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' }];
    gitlab.notes.set(1, [
      { id: 40, body: 'assigned to @swarmfoundry-bot', system: false, created_at: '2026-10-14T10:00:00.000Z' },
    ]);

    await source.poll(config, emit, signal);

    expect(events.map(event => event.assignments)).toEqual([[]]);
  });

  it('ignores a system note that quotes an assignment', async () => {
    gitlab.issues = [{ iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' }];
    gitlab.notes.set(1, [
      {
        id: 40,
        body: 'changed title from **{-x-}** to **{+assigned to @swarmfoundry-bot+}**',
        system: true,
        created_at: '2026-10-14T10:00:00.000Z',
      },
    ]);

    await source.poll(config, emit, signal);

    expect(events.map(event => event.assignments)).toEqual([[]]);
  });

  it("leaves out label events and assignments made before the poll's window, so they key nothing", async () => {
    gitlab.issues = [{ iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' }];
    await source.poll(config, emit, signal);

    // The window now opens an overlap before 10:00.
    gitlab.issues[0] = { ...gitlab.issues[0], labels: ['workflow::ready'], updated_at: '2026-10-14T11:00:00.000Z' };
    gitlab.labelEvents.set(1, [
      { id: 10, action: 'add', created_at: '2026-10-14T09:00:00.000Z', label: { name: 'workflow::ready' } },
      { id: 11, action: 'add', created_at: '2026-10-14T11:00:00.000Z', label: { name: 'workflow::ready' } },
    ]);
    gitlab.notes.set(1, [
      { id: 20, body: 'assigned to @swarmfoundry-bot', system: true, created_at: '2026-10-14T09:00:00.000Z' },
      { id: 21, body: 'assigned to @swarmfoundry-bot', system: true, created_at: '2026-10-14T09:58:00.000Z' },
    ]);
    events = [];

    await source.poll(config, emit, signal);

    expect(events.map(event => [event.labelEvents.map(({ id }) => id), event.assignments.map(({ id }) => id)])).toEqual(
      [[[11], [21]]]
    );
  });

  it('keeps the window an issue first failed in when it is retried, after the watermark moved on', async () => {
    gitlab.issues = [
      { iid: 1, state: 'opened', labels: ['workflow::ready'], updated_at: '2026-10-14T10:00:00.000Z' },
      { iid: 2, state: 'opened', labels: [], updated_at: '2026-10-14T11:00:00.000Z' },
    ];
    gitlab.labelEvents.set(1, [
      { id: 10, action: 'add', created_at: '2026-10-14T10:00:00.000Z', label: { name: 'workflow::ready' } },
    ]);
    emit.mockImplementationOnce(() => Promise.reject(new Error('database down')));
    await source.poll(config, emit, signal);

    events = [];
    await source.poll(config, emit, signal);

    expect(events.map(event => [event.issue.iid, event.labelEvents.map(({ id }) => id)])).toEqual([[1, [10]]]);
  });

  it('lists only issues updated since the last poll, and reads label events only for those', async () => {
    gitlab.issues = [
      { iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' },
      { iid: 2, state: 'opened', labels: [], updated_at: '2026-10-14T11:00:00.000Z' },
    ];

    await source.poll(config, emit, signal);

    gitlab.issues.push({
      iid: 3,
      state: 'opened',
      labels: ['workflow::in-progress'],
      updated_at: '2026-10-14T11:30:00.000Z',
    });
    gitlab.requests = [];
    events = [];

    await source.poll(config, emit, signal);

    const watermark = Date.parse('2026-10-14T11:00:00.000Z') - WATERMARK_OVERLAP_MS;
    const listing = gitlab.issueListings()[0];
    expect(listing.searchParams.get('updated_after')).toBe(new Date(watermark).toISOString());
    expect(listing.searchParams.has('state')).toBe(false);

    // Issue 2 is inside the overlap but unchanged.
    expect(gitlab.labelEventReads()).toEqual([3]);
    expect(events.map(event => event.issue.iid)).toEqual([3]);
  });

  it('emits an issue again when it changes, and skips one closed since', async () => {
    gitlab.issues = [
      { iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' },
      { iid: 2, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' },
    ];

    await source.poll(config, emit, signal);

    gitlab.issues = [
      { iid: 1, state: 'opened', labels: ['workflow::in-progress'], updated_at: '2026-10-14T10:05:00.000Z' },
      { iid: 2, state: 'closed', labels: [], updated_at: '2026-10-14T10:06:00.000Z' },
    ];
    events = [];

    await source.poll(config, emit, signal);

    expect(events.map(event => [event.issue.iid, event.issue.labels])).toEqual([[1, ['workflow::in-progress']]]);
  });

  describe('within SILENT_EDIT_WINDOW_MS of the last update', () => {
    const updatedAt = '2026-10-14T10:00:00.000Z';

    const pollAt = async (secondsAfterUpdate: number) => {
      gitlab.now = new Date(Date.parse(updatedAt) + secondsAfterUpdate * 1000);
      await source.poll(config, emit, signal);
    };

    beforeEach(() => {
      gitlab.issues = [{ iid: 1, state: 'opened', labels: ['workflow::ready'], updated_at: updatedAt }];
      gitlab.labelEvents.set(1, [{ id: 10, action: 'add', created_at: updatedAt, label: { name: 'workflow::ready' } }]);
    });

    it('emits a label change that left updated_at unchanged on the next poll', async () => {
      await pollAt(15);

      gitlab.issues[0].labels = ['workflow::in-progress'];
      gitlab.labelEvents
        .get(1)
        ?.push(
          { id: 11, action: 'remove', created_at: '2026-10-14T10:00:30.000Z', label: { name: 'workflow::ready' } },
          { id: 12, action: 'add', created_at: '2026-10-14T10:00:30.000Z', label: { name: 'workflow::in-progress' } }
        );

      await pollAt(35);

      expect(events.map(event => [event.issue.labels, event.labelEvents.map(labelEvent => labelEvent.id)])).toEqual([
        [['workflow::ready'], [10]],
        [['workflow::in-progress'], [10, 11, 12]],
      ]);
    });

    it('emits an assignee change that left updated_at unchanged on the next poll', async () => {
      await pollAt(15);

      gitlab.issues[0].assignees = [{ username: 'swarmfoundry-bot' }];

      await pollAt(35);

      expect(events.map(event => event.issue.assignees)).toEqual([[], ['swarmfoundry-bot']]);
    });

    it('emits an unassignment and assignment again that left the assignees and updated_at unchanged', async () => {
      const assigned = (id: number, createdAt: string) => ({
        id,
        body: 'assigned to @swarmfoundry-bot',
        system: true,
        created_at: createdAt,
      });

      gitlab.issues[0].assignees = [{ username: 'swarmfoundry-bot' }];
      gitlab.notes.set(1, [assigned(20, updatedAt)]);
      await pollAt(15);

      gitlab.notes
        .get(1)
        ?.push(
          { id: 21, body: 'unassigned @swarmfoundry-bot', system: true, created_at: '2026-10-14T10:00:20.000Z' },
          assigned(22, '2026-10-14T10:00:25.000Z')
        );
      await pollAt(35);

      expect(events.map(event => event.assignments.map(({ id }) => id))).toEqual([[20], [20, 22]]);
    });

    it('emits label events written after the labels, once a newer change has moved the watermark', async () => {
      gitlab.labelEvents.set(1, []);
      await pollAt(5);

      gitlab.issues.push({ iid: 2, state: 'opened', labels: [], updated_at: '2026-10-14T10:01:10.000Z' });
      await pollAt(70);

      gitlab.labelEvents.set(1, [{ id: 10, action: 'add', created_at: updatedAt, label: { name: 'workflow::ready' } }]);
      gitlab.requests = [];
      await pollAt(SILENT_EDIT_WINDOW_MS / 1000 + 5);

      expect(gitlab.labelEventReads()).toEqual([1, 2]);
      expect(events.map(event => [event.issue.iid, event.labelEvents.map(labelEvent => labelEvent.id)])).toEqual([
        [1, []],
        [2, []],
        [1, [10]],
      ]);
    });

    it('reads an unchanged issue until the window passes, without emitting it again', async () => {
      const readsAt = async (secondsAfterUpdate: number) => {
        gitlab.requests = [];
        await pollAt(secondsAfterUpdate);

        return gitlab.labelEventReads();
      };

      expect(await readsAt(5)).toEqual([1]);
      expect(await readsAt(35)).toEqual([1]);
      expect(await readsAt(SILENT_EDIT_WINDOW_MS / 1000)).toEqual([1]);
      expect(await readsAt(SILENT_EDIT_WINDOW_MS / 1000 + 60)).toEqual([]);
      expect(events).toHaveLength(1);
    });

    it('emits a silent change to an issue in the retry set, and only once', async () => {
      emit.mockImplementationOnce(() => Promise.reject(new Error('database down')));
      await pollAt(15);

      gitlab.issues[0].labels = ['workflow::in-progress'];
      gitlab.labelEvents.get(1)?.push({
        id: 12,
        action: 'add',
        created_at: '2026-10-14T10:00:30.000Z',
        label: { name: 'workflow::in-progress' },
      });

      await pollAt(35);
      await pollAt(SILENT_EDIT_WINDOW_MS / 1000 + 5);

      expect(events.map(event => [event.issue.labels, event.labelEvents.map(labelEvent => labelEvent.id)])).toEqual([
        [['workflow::in-progress'], [10, 12]],
      ]);
    });

    it('reads every issue again while GitLab sends no Date header', async () => {
      const listedWithoutDate = gitlab.fetch.getMockImplementation();
      gitlab.fetch.mockImplementation(async (input, init) => {
        const response = await listedWithoutDate?.(input, init);
        const headers = new Headers(response?.headers);
        headers.delete('date');

        return new Response(await response?.text(), { status: response?.status, headers });
      });

      await pollAt(SILENT_EDIT_WINDOW_MS / 1000 + 60);
      gitlab.requests = [];
      await pollAt(SILENT_EDIT_WINDOW_MS / 1000 + 120);
      await pollAt(SILENT_EDIT_WINDOW_MS / 1000 + 180);

      expect(gitlab.labelEventReads()).toEqual([1, 1]);
      expect(events).toHaveLength(1);
      expect(logged.filter(([, message]) => String(message).includes('no Date header'))).toHaveLength(1);
    });
  });

  it('advances past an issue a handler rejects, and reads that issue again by iid', async () => {
    gitlab.issues = [
      { iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' },
      { iid: 2, state: 'opened', labels: [], updated_at: '2026-10-14T11:00:00.000Z' },
    ];
    emit.mockImplementationOnce(() => Promise.reject(new Error('database down')));

    await source.poll(config, emit, signal);

    expect(events.map(event => event.issue.iid)).toEqual([2]);

    gitlab.requests = [];
    await source.poll(config, emit, signal);

    const [listing, retry] = gitlab.issueListings();
    expect(listing.searchParams.has('updated_after')).toBe(true);
    expect(retry.searchParams.getAll('iids[]')).toEqual(['1']);
    expect(events.map(event => event.issue.iid)).toEqual([2, 1]);
  });

  it('gives up on an issue after MAX_ISSUE_ATTEMPTS, while the others still flow', async () => {
    gitlab.issues = [
      { iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' },
      { iid: 2, state: 'opened', labels: [], updated_at: '2026-10-14T11:00:00.000Z' },
    ];
    emit.mockImplementation((event: ISourceEvent) =>
      issueOf(event).iid === 1
        ? Promise.reject(new Error('poison'))
        : Promise.resolve(void events.push(event as IIssueEvent))
    );

    for (let poll = 0; poll < MAX_ISSUE_ATTEMPTS + 2; poll++) {
      await source.poll(config, emit, signal);
    }

    const attemptsOnPoison = emit.mock.calls.filter(([event]) => issueOf(event).iid === 1);
    expect(attemptsOnPoison).toHaveLength(MAX_ISSUE_ATTEMPTS);
    expect(events.map(event => event.issue.iid)).toEqual([2]);
    expect(JSON.stringify(logged)).toContain('Giving up on the issue');
  });

  it('stops retrying a given-up issue that the overlap still lists', async () => {
    gitlab.issues = [
      { iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' },
      { iid: 2, state: 'opened', labels: [], updated_at: '2026-10-14T11:00:00.000Z' },
    ];
    emit.mockImplementation((event: ISourceEvent) =>
      issueOf(event).iid === 2
        ? Promise.reject(new Error('poison'))
        : Promise.resolve(void events.push(event as IIssueEvent))
    );

    for (let poll = 0; poll < MAX_ISSUE_ATTEMPTS + 3; poll++) {
      await source.poll(config, emit, signal);
    }

    const attemptsOnPoison = emit.mock.calls.filter(([event]) => issueOf(event).iid === 2);
    expect(attemptsOnPoison).toHaveLength(MAX_ISSUE_ATTEMPTS);
    expect(gitlab.labelEventReads().filter(iid => iid === 2)).toHaveLength(MAX_ISSUE_ATTEMPTS);
  });

  it('logs a failed project and polls the rest, without rejecting', async () => {
    gitlab.issues = [{ iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' }];

    await source.poll({ ...config, projects: ['group/missing', 'group/project'] }, emit, signal);

    expect(events.map(event => event.issue.iid)).toEqual([1]);
    const failure = logged.find(([context]) => JSON.stringify(context).includes('group/missing'));
    expect(JSON.stringify(failure)).toContain('GitLab answered 404');
  });

  it('keeps a separate watermark for each source', async () => {
    gitlab.issues = [{ iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' }];

    await source.poll(config, emit, signal);
    await source.poll({ ...config, name: 'gitlab-other' }, emit, signal);

    expect(events.map(event => [event.source, event.issue.iid])).toEqual([
      ['gitlab-local', 1],
      ['gitlab-other', 1],
    ]);
  });

  it.each(['resource_label_events', 'notes'])(
    'emits an issue again on the next poll when reading its %s fails',
    async read => {
      gitlab.issues = [
        { iid: 1, state: 'opened', labels: ['workflow::ready'], updated_at: '2026-10-14T10:00:00.000Z' },
      ];
      gitlab.labelEvents.set(1, [
        { id: 10, action: 'add', created_at: '2026-10-14T10:00:00.000Z', label: { name: 'workflow::ready' } },
      ]);
      gitlab.notes.set(1, [
        { id: 20, body: 'assigned to @swarmfoundry-bot', system: true, created_at: '2026-10-14T10:00:00.000Z' },
      ]);
      gitlab.failures.set(`/api/v4/projects/7/issues/1/${read}`, 500);

      await source.poll(config, emit, signal);

      gitlab.failures.clear();
      await source.poll(config, emit, signal);

      expect(gitlab.issueListings()[1].searchParams.has('updated_after')).toBe(true);
      expect(
        events.map(event => [event.labelEvents.map(({ id }) => id), event.assignments.map(({ id }) => id)])
      ).toEqual([[[10], [20]]]);
    }
  );

  describe('saved watermark', () => {
    it("starts a project with none from GitLab's clock plus the overlap, and emits nothing from before it", async () => {
      watermarks.initial = null;
      gitlab.issues = [
        { iid: 1, state: 'opened', labels: ['workflow::ready'], updated_at: '2026-10-14T10:00:00.000Z' },
      ];

      await source.poll(config, emit, signal);

      const started = new Date(gitlab.now.getTime() + WATERMARK_OVERLAP_MS);
      expect(events).toEqual([]);
      expect(gitlab.labelEventReads()).toEqual([]);
      expect(watermarks.saved).toEqual([started]);

      gitlab.issues.push({ iid: 2, state: 'opened', labels: [], updated_at: '2026-10-14T13:00:30.000Z' });
      await source.poll(config, emit, signal);

      expect(gitlab.issueListings()[1].searchParams.get('updated_after')).toBe(gitlab.now.toISOString());
      expect(events.map(event => event.issue.iid)).toEqual([2]);
    });

    it('keeps its start when the first write fails, and writes it on the next poll', async () => {
      watermarks.initial = null;
      vi.spyOn(watermarks, 'save').mockRejectedValueOnce(new Error('database down'));

      await source.poll(config, emit, signal);

      gitlab.issues = [{ iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T13:00:30.000Z' }];
      await source.poll(config, emit, signal);

      expect(gitlab.issueListings()[1].searchParams.get('updated_after')).toBe(gitlab.now.toISOString());
      expect(events.map(event => event.issue.iid)).toEqual([1]);
      expect(watermarks.saved).toEqual([new Date(gitlab.now.getTime() + WATERMARK_OVERLAP_MS)]);
    });

    it('saves the newest updated_at, and only when it moves', async () => {
      gitlab.issues = [{ iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' }];

      await source.poll(config, emit, signal);
      await source.poll(config, emit, signal);

      expect(watermarks.saved).toEqual([new Date('2026-10-14T10:00:00.000Z')]);
    });

    it('lists after a restart only issues changed since the saved watermark, less the overlap', async () => {
      gitlab.issues = [
        { iid: 1, state: 'opened', labels: ['workflow::ready'], updated_at: '2026-10-14T10:00:00.000Z' },
        { iid: 2, state: 'opened', labels: [], updated_at: '2026-10-14T11:00:00.000Z' },
      ];
      await source.poll(config, emit, signal);

      // Changed while the orchestrator was down.
      gitlab.issues[0] = { ...gitlab.issues[0], labels: ['workflow::review'], updated_at: '2026-10-14T12:00:00.000Z' };
      gitlab.requests = [];
      events = [];

      await newService().poll(config, emit, signal);

      expect(gitlab.issueListings()[0].searchParams.get('updated_after')).toBe(
        new Date(Date.parse('2026-10-14T11:00:00.000Z') - WATERMARK_OVERLAP_MS).toISOString()
      );
      expect(events.map(event => [event.issue.iid, event.issue.labels])).toEqual([
        [2, []],
        [1, ['workflow::review']],
      ]);
    });

    it('emits a ticket labelled long before the watermark with the assignment made after a restart alone', async () => {
      gitlab.issues = [
        { iid: 1, state: 'opened', labels: ['workflow::ready'], updated_at: '2026-10-14T11:00:00.000Z' },
      ];
      gitlab.labelEvents.set(1, [
        { id: 10, action: 'add', created_at: '2026-10-14T09:00:00.000Z', label: { name: 'workflow::ready' } },
      ]);
      await source.poll(config, emit, signal);

      gitlab.issues[0] = {
        ...gitlab.issues[0],
        assignees: [{ username: 'swarmfoundry-bot' }],
        updated_at: '2026-10-14T12:00:00.000Z',
      };
      gitlab.notes.set(1, [
        { id: 20, body: 'assigned to @swarmfoundry-bot', system: true, created_at: '2026-10-14T12:00:00.000Z' },
      ]);
      events = [];
      await newService().poll(config, emit, signal);

      expect(
        events.map(event => [event.labelEvents.map(({ id }) => id), event.assignments.map(({ id }) => id)])
      ).toEqual([[[], [20]]]);
    });

    it('emits an assignment GitLab made without moving updated_at, across a restart', async () => {
      const updatedAt = '2026-10-14T10:00:00.000Z';
      gitlab.issues = [{ iid: 1, state: 'opened', labels: ['workflow::ready'], updated_at: updatedAt }];
      gitlab.labelEvents.set(1, [{ id: 10, action: 'add', created_at: updatedAt, label: { name: 'workflow::ready' } }]);
      gitlab.now = new Date('2026-10-14T10:00:15.000Z');
      await source.poll(config, emit, signal);

      gitlab.issues[0].assignees = [{ username: 'swarmfoundry-bot' }];
      gitlab.now = new Date('2026-10-14T10:00:45.000Z');
      await newService().poll(config, emit, signal);

      expect(events.map(event => [event.issue.assignees, event.labelEvents.map(labelEvent => labelEvent.id)])).toEqual([
        [[], [10]],
        [['swarmfoundry-bot'], [10]],
      ]);
    });

    it('holds the saved watermark at the one the poll began from while an issue awaits a retry, so a restart reads it again', async () => {
      gitlab.issues = [
        { iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' },
        { iid: 2, state: 'opened', labels: [], updated_at: '2026-10-14T11:00:00.000Z' },
      ];
      emit.mockImplementationOnce(() => Promise.reject(new Error('database down')));

      await source.poll(config, emit, signal);

      expect(watermarks.saved).toEqual([]);

      events = [];
      await newService().poll(config, emit, signal);

      // Issue 2 comes again with it, and dedup absorbs it.
      expect(events.map(event => event.issue.iid)).toEqual([1, 2]);
      expect(watermarks.saved.at(-1)).toEqual(new Date('2026-10-14T11:00:00.000Z'));
    });

    it('logs a failed write after emitting, and writes it on the next poll', async () => {
      gitlab.issues = [{ iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' }];
      const save = vi.spyOn(watermarks, 'save').mockRejectedValueOnce(new Error('database down'));

      await source.poll(config, emit, signal);

      expect(events.map(event => event.issue.iid)).toEqual([1]);
      expect(JSON.stringify(logged)).toContain('Failed to poll the project');

      await source.poll(config, emit, signal);

      expect(save).toHaveBeenCalledTimes(2);
      expect(watermarks.saved).toEqual([new Date('2026-10-14T10:00:00.000Z')]);
    });

    it('retains the issue watermarks of the configured projects once each has loaded, and only when they change', async () => {
      await source.poll({ ...config, projects: ['group/project', 'group/missing'] }, emit, signal);

      expect(watermarks.retained).toEqual([]);

      await source.poll(config, emit, signal);
      await source.poll(config, emit, signal);

      expect(watermarks.retained).toEqual([[7]]);

      source.forget(config.name);
      await source.poll(config, emit, signal);

      expect(watermarks.retained).toEqual([[7], [7]]);
    });

    it('logs a failed removal and resolves', async () => {
      vi.spyOn(watermarks, 'retainProjects').mockRejectedValueOnce(new Error('database down'));

      await expect(source.poll(config, emit, signal)).resolves.toBeUndefined();
      expect(JSON.stringify(logged)).toContain('Failed to remove the issue watermarks');
    });
  });

  describe('merge requests', () => {
    const delegate = () => ({
      poll: vi.fn(() => Promise.resolve()),
      retainProjects: vi.fn(() => Promise.resolve()),
      forget: vi.fn(),
    });

    const withDelegate = (mergeRequests: ReturnType<typeof delegate>) =>
      new GitLabSourceService(
        new GitLabApiService(),
        mergeRequests as unknown as GitLabMergeRequestSourceService,
        watermarks as unknown as SourceWatermarkService,
        foundryConfigService
      );

    const mergeRequestTrigger = (projects: string[] = [], sourceName = 'gitlab-local') => ({
      source: { name: sourceName },
      mergeRequest: { event: 'merged', labels: [], notLabels: [], projects },
    });

    const project = { id: 7, path: 'group/project', url: 'https://gitlab.test/group/project' };

    afterEach(() => {
      triggers = [];
    });

    it("polls a project's merge requests with the project it loaded, even when its issues fail", async () => {
      triggers = [mergeRequestTrigger()];
      const mergeRequests = delegate();
      gitlab.failures.set('/api/v4/projects/7/issues', 500);

      await withDelegate(mergeRequests).poll(config, emit, signal);

      expect(mergeRequests.poll).toHaveBeenCalledWith(config, project, new Set(['merged']), emit, signal);
      expect(mergeRequests.retainProjects).toHaveBeenCalledWith(config, [7], [], true);
    });

    it('polls a project its trigger lists in any case, for every event its triggers watch', async () => {
      triggers = [
        mergeRequestTrigger(['Group/Project']),
        { ...mergeRequestTrigger(), mergeRequest: { event: 'opened', labels: [], notLabels: [], projects: [] } },
      ];
      const mergeRequests = delegate();

      await withDelegate(mergeRequests).poll(config, emit, signal);

      expect(mergeRequests.poll).toHaveBeenCalledWith(config, project, new Set(['merged', 'opened']), emit, signal);
    });

    it('polls no project no merge request trigger on the source applies to, and retains none of its watermarks', async () => {
      triggers = [
        mergeRequestTrigger(['group/other']),
        mergeRequestTrigger([], 'gitlab-other'),
        { source: { name: 'gitlab-local' }, issue: { labels: ['workflow::ready'] } },
      ];
      const mergeRequests = delegate();

      await withDelegate(mergeRequests).poll(config, emit, signal);

      expect(mergeRequests.poll).not.toHaveBeenCalled();
      expect(mergeRequests.retainProjects).toHaveBeenCalledWith(config, [], [7], true);
    });

    it('polls no merge request and retains incompletely while a watched project has not loaded', async () => {
      triggers = [mergeRequestTrigger()];
      const mergeRequests = delegate();
      gitlab.failures.set('/api/v4/projects/group%2Fproject', 500);

      await withDelegate(mergeRequests).poll(config, emit, signal);

      expect(gitlab.requests.filter(url => url.pathname === '/api/v4/projects/group%2Fproject')).toHaveLength(1);
      expect(mergeRequests.poll).not.toHaveBeenCalled();
      expect(mergeRequests.retainProjects).toHaveBeenCalledWith(config, [], [], false);
    });

    it('logs a failed merge request poll, redacted, and still retains the project', async () => {
      triggers = [mergeRequestTrigger()];
      const mergeRequests = delegate();
      mergeRequests.poll.mockRejectedValueOnce(new Error(`GitLab said no to ${TOKEN}`));

      await withDelegate(mergeRequests).poll(config, emit, signal);

      expect(JSON.stringify(logged)).toContain("Failed to poll the project's merge requests");
      expect(JSON.stringify(logged)).not.toContain(TOKEN);
      expect(mergeRequests.retainProjects).toHaveBeenCalledWith(config, [7], [], true);
    });

    it('logs a failed watermark removal and resolves', async () => {
      const mergeRequests = delegate();
      mergeRequests.retainProjects.mockRejectedValueOnce(new Error('database down'));

      await expect(withDelegate(mergeRequests).poll(config, emit, signal)).resolves.toBeUndefined();
      expect(JSON.stringify(logged)).toContain('Failed to remove the watermarks of unwatched projects');
    });

    it("forgets the source's merge request state with its issue state", () => {
      const mergeRequests = delegate();

      withDelegate(mergeRequests).forget('gitlab-local');

      expect(mergeRequests.forget).toHaveBeenCalledWith('gitlab-local');
    });
  });

  describe('readIssue', () => {
    it('reads whether the issue is open, its labels and its assignees', async () => {
      gitlab.issues = [
        {
          iid: 1,
          state: 'opened',
          labels: ['workflow::review'],
          assignees: [{ username: 'swarmfoundry-bot' }],
          updated_at: '2026-10-14T12:00:00.000Z',
        },
        { iid: 2, state: 'closed', labels: [], updated_at: '2026-10-14T12:00:00.000Z' },
      ];

      await expect(source.readIssue(config, 7, 1, signal)).resolves.toEqual({
        open: true,
        labels: ['workflow::review'],
        assignees: ['swarmfoundry-bot'],
      });
      await expect(source.readIssue(config, 7, 2, signal)).resolves.toEqual({ open: false, labels: [], assignees: [] });
    });

    it('reads null for an issue GitLab does not have', async () => {
      await expect(source.readIssue(config, 7, 99, signal)).resolves.toBeNull();
    });
  });

  describe('writes', () => {
    it('relabels in one update', async () => {
      const update = vi.spyOn(GitLabApiService.prototype, 'updateIssue').mockResolvedValue(undefined);

      await source.relabel(config, 7, 1, ['workflow::test', 'merged'], ['workflow::review'], signal);

      expect(update).toHaveBeenCalledWith(
        config,
        7,
        1,
        { addLabels: ['workflow::test', 'merged'], removeLabels: ['workflow::review'] },
        signal
      );
    });

    it('sends no label list it was given empty', async () => {
      const update = vi.spyOn(GitLabApiService.prototype, 'updateIssue').mockResolvedValue(undefined);

      await source.relabel(config, 7, 1, [], ['workflow::review'], signal);

      expect(update).toHaveBeenCalledWith(
        config,
        7,
        1,
        { addLabels: undefined, removeLabels: ['workflow::review'] },
        signal
      );
    });

    it("assigns by the users' ids, replacing the assignees", async () => {
      vi.spyOn(GitLabApiService.prototype, 'findUserId').mockImplementation((_connection, username) =>
        Promise.resolve(username === 'grace' ? 12 : 13)
      );
      const update = vi.spyOn(GitLabApiService.prototype, 'updateIssue').mockResolvedValue(undefined);

      await source.assign(config, 7, 1, ['grace', 'swarmfoundry-bot'], signal);

      expect(update).toHaveBeenCalledWith(config, 7, 1, { assigneeIds: [12, 13] }, signal);
    });

    it('rejects naming a username GitLab has no user for, and assigns no one', async () => {
      vi.spyOn(GitLabApiService.prototype, 'findUserId').mockResolvedValue(null);
      const update = vi.spyOn(GitLabApiService.prototype, 'updateIssue').mockResolvedValue(undefined);

      await expect(source.assign(config, 7, 1, ['nobody'], signal)).rejects.toThrow('GitLab has no user nobody');
      expect(update).not.toHaveBeenCalled();
    });
  });

  it('rejects when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(source.poll(config, emit, controller.signal)).rejects.toThrow();
  });

  it('never logs the token, even when an error carries it', async () => {
    gitlab.fetch.mockImplementationOnce(() => Promise.reject(new Error(`connect failed for ${TOKEN}`)));
    gitlab.issues = [{ iid: 1, state: 'opened', labels: [], updated_at: '2026-10-14T10:00:00.000Z' }];
    emit.mockImplementationOnce(() => Promise.reject(new Error(`handler saw ${TOKEN}`)));

    await source.poll(config, emit, signal);
    await source.poll(config, emit, signal);

    expect(logged.length).toBeGreaterThan(1);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });
});
