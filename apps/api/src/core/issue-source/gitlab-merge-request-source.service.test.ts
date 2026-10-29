import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WatermarkKind } from './entities/source-watermark.entity';

import { GitLabApiService } from './gitlab-api.service';
import {
  GitLabMergeRequestSourceService,
  MAX_MERGE_REQUEST_ATTEMPTS,
  MERGE_REQUEST_OVERLAP_MS,
} from './gitlab-merge-request-source.service';
import type { SourceWatermarkService } from './source-watermark.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';

import type { IIssueProject, IMergeRequestEvent, ISourceEvent } from './issue-source.types';
import type { ISourceConfig, MergeRequestEventKind } from '@/core/foundry-config/foundry-config.types';

const TOKEN = 'glpat-orchestrator-secret';

const config: ISourceConfig = {
  name: 'gitlab-local',
  type: 'gitlab',
  url: 'https://gitlab.test/',
  token: TOKEN,
  pollInterval: 60_000,
  projects: ['group/project'],
};

const BOTH: ReadonlySet<MergeRequestEventKind> = new Set(['opened', 'merged']);

const project: IIssueProject = { id: 7, path: 'group/project', url: 'https://gitlab.test/group/project' };

const WATERMARK = new Date('2026-10-22T11:00:00.000Z');
const NOW = new Date(WATERMARK.getTime() + 10 * 60_000).toISOString();
const BEFORE_WINDOW = new Date(WATERMARK.getTime() - MERGE_REQUEST_OVERLAP_MS - 1000).toISOString();

interface IFakeMergeRequest {
  iid: number;
  title?: string;
  state: string;
  labels?: string[];
  target_branch?: string;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
}

interface IFakeRelatedIssue {
  iid: number;
  project_id: number;
  title: string;
}

class FakeGitLab {
  mergeRequests: IFakeMergeRequest[] = [];
  related = new Map<number, IFakeRelatedIssue[]>();
  issues = new Map<number, string>();
  failures = new Map<string, number>();
  requests: URL[] = [];
  now = new Date(NOW);
  sendsDate = true;

  readonly fetch = vi.fn((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    this.requests.push(url);

    const failure = this.failures.get(url.pathname);

    if (failure !== undefined) {
      return Promise.resolve(new Response('{}', { status: failure }));
    }

    if (url.pathname === '/api/v4/projects/7/merge_requests') {
      const updatedAfter = url.searchParams.get('updated_after');
      const listed = this.mergeRequests
        .filter(mergeRequest => updatedAfter === null || mergeRequest.updated_at >= updatedAfter)
        .toSorted((left, right) => right.updated_at.localeCompare(left.updated_at))
        .map(mergeRequest => ({
          title: `Merge request ${mergeRequest.iid}`,
          labels: [],
          target_branch: 'master',
          source_branch: `${mergeRequest.iid}-branch`,
          web_url: `https://gitlab.test/group/project/-/merge_requests/${mergeRequest.iid}`,
          merged_at: null,
          ...mergeRequest,
        }));

      const headers: Record<string, string> = this.sendsDate ? { date: this.now.toUTCString() } : {};

      return Promise.resolve(Response.json(listed, { headers }));
    }

    const related = /^\/api\/v4\/projects\/7\/merge_requests\/(\d+)\/related_issues$/.exec(url.pathname);

    if (related) {
      const issues = (this.related.get(Number(related[1])) ?? []).map(issue => ({
        ...issue,
        web_url: `https://gitlab.test/i/${issue.project_id}/${issue.iid}`,
      }));

      return Promise.resolve(Response.json(issues));
    }

    const issue = /^\/api\/v4\/projects\/7\/issues\/(\d+)$/.exec(url.pathname);
    const title = this.issues.get(Number(issue?.[1]));

    if (issue && title !== undefined) {
      return Promise.resolve(
        Response.json({
          iid: Number(issue[1]),
          title,
          state: 'opened',
          labels: [],
          assignees: [],
          web_url: `https://gitlab.test/group/project/-/issues/${issue[1]}`,
          updated_at: NOW,
        })
      );
    }

    return Promise.resolve(new Response('{}', { status: 404 }));
  });

  listings(): URL[] {
    return this.requests.filter(url => url.pathname.endsWith('/merge_requests'));
  }

