import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitLabApiService } from './gitlab-api.service';
import type { GitLabMergeRequestSourceService } from './gitlab-merge-request-source.service';
import { GitLabSourceService } from './gitlab-source.service';
import { IssueSourceService } from './issue-source.service';
import type { SourceWatermarkService } from './source-watermark.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';

import { WATERMARK_OVERLAP_MS } from './gitlab-polling.constants';
import type { IIssueEvent } from './issue-source.types';
import type { ISourceConfig } from '@/core/foundry-config/foundry-config.types';

const TOKEN = 'glpat-orchestrator-secret';
const POLL_INTERVAL_MS = 30_000;
const SAVED_WATERMARK = '2026-10-14T09:00:00.000Z';

const source: ISourceConfig = {
  name: 'gitlab-local',
  type: 'gitlab',
  url: 'https://gitlab.test',
  token: TOKEN,
  pollInterval: POLL_INTERVAL_MS,
  projects: ['group/project'],
};

interface IFakeConfig {
  sources: ISourceConfig[];
  listeners: Set<() => void>;
}

const foundryConfigWith = (config: IFakeConfig) =>
  ({
    get sources() {
      return config.sources;
    },
    triggers: [],
    onSwap: (listener: () => void) => {
      config.listeners.add(listener);

      return () => config.listeners.delete(listener);
    },
    redact: (value: unknown) => (typeof value === 'string' ? value.replaceAll(TOKEN, '[redacted]') : value),
  }) as unknown as FoundryConfigService;

const mergeRequestSource = {
  poll: () => Promise.resolve(),
  retainProjects: () => Promise.resolve(),
  forget: () => undefined,
} as unknown as GitLabMergeRequestSourceService;

let fakeConfig: IFakeConfig;
let retainSources: ReturnType<typeof vi.fn<(names: readonly string[]) => Promise<void>>>;

const serviceWith = (sources: ISourceConfig[]) => {
  fakeConfig = { sources, listeners: new Set() };
  const foundryConfigService = foundryConfigWith(fakeConfig);

  retainSources = vi.fn<(names: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);

  const watermarks = {
    find: () => Promise.resolve(new Date(SAVED_WATERMARK)),
    save: () => Promise.resolve(),
    retainProjects: () => Promise.resolve(),
    retainSources,
  } as unknown as SourceWatermarkService;

  return new IssueSourceService(
    foundryConfigService,
    new GitLabSourceService(new GitLabApiService(), mergeRequestSource, watermarks, foundryConfigService),
    watermarks
  );
};

const swapTo = (sources: ISourceConfig[]) => {
  fakeConfig.sources = sources;

  for (const listener of fakeConfig.listeners) {
    listener();
  }
};

const listingsOf = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(input instanceof Request ? input.url : input))
    .filter(url => url.pathname.endsWith('/issues'));

const issue = {
  iid: 1,
  title: 'Issue 1',
  state: 'opened',
  labels: [],
  assignees: [],
  web_url: 'https://gitlab.test/i/1',
};

