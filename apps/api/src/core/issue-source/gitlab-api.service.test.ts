import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { GitLabApiService, RATE_LIMIT_MAX_RETRIES } from './gitlab-api.service';

import { GitLabApiError } from './gitlab-api.error';

const TOKEN = 'glpat-orchestrator-secret';

const issue = (iid: number, updatedAt = '2026-10-14T10:00:00.000Z') => ({
  iid,
  title: `Issue ${iid}`,
  state: 'opened',
  labels: [],
  assignees: [],
  web_url: `https://gitlab.test/group/project/-/issues/${iid}`,
  updated_at: updatedAt,
});

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

const status = (code: number, headers: Record<string, string> = {}) => new Response('{}', { status: code, headers });

describe('GitLabApiService', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let sleep: MockInstance<GitLabApiService['sleep']>;
  let service: GitLabApiService;
  const connection = { url: 'https://gitlab.test/', token: TOKEN };
  const signal = new AbortController().signal;

  const requestedUrl = (call: number) => {
    const input = fetchMock.mock.calls[call][0];

    return new URL(input instanceof Request ? input.url : input);
  };

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    service = new GitLabApiService();
    sleep = vi.spyOn(service, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the token in a header, refuses redirects and encodes the project path', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ id: 7, path_with_namespace: 'group/project', web_url: 'https://gitlab.test/group/project' })
    );

    const project = await service.getProject(connection, 'group/project', signal);

    expect(project.id).toBe(7);
    expect(requestedUrl(0).href).toBe('https://gitlab.test/api/v4/projects/group%2Fproject');

    const init = fetchMock.mock.calls[0][1]!;
    expect(init.headers).toEqual(expect.objectContaining({ 'PRIVATE-TOKEN': TOKEN }));
    expect(init.redirect).toBe('error');
    expect(requestedUrl(0).href).not.toContain(TOKEN);
  });

  it('follows x-next-page until the last page', async () => {
    fetchMock
      .mockResolvedValueOnce(json([issue(1), issue(2)], { 'x-next-page': '2', date: 'Wed, 14 Oct 2026 10:30:00 GMT' }))
      .mockResolvedValueOnce(json([issue(3)], { 'x-next-page': '3' }))
      .mockResolvedValueOnce(json([issue(4)], { 'x-next-page': '' }));

    const { issues, listedAt } = await service.listIssues(connection, 7, { state: 'opened' }, signal);

    expect(issues.map(item => item.iid)).toEqual([1, 2, 3, 4]);
    expect(listedAt).toEqual(new Date('2026-10-14T10:30:00.000Z'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map(call => requestedUrl(call).searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(requestedUrl(0).searchParams.get('per_page')).toBe('100');
  });

  it('reads no listing time when GitLab sends no Date header', async () => {
    fetchMock.mockResolvedValueOnce(json([issue(1)]));

    const { listedAt } = await service.listIssues(connection, 7, { state: 'opened' }, signal);

    expect(listedAt).toBeNull();
  });

  it('filters by updated_after newest first, and by state only when asked', async () => {
    fetchMock.mockResolvedValueOnce(json([])).mockResolvedValueOnce(json([]));

    await service.listIssues(connection, 7, { updatedAfter: new Date('2026-10-14T09:00:00.000Z') }, signal);
    await service.listIssues(connection, 7, { state: 'opened' }, signal);

    const incremental = requestedUrl(0);
    expect(incremental.pathname).toBe('/api/v4/projects/7/issues');
    expect(incremental.searchParams.get('updated_after')).toBe('2026-10-14T09:00:00.000Z');
    expect(incremental.searchParams.get('order_by')).toBe('updated_at');
    expect(incremental.searchParams.get('sort')).toBe('desc');
    expect(incremental.searchParams.has('state')).toBe(false);

    const full = requestedUrl(1);
    expect(full.searchParams.get('state')).toBe('opened');
    expect(full.searchParams.has('updated_after')).toBe(false);
  });

  it('reads every page of resource label events', async () => {
    const event = (id: number) => ({
      id,
      action: 'add',
      created_at: '2026-10-14T10:00:00.000Z',
      label: { name: `label-${id}` },
    });

    fetchMock.mockResolvedValueOnce(json([event(1)], { 'x-next-page': '2' })).mockResolvedValueOnce(json([event(2)]));

    const events = await service.listLabelEvents(connection, 7, 12, signal);

    expect(events.map(item => item.id)).toEqual([1, 2]);
    expect(requestedUrl(0).pathname).toBe('/api/v4/projects/7/issues/12/resource_label_events');
  });

  it("reads every page of an issue's system notes, oldest first", async () => {
    const note = (id: number) => ({
      id,
      body: 'assigned to @swarmfoundry',
      system: true,
      created_at: '2026-10-14T10:00:00.000Z',
      author: { username: 'ada' },
    });

    fetchMock.mockResolvedValueOnce(json([note(1)], { 'x-next-page': '2' })).mockResolvedValueOnce(json([note(2)]));

    const notes = await service.listSystemNotes(connection, 7, 12, signal);

    expect(notes.map(item => item.id)).toEqual([1, 2]);

    const url = requestedUrl(0);
    expect(url.pathname).toBe('/api/v4/projects/7/issues/12/notes');
    expect(url.searchParams.get('activity_filter')).toBe('only_activity');
    expect(url.searchParams.get('order_by')).toBe('created_at');
    expect(url.searchParams.get('sort')).toBe('asc');
  });

  describe('one issue', () => {
    it('reads the issue by iid', async () => {
      fetchMock.mockResolvedValueOnce(json(issue(3)));

      await expect(service.getIssue(connection, 7, 3, signal)).resolves.toMatchObject({ iid: 3, state: 'opened' });
      expect(requestedUrl(0).pathname).toBe('/api/v4/projects/7/issues/3');
    });

    it('reads null for a 404', async () => {
      fetchMock.mockResolvedValueOnce(status(404));

      await expect(service.getIssue(connection, 7, 3, signal)).resolves.toBeNull();
    });

    it('updates an issue with PUT, keeping the token in the header', async () => {
      fetchMock.mockResolvedValueOnce(json(issue(3)));

      await service.updateIssue(connection, 7, 3, { addLabels: ['foundry::failed'], removeLabels: ['a', 'b'] }, signal);

      const init = fetchMock.mock.calls[0][1]!;
      expect(requestedUrl(0).pathname).toBe('/api/v4/projects/7/issues/3');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe('{"add_labels":"foundry::failed","remove_labels":"a,b"}');
      expect(init.headers).toEqual(expect.objectContaining({ 'PRIVATE-TOKEN': TOKEN }));
      expect(init.redirect).toBe('error');
    });

    it('sends assignee ids as a JSON array', async () => {
      fetchMock.mockResolvedValueOnce(json(issue(3)));

      await service.updateIssue(connection, 7, 3, { assigneeIds: [12, 13] }, signal);

      expect(fetchMock.mock.calls[0][1]!.body).toBe('{"assignee_ids":[12,13]}');
    });

    it('leaves out a label list it was not given', async () => {
      fetchMock.mockResolvedValueOnce(json(issue(3)));

      await service.updateIssue(connection, 7, 3, { removeLabels: ['workflow::review'] }, signal);

      expect(fetchMock.mock.calls[0][1]!.body).toBe('{"remove_labels":"workflow::review"}');
    });

    it("looks a user's id up by username, regardless of case, and reads null for none", async () => {
      fetchMock.mockResolvedValueOnce(json([{ id: 12, username: 'Ada' }]));
      fetchMock.mockResolvedValueOnce(json([]));

      await expect(service.findUserId(connection, 'ada', signal)).resolves.toBe(12);
      await expect(service.findUserId(connection, 'nobody', signal)).resolves.toBeNull();

      expect(requestedUrl(0).pathname).toBe('/api/v4/users');
      expect(requestedUrl(0).searchParams.get('username')).toBe('ada');
    });

    it('posts a note as JSON', async () => {
      fetchMock.mockResolvedValueOnce(json({ id: 1 }));

      await service.createNote(connection, 7, 3, 'It failed', signal);

      const init = fetchMock.mock.calls[0][1]!;
      expect(requestedUrl(0).pathname).toBe('/api/v4/projects/7/issues/3/notes');
      expect(init.method).toBe('POST');
      expect(init.body).toBe('{"body":"It failed"}');
    });

    it('names the method of a failed write, and never the token or the body', async () => {
      fetchMock.mockResolvedValueOnce(status(403));

      const failure = service.createNote(connection, 7, 3, 'It failed', signal);

      await expect(failure).rejects.toThrow('GitLab answered 403 to POST /projects/7/issues/3/notes');
      await expect(failure).rejects.not.toThrow(TOKEN);
    });
  });

  describe('when rate-limited', () => {
    beforeEach(() => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('waits for Retry-After, then retries and resumes', async () => {
      fetchMock.mockResolvedValueOnce(status(429, { 'retry-after': '7' })).mockResolvedValueOnce(json([issue(1)]));

      const { issues } = await service.listIssues(connection, 7, {}, signal);

      expect(issues).toHaveLength(1);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(7000, signal);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up with a GitLabApiError after the last retry', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(status(429)));

      const failure = service.listIssues(connection, 7, {}, signal);

      await expect(failure).rejects.toThrow(GitLabApiError);
      await expect(failure).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMIT_MAX_RETRIES + 1);
      expect(sleep).toHaveBeenCalledTimes(RATE_LIMIT_MAX_RETRIES);
    });
  });

  it('rejects any other failure with the status and path, and never the token', async () => {
    fetchMock.mockResolvedValueOnce(status(401));

    const failure = service.getProject(connection, 'group/project', signal);

    await expect(failure).rejects.toMatchObject({
      status: 401,
      message: 'GitLab answered 401 to GET /projects/group%2Fproject',
    });
    await expect(failure).rejects.not.toThrow(TOKEN);
  });
});

describe('GitLabApiService.rateLimitDelayMs', () => {
  const service = new GitLabApiService();
  const now = Date.parse('2026-10-14T10:00:00.000Z');

  it('reads Retry-After in seconds', () => {
    expect(service.rateLimitDelayMs(new Headers({ 'retry-after': '30' }), 0, now)).toBe(30_000);
  });

  it('reads Retry-After as an HTTP date', () => {
    expect(service.rateLimitDelayMs(new Headers({ 'retry-after': 'Wed, 14 Oct 2026 10:00:45 GMT' }), 0, now)).toBe(
      45_000
    );
  });

  it('reads RateLimit-Reset as epoch seconds when Retry-After is missing', () => {
    expect(service.rateLimitDelayMs(new Headers({ 'ratelimit-reset': String(now / 1000 + 20) }), 0, now)).toBe(20_000);
  });

  it('doubles a fallback with each attempt when neither header is usable', () => {
    expect(service.rateLimitDelayMs(new Headers(), 0, now)).toBe(10_000);
    expect(service.rateLimitDelayMs(new Headers({ 'retry-after': 'soon' }), 2, now)).toBe(40_000);
  });

  it('waits at least a second and at most fifteen minutes', () => {
    expect(service.rateLimitDelayMs(new Headers({ 'retry-after': '0' }), 0, now)).toBe(1000);
    expect(service.rateLimitDelayMs(new Headers({ 'retry-after': '86400' }), 0, now)).toBe(15 * 60_000);
  });
});