  relatedReads(): number[] {
    return this.requests
      .map(url => /merge_requests\/(\d+)\/related_issues$/.exec(url.pathname)?.[1])
      .filter(iid => iid !== undefined)
      .map(Number);
  }
}

class FakeWatermarks {
  readonly rows = new Map<string, Date>();
  readonly saved: Date[] = [];
  readonly retained: number[][] = [];
  readonly removedProjects: number[][] = [];

  find(kind: WatermarkKind, source: ISourceConfig, projectId: number): Promise<Date | null> {
    return Promise.resolve(this.rows.get(`${kind}|${source.name}|${projectId}`) ?? null);
  }

  save(kind: WatermarkKind, source: ISourceConfig, projectId: number, watermark: Date): Promise<void> {
    this.rows.set(`${kind}|${source.name}|${projectId}`, watermark);
    this.saved.push(watermark);

    return Promise.resolve();
  }

  removeProjects(kind: WatermarkKind, source: ISourceConfig, projectIds: readonly number[]): Promise<void> {
    for (const projectId of projectIds) {
      this.rows.delete(`${kind}|${source.name}|${projectId}`);
    }

    this.removedProjects.push([...projectIds]);

    return Promise.resolve();
  }

  retainProjects(kind: WatermarkKind, source: ISourceConfig, projectIds: readonly number[]): Promise<void> {
    for (const key of this.rows.keys()) {
      const [rowKind, sourceName, projectId] = key.split('|');

      if (rowKind === kind && sourceName === source.name && !projectIds.includes(Number(projectId))) {
        this.rows.delete(key);
      }
    }

    this.retained.push([...projectIds]);

    return Promise.resolve();
  }
}

const foundryConfigService = {
  redact: (value: unknown) => (typeof value === 'string' ? value.replaceAll(TOKEN, '[redacted]') : value),
} as unknown as FoundryConfigService;

const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000).toISOString();