describe('IssueSourceService', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let issueStatus: number;
  let updatedAt: string;
  let logged: unknown[][];

  beforeEach(() => {
    vi.useFakeTimers();

    issueStatus = 200;
    updatedAt = '2026-10-14T10:00:00.000Z';

    fetchMock = vi.fn<typeof fetch>((input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.pathname.endsWith('/resource_label_events') || url.pathname.endsWith('/notes')) {
        return Promise.resolve(Response.json([]));
      }

      if (url.pathname.endsWith('/issues')) {
        return Promise.resolve(
          issueStatus === 200
            ? Response.json([{ ...issue, updated_at: updatedAt }])
            : new Response('{}', { status: issueStatus })
        );
      }

      return Promise.resolve(
        Response.json({ id: 7, path_with_namespace: 'group/project', web_url: 'https://gitlab.test' })
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stays idle with no sources configured', async () => {
    const service = serviceWith([]);

    const stop = service.start(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(fetchMock).not.toHaveBeenCalled();
    await stop();
  });

  it('polls nothing until started', async () => {
    serviceWith([source]);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls once started and again every pollInterval, handing each event to the handler', async () => {
    const service = serviceWith([source]);
    const events: IIssueEvent[] = [];

    const stop = service.start(event => Promise.resolve(void events.push(event as IIssueEvent)));
    await vi.advanceTimersByTimeAsync(0);

    expect(events.map(event => event.issue.iid)).toEqual([1]);

    updatedAt = '2026-10-14T10:01:00.000Z';
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(events).toHaveLength(2);
    await stop();
  });

  it('refuses a second start', async () => {
    const service = serviceWith([source]);

    const stop = service.start(() => Promise.resolve());

    expect(() => service.start(() => Promise.resolve())).toThrow('already started');
    await stop();
  });

  it('keeps polling after a failed poll', async () => {
    const service = serviceWith([source]);
    const events: IIssueEvent[] = [];
    issueStatus = 500;

    const stop = service.start(event => Promise.resolve(void events.push(event as IIssueEvent)));
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toHaveLength(0);

    issueStatus = 200;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(events).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
    await stop();
  });

  it('waits on shutdown for a handler in flight, then polls no more', async () => {
    const service = serviceWith([source]);
    let release: () => void = () => undefined;
    let finished = false;

    service.start(
      () =>
        new Promise<void>(resolve => {
          release = () => {
            finished = true;
            resolve();
          };
        })
    );
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const shutdown = service.beforeApplicationShutdown().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(stopped).toBe(false);

    release();
    await shutdown;

    expect(finished).toBe(true);

    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  describe('on a config swap', () => {
    it('restarts a changed source at once, from its saved watermark, and polls it with its new fields', async () => {
      const service = serviceWith([source]);

      const stop = service.start(() => Promise.resolve());
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(listingsOf(fetchMock).at(-1)?.searchParams.has('updated_after')).toBe(true);

      fetchMock.mockClear();
      swapTo([{ ...source, pollInterval: POLL_INTERVAL_MS * 2 }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(listingsOf(fetchMock)).toHaveLength(1);
      expect(listingsOf(fetchMock)[0].searchParams.get('updated_after')).toBe(
        new Date(Date.parse(SAVED_WATERMARK) - WATERMARK_OVERLAP_MS).toISOString()
      );

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(listingsOf(fetchMock)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(listingsOf(fetchMock)).toHaveLength(2);
      await stop();
    });

    it('leaves an unchanged source on its schedule', async () => {
      const service = serviceWith([source]);

      const stop = service.start(() => Promise.resolve());
      await vi.advanceTimersByTimeAsync(0);

      fetchMock.mockClear();
      swapTo([{ ...source, projects: [...source.projects] }]);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);

      expect(fetchMock).not.toHaveBeenCalled();
      await stop();
    });

    it('stops polling a removed source and starts polling an added one', async () => {
      const added: ISourceConfig = { ...source, name: 'gitlab-other', url: 'https://other.test' };
      const service = serviceWith([source]);

      const stop = service.start(() => Promise.resolve());
      await vi.advanceTimersByTimeAsync(0);

      fetchMock.mockClear();
      swapTo([added]);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

      const hosts = new Set(listingsOf(fetchMock).map(url => url.host));

      expect(hosts).toEqual(new Set(['other.test']));
      await stop();
    });

    it('waits for the running poll of a changed source before starting its new loop', async () => {
      const service = serviceWith([source]);
      let release: () => void = () => undefined;
      let handled = 0;

      const stop = service.start(
        () =>
          new Promise<void>(resolve => {
            handled++;
            release = resolve;
          })
      );
      await vi.advanceTimersByTimeAsync(0);

      fetchMock.mockClear();
      swapTo([{ ...source, pollInterval: POLL_INTERVAL_MS * 2 }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(listingsOf(fetchMock)).toHaveLength(0);

      release();
      await vi.advanceTimersByTimeAsync(0);

      expect(listingsOf(fetchMock)).toHaveLength(1);
      expect(handled).toBe(2);

      release();
      await stop();
    });

    it('follows no swap after stopping', async () => {
      const service = serviceWith([source]);

      await service.start(() => Promise.resolve())();

      fetchMock.mockClear();
      swapTo([{ ...source, pollInterval: POLL_INTERVAL_MS * 2 }]);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('watermarks', () => {
    it("keeps only the configured sources' watermarks at start and after each swap", async () => {
      const service = serviceWith([source]);

      const stop = service.start(() => Promise.resolve());
      await vi.advanceTimersByTimeAsync(0);

      expect(retainSources).toHaveBeenCalledWith(['gitlab-local']);

      swapTo([{ ...source, name: 'gitlab-other' }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(retainSources).toHaveBeenLastCalledWith(['gitlab-other']);
      await stop();
    });

    it('keeps every watermark while no source is configured, as when the config is missing', async () => {
      const service = serviceWith([]);

      const stop = service.start(() => Promise.resolve());
      await vi.advanceTimersByTimeAsync(0);

      expect(retainSources).not.toHaveBeenCalled();
      await stop();
    });

    it('logs a failed removal and keeps polling', async () => {
      const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const service = serviceWith([source]);
      retainSources.mockRejectedValue(new Error('database down'));
      const events: IIssueEvent[] = [];

      const stop = service.start(event => Promise.resolve(void events.push(event as IIssueEvent)));
      await vi.advanceTimersByTimeAsync(0);

      expect(events).toHaveLength(1);
      expect(logError).toHaveBeenCalledWith(
        expect.anything(),
        'retainWatermarks(): Failed to remove the watermarks of removed sources'
      );
      await stop();
    });
  });

  it('warns when a source sends its token over plain http', async () => {
    const service = serviceWith([{ ...source, url: 'http://gitlab.test' }]);

    await service.start(() => Promise.resolve())();

    expect(JSON.stringify(logged)).toContain('plain http');
  });
});