describe('GitLabMergeRequestSourceService', () => {
  let gitlab: FakeGitLab;
  let watermarks: FakeWatermarks;
  let source: GitLabMergeRequestSourceService;
  let events: IMergeRequestEvent[];
  let emit: ReturnType<typeof vi.fn<(event: ISourceEvent) => Promise<void>>>;
  let logged: unknown[][];
  const signal = new AbortController().signal;

  const newService = () =>
    new GitLabMergeRequestSourceService(
      new GitLabApiService(),
      watermarks as unknown as SourceWatermarkService,
      foundryConfigService
    );

  const watch = (watermark = WATERMARK) => watermarks.rows.set(`mergeRequest|${config.name}|7`, watermark);

  beforeEach(() => {
    gitlab = new FakeGitLab();
    vi.stubGlobal('fetch', gitlab.fetch);

    watermarks = new FakeWatermarks();

    events = [];
    emit = vi.fn((event: ISourceEvent) => {
      events.push(event as IMergeRequestEvent);

      return Promise.resolve();
    });

    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }

    source = newService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts a project never polled at GitLab's clock and emits nothing from before it", async () => {
    gitlab.mergeRequests = [
      { iid: 1, state: 'merged', created_at: BEFORE_WINDOW, updated_at: BEFORE_WINDOW, merged_at: BEFORE_WINDOW },
    ];

    await source.poll(config, project, BOTH, emit, signal);

    expect(events).toEqual([]);
    expect(watermarks.saved).toEqual([new Date(new Date(NOW).getTime() + MERGE_REQUEST_OVERLAP_MS)]);
    expect(gitlab.relatedReads()).toEqual([]);
  });

  it('fires nothing on the next poll for an event from just before the first poll', async () => {
    await source.poll(config, project, BOTH, emit, signal);

    const justBefore = new Date(new Date(NOW).getTime() - 30_000).toISOString();
    gitlab.mergeRequests = [
      { iid: 1, state: 'merged', created_at: justBefore, updated_at: justBefore, merged_at: justBefore },
    ];
    gitlab.now = new Date(new Date(NOW).getTime() + 60_000);
    await source.poll(config, project, BOTH, emit, signal);

    expect(events).toEqual([]);
  });

  it('emits only the events a trigger watches, and reads no related issue for the others', async () => {
    watch();
    gitlab.mergeRequests = [
      { iid: 3, state: 'opened', created_at: minutesAfter(WATERMARK, 9), updated_at: minutesAfter(WATERMARK, 9) },
      {
        iid: 4,
        state: 'merged',
        created_at: BEFORE_WINDOW,
        updated_at: minutesAfter(WATERMARK, 9),
        merged_at: minutesAfter(WATERMARK, 9),
      },
    ];

    await source.poll(config, project, new Set(['merged']), emit, signal);

    expect(events.map(event => [event.mergeRequest.iid, event.event])).toEqual([[4, 'merged']]);
    expect(gitlab.relatedReads()).toEqual([4]);
  });

  it('emits each merge request opened or merged since the watermark, oldest first, with its related issue', async () => {
    watch();
    gitlab.mergeRequests = [
      {
        iid: 2,
        title: 'Fix the poller (#42)',
        state: 'merged',
        labels: ['backend'],
        created_at: BEFORE_WINDOW,
        updated_at: minutesAfter(WATERMARK, 5),
        merged_at: minutesAfter(WATERMARK, 4),
      },
      { iid: 3, state: 'opened', created_at: minutesAfter(WATERMARK, 2), updated_at: minutesAfter(WATERMARK, 6) },
    ];
    gitlab.related.set(2, [{ iid: 42, project_id: 7, title: 'Fix the poller' }]);

    await source.poll(config, project, BOTH, emit, signal);

    expect(events.map(event => [event.mergeRequest.iid, event.event])).toEqual([
      [3, 'opened'],
      [2, 'merged'],
    ]);
    expect(events[1]).toEqual({
      source: 'gitlab-local',
      project,
      event: 'merged',
      mergeRequest: {
        iid: 2,
        title: 'Fix the poller (#42)',
        url: 'https://gitlab.test/group/project/-/merge_requests/2',
        sourceBranch: '2-branch',
        targetBranch: 'master',
        labels: ['backend'],
      },
      relatedIssue: { iid: 42, title: 'Fix the poller', url: 'https://gitlab.test/i/7/42' },
    });
    expect(events[0].relatedIssue).toBeNull();
    expect(gitlab.listings()[0].searchParams.get('updated_after')).toBe(
      new Date(WATERMARK.getTime() - MERGE_REQUEST_OVERLAP_MS).toISOString()
    );
    expect(gitlab.listings()[0].searchParams.get('state')).toBe('all');
  });

  it('emits nothing for a change to a merge request opened or merged before the window, or closed', async () => {
    watch();
    gitlab.mergeRequests = [
      { iid: 1, state: 'opened', created_at: BEFORE_WINDOW, updated_at: minutesAfter(WATERMARK, 1) },
      {
        iid: 2,
        state: 'merged',
        created_at: BEFORE_WINDOW,
        updated_at: minutesAfter(WATERMARK, 1),
        merged_at: BEFORE_WINDOW,
      },
      { iid: 3, state: 'closed', created_at: minutesAfter(WATERMARK, 1), updated_at: minutesAfter(WATERMARK, 2) },
      { iid: 4, state: 'merged', created_at: BEFORE_WINDOW, updated_at: minutesAfter(WATERMARK, 1), merged_at: null },
    ];

    await source.poll(config, project, BOTH, emit, signal);

    expect(events).toEqual([]);
    expect(gitlab.relatedReads()).toEqual([]);
  });

  it('emits only merged for a merge request opened and merged between two polls', async () => {
    watch();
    const created = minutesAfter(WATERMARK, 1);
    gitlab.mergeRequests = [{ iid: 5, state: 'merged', created_at: created, updated_at: created, merged_at: created }];

    await source.poll(config, project, BOTH, emit, signal);

    expect(events.map(event => event.event)).toEqual(['merged']);
  });

  it('emits an unchanged event once while the overlap lists it again', async () => {
    watch();
    gitlab.mergeRequests = [
      { iid: 3, state: 'opened', created_at: minutesAfter(WATERMARK, 9), updated_at: minutesAfter(WATERMARK, 9) },
    ];

    await source.poll(config, project, BOTH, emit, signal);
    await source.poll(config, project, BOTH, emit, signal);

    expect(events).toHaveLength(1);
    expect(gitlab.listings()).toHaveLength(2);
    expect(gitlab.relatedReads()).toEqual([3]);
  });

  it('emits the event again when its labels or target branch change inside the window', async () => {
    watch();
    const mergeRequest = {
      iid: 3,
      state: 'opened',
      labels: [] as string[],
      created_at: minutesAfter(WATERMARK, 9),
      updated_at: minutesAfter(WATERMARK, 9),
    };
    gitlab.mergeRequests = [mergeRequest];

    await source.poll(config, project, BOTH, emit, signal);

    // GitLab can keep `updated_at` for a label edit soon after the last update.
    mergeRequest.labels = ['review-me'];
    await source.poll(config, project, BOTH, emit, signal);

    gitlab.mergeRequests = [{ ...mergeRequest, target_branch: 'release' }];
    await source.poll(config, project, BOTH, emit, signal);

    expect(events.map(event => [event.mergeRequest.labels, event.mergeRequest.targetBranch])).toEqual([
      [[], 'master'],
      [['review-me'], 'master'],
      [['review-me'], 'release'],
    ]);
  });

  it("moves the watermark to GitLab's clock at each listing, and saves it only when it moves", async () => {
    watch();

    await source.poll(config, project, BOTH, emit, signal);
    await source.poll(config, project, BOTH, emit, signal);

    gitlab.now = new Date(minutesAfter(WATERMARK, 20));
    await source.poll(config, project, BOTH, emit, signal);

    expect(watermarks.saved).toEqual([new Date(NOW), new Date(minutesAfter(WATERMARK, 20))]);
    expect(gitlab.listings()[1].searchParams.get('updated_after')).toBe(
      new Date(new Date(NOW).getTime() - MERGE_REQUEST_OVERLAP_MS).toISOString()
    );
  });

  it('moves the watermark to the newest update listed when GitLab sends no Date header', async () => {
    watch();
    gitlab.sendsDate = false;
    gitlab.mergeRequests = [
      { iid: 3, state: 'closed', created_at: BEFORE_WINDOW, updated_at: minutesAfter(WATERMARK, 4) },
    ];

    await source.poll(config, project, BOTH, emit, signal);

    expect(watermarks.saved).toEqual([new Date(minutesAfter(WATERMARK, 4))]);
  });

  it("starts from the orchestrator's clock when GitLab sends no Date header", async () => {
    gitlab.sendsDate = false;
    const before = Date.now();

    await source.poll(config, project, BOTH, emit, signal);

    expect(watermarks.saved).toHaveLength(1);
    expect(watermarks.saved[0].getTime()).toBeGreaterThanOrEqual(before);
  });

  it('lets an event leave the window in a quiet project, so a later label change fires nothing', async () => {
    watch();
    const opened = {
      iid: 3,
      state: 'opened',
      created_at: minutesAfter(WATERMARK, 9),
      updated_at: minutesAfter(WATERMARK, 9),
    };
    gitlab.mergeRequests = [opened];
    await source.poll(config, project, BOTH, emit, signal);

    gitlab.now = new Date(minutesAfter(WATERMARK, 180));
    await source.poll(config, project, BOTH, emit, signal);

    gitlab.mergeRequests = [{ ...opened, labels: ['ready'], updated_at: minutesAfter(WATERMARK, 181) }];
    await source.poll(config, project, BOTH, emit, signal);

    expect(events).toHaveLength(1);
  });

  it('emits merged once GitLab sets the merged_at it first listed as null', async () => {
    watch();
    const mergedAt = minutesAfter(WATERMARK, 9);
    gitlab.mergeRequests = [
      { iid: 4, state: 'merged', created_at: BEFORE_WINDOW, updated_at: mergedAt, merged_at: null },
    ];
    await source.poll(config, project, BOTH, emit, signal);

    gitlab.mergeRequests = [
      { iid: 4, state: 'merged', created_at: BEFORE_WINDOW, updated_at: mergedAt, merged_at: mergedAt },
    ];
    await source.poll(config, project, BOTH, emit, signal);

    expect(events.map(event => [event.mergeRequest.iid, event.event])).toEqual([[4, 'merged']]);
  });

  it('lists from the saved watermark after a restart, so a merge during the restart is emitted', async () => {
    watch();
    await source.poll(config, project, BOTH, emit, signal);

    gitlab.mergeRequests = [
      {
        iid: 6,
        state: 'merged',
        created_at: BEFORE_WINDOW,
        updated_at: minutesAfter(WATERMARK, 30),
        merged_at: minutesAfter(WATERMARK, 30),
      },
    ];
    gitlab.now = new Date(minutesAfter(WATERMARK, 40));

    await newService().poll(config, project, BOTH, emit, signal);

    expect(events.map(event => [event.mergeRequest.iid, event.event])).toEqual([[6, 'merged']]);
  });

  it('retains the watched projects once per unchanged call, and starts afresh on watching a project again', async () => {
    watch();
    await source.poll(config, project, BOTH, emit, signal);

    await source.retainProjects(config, [7], [], true);
    await source.retainProjects(config, [7], [], true);

    expect(watermarks.retained).toEqual([[7]]);

    await source.retainProjects(config, [], [7], true);

    gitlab.mergeRequests = [
      {
        iid: 6,
        state: 'merged',
        created_at: BEFORE_WINDOW,
        updated_at: minutesAfter(WATERMARK, 30),
        merged_at: minutesAfter(WATERMARK, 30),
      },
    ];
    gitlab.now = new Date(minutesAfter(WATERMARK, 40));
    await source.poll(config, project, BOTH, emit, signal);

    expect(watermarks.retained).toEqual([[7], []]);
    expect(events).toEqual([]);
  });

  it('removes only the unwatched projects it knows while a watched project has not loaded', async () => {
    const retainProjects = vi.spyOn(watermarks, 'retainProjects');

    await source.retainProjects(config, [7], [8], false);

    expect(watermarks.removedProjects).toEqual([[8]]);
    expect(retainProjects).not.toHaveBeenCalled();
  });

  it('removes the watermarks again for the same call once the source is forgotten', async () => {
    await source.retainProjects(config, [7], [], true);
    source.forget(config.name);
    await source.retainProjects(config, [7], [], true);

    expect(watermarks.retained).toEqual([[7], [7]]);
  });

  it('reads the watermark again after forget', async () => {
    watch();
    await source.poll(config, project, BOTH, emit, signal);

    watch(new Date(minutesAfter(WATERMARK, 60)));
    source.forget(config.name);
    await source.poll(config, project, BOTH, emit, signal);

    expect(gitlab.listings()[1].searchParams.get('updated_after')).toBe(
      new Date(new Date(minutesAfter(WATERMARK, 60)).getTime() - MERGE_REQUEST_OVERLAP_MS).toISOString()
    );
  });

  describe('related issue', () => {
    const merged = (title: string) => ({
      iid: 2,
      title,
      state: 'merged',
      created_at: BEFORE_WINDOW,
      updated_at: minutesAfter(WATERMARK, 1),
      merged_at: minutesAfter(WATERMARK, 1),
    });

    beforeEach(() => {
      watch();
    });

    it("prefers the related issue its title ends with, and ignores another project's", async () => {
      gitlab.mergeRequests = [merged('Fix it (#43)')];
      gitlab.related.set(2, [
        { iid: 43, project_id: 8, title: 'Elsewhere' },
        { iid: 41, project_id: 7, title: 'First' },
        { iid: 43, project_id: 7, title: 'Named' },
      ]);

      await source.poll(config, project, BOTH, emit, signal);

      expect(events[0].relatedIssue).toEqual({ iid: 43, title: 'Named', url: 'https://gitlab.test/i/7/43' });
    });

    it('takes the one related issue in its project when the title names none', async () => {
      gitlab.mergeRequests = [merged('Fix it')];
      gitlab.related.set(2, [
        { iid: 9, project_id: 8, title: 'Elsewhere' },
        { iid: 41, project_id: 7, title: 'Only' },
      ]);

      await source.poll(config, project, BOTH, emit, signal);

      expect(events[0].relatedIssue?.iid).toBe(41);
    });

    it('takes no issue when several relate in its project and the title names none, since one may only be mentioned', async () => {
      gitlab.mergeRequests = [merged('Fix it')];
      gitlab.related.set(2, [
        { iid: 41, project_id: 7, title: 'First' },
        { iid: 44, project_id: 7, title: 'Second' },
      ]);

      await source.poll(config, project, BOTH, emit, signal);

      expect(events[0].relatedIssue).toBeNull();
    });

    it("reads the issue its title names when only another project's issues relate", async () => {
      gitlab.mergeRequests = [merged('Fix it (#44)')];
      gitlab.related.set(2, [{ iid: 44, project_id: 8, title: 'Elsewhere' }]);
      gitlab.issues.set(44, 'From the title');

      await source.poll(config, project, BOTH, emit, signal);

      expect(events[0].relatedIssue).toMatchObject({ iid: 44, title: 'From the title' });
    });

    it('retries the event when reading the issue its title names fails with a server error', async () => {
      gitlab.mergeRequests = [merged('Fix it (#44)')];
      gitlab.issues.set(44, 'From the title');
      gitlab.failures.set('/api/v4/projects/7/issues/44', 500);
      await source.poll(config, project, BOTH, emit, signal);

      gitlab.failures.clear();
      await source.poll(config, project, BOTH, emit, signal);

      expect(events.map(event => event.relatedIssue?.iid)).toEqual([44]);
    });

    it('falls back to the issue its title ends with when nothing relates', async () => {
      gitlab.mergeRequests = [merged('Fix it (#44)')];
      gitlab.issues.set(44, 'From the title');

      await source.poll(config, project, BOTH, emit, signal);

      expect(events[0].relatedIssue).toEqual({
        iid: 44,
        title: 'From the title',
        url: 'https://gitlab.test/group/project/-/issues/44',
      });
    });

    it('emits with no issue when GitLab refuses the related issues or the issue its title names', async () => {
      gitlab.mergeRequests = [merged('Fix it (#44)')];
      gitlab.failures.set('/api/v4/projects/7/merge_requests/2/related_issues', 403);
      gitlab.failures.set('/api/v4/projects/7/issues/44', 403);

      await source.poll(config, project, BOTH, emit, signal);

      expect(events.map(event => event.relatedIssue)).toEqual([null]);
    });

    it('emits with no issue when the issue its title names does not exist, or it names none', async () => {
      gitlab.mergeRequests = [merged('Fix it (#45)'), { ...merged('Fix it (#45) for good'), iid: 3 }];

      await source.poll(config, project, BOTH, emit, signal);

      expect(events.map(event => event.relatedIssue)).toEqual([null, null]);
    });
  });

  describe('failures', () => {
    const merged = {
      iid: 2,
      state: 'merged',
      created_at: BEFORE_WINDOW,
      updated_at: minutesAfter(WATERMARK, 9),
      merged_at: minutesAfter(WATERMARK, 9),
    };

    beforeEach(() => {
      watch();
      gitlab.mergeRequests = [merged];
    });

    it('emits a failed event again on the next poll, after the window has moved past it', async () => {
      emit.mockRejectedValueOnce(new Error('database down')).mockRejectedValueOnce(new Error('database down'));
      await source.poll(config, project, BOTH, emit, signal);

      gitlab.now = new Date(minutesAfter(WATERMARK, 60));
      await source.poll(config, project, BOTH, emit, signal);
      await source.poll(config, project, BOTH, emit, signal);

      expect(gitlab.listings()[2].searchParams.get('updated_after')! > merged.merged_at).toBe(true);
      expect(emit).toHaveBeenCalledTimes(3);
      expect(events.map(event => event.mergeRequest.iid)).toEqual([2]);
    });

    it('keeps a failed opened event apart from the merged event of the same merge request', async () => {
      const opened = {
        iid: 3,
        state: 'opened',
        created_at: minutesAfter(WATERMARK, 8),
        updated_at: minutesAfter(WATERMARK, 8),
      };
      gitlab.mergeRequests = [opened];
      emit.mockRejectedValueOnce(new Error('database down'));

      await source.poll(config, project, BOTH, emit, signal);

      gitlab.mergeRequests = [
        { ...opened, state: 'merged', updated_at: minutesAfter(WATERMARK, 9), merged_at: minutesAfter(WATERMARK, 9) },
      ];
      await source.poll(config, project, BOTH, emit, signal);

      expect(events.map(event => [event.mergeRequest.iid, event.event])).toEqual([
        [3, 'opened'],
        [3, 'merged'],
      ]);
    });

    it('retries a failed related issue read, and logs the failure redacted', async () => {
      gitlab.failures.set('/api/v4/projects/7/merge_requests/2/related_issues', 500);
      await source.poll(config, project, BOTH, emit, signal);

      gitlab.failures.clear();
      emit.mockRejectedValueOnce(new Error(`GitLab said no to ${TOKEN}`));
      await source.poll(config, project, BOTH, emit, signal);
      await source.poll(config, project, BOTH, emit, signal);

      expect(events.map(event => event.mergeRequest.iid)).toEqual([2]);
      expect(JSON.stringify(logged)).toContain('retrying it on the next poll');
      expect(JSON.stringify(logged)).toContain('[redacted]');
      expect(JSON.stringify(logged)).not.toContain(TOKEN);
    });

    it('retries a related issue read GitLab rate-limited past its waits, rather than going without the issue', async () => {
      vi.spyOn(GitLabApiService.prototype, 'sleep').mockResolvedValue(undefined);
      gitlab.mergeRequests = [{ ...merged, title: 'Fix it (#42)' }];
      gitlab.related.set(2, [{ iid: 42, project_id: 7, title: 'Fix it' }]);
      gitlab.failures.set('/api/v4/projects/7/merge_requests/2/related_issues', 429);
      await source.poll(config, project, BOTH, emit, signal);

      gitlab.failures.clear();
      await source.poll(config, project, BOTH, emit, signal);

      expect(events.map(event => event.relatedIssue?.iid)).toEqual([42]);
    });

    it('emits without an issue on the last attempt when the related issue read still fails', async () => {
      gitlab.failures.set('/api/v4/projects/7/merge_requests/2/related_issues', 500);

      for (let poll = 0; poll < MAX_MERGE_REQUEST_ATTEMPTS + 1; poll++) {
        await source.poll(config, project, BOTH, emit, signal);
      }

      expect(events.map(event => [event.mergeRequest.iid, event.relatedIssue])).toEqual([[2, null]]);
      expect(gitlab.relatedReads()).toHaveLength(MAX_MERGE_REQUEST_ATTEMPTS);
    });

    it(`keeps retrying an event past ${MAX_MERGE_REQUEST_ATTEMPTS} failures, logging an error and holding the watermark`, async () => {
      emit.mockRejectedValue(new Error('database down'));

      for (let poll = 0; poll < MAX_MERGE_REQUEST_ATTEMPTS + 2; poll++) {
        gitlab.now = new Date(minutesAfter(WATERMARK, 10 + poll * 10));
        await source.poll(config, project, BOTH, emit, signal);
      }

      expect(emit).toHaveBeenCalledTimes(MAX_MERGE_REQUEST_ATTEMPTS + 2);
      expect(JSON.stringify(logged)).toContain('keeps failing');
      expect(watermarks.saved).toEqual([new Date(merged.merged_at)]);

      emit.mockResolvedValue(undefined);
      await source.poll(config, project, BOTH, emit, signal);

      expect(emit).toHaveBeenCalledTimes(MAX_MERGE_REQUEST_ATTEMPTS + 3);
    });

    it('saves the watermark no later than an event awaiting a retry', async () => {
      emit.mockRejectedValueOnce(new Error('database down'));

      await source.poll(config, project, BOTH, emit, signal);

      expect(watermarks.saved).toEqual([new Date(merged.merged_at)]);

      await source.poll(config, project, BOTH, emit, signal);

      expect(watermarks.saved).toEqual([new Date(merged.merged_at), new Date(NOW)]);
    });

    it('rejects when the watermark write fails, after emitting the events', async () => {
      vi.spyOn(watermarks, 'save').mockRejectedValue(new Error('database down'));

      await expect(source.poll(config, project, BOTH, emit, signal)).rejects.toThrow('database down');
      expect(events.map(event => event.mergeRequest.iid)).toEqual([2]);
    });

    it('rejects when the signal aborts while an event is emitted', async () => {
      const controller = new AbortController();
      emit.mockImplementation(() => {
        controller.abort();

        return Promise.reject(new Error('aborted'));
      });

      await expect(source.poll(config, project, BOTH, emit, controller.signal)).rejects.toThrow();
      expect(JSON.stringify(logged)).not.toContain('retrying it on the next poll');
    });

    it('rejects when the listing fails, holding the watermark', async () => {
      gitlab.failures.set('/api/v4/projects/7/merge_requests', 500);

      await expect(source.poll(config, project, BOTH, emit, signal)).rejects.toThrow(/500/);
      expect(watermarks.saved).toEqual([]);
    });
  });
});
