import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { GitIdentityService, IDENTITY_CACHE_TTL_MS } from './git-identity.service';

import { RunConfigError } from './run-config.error';

const TOKEN = 'glpat-agent-secret';
const HOST = 'gitlab.example.com';

const user = { id: 7, username: 'project_1_bot', name: 'Swarm Bot', commit_email: 'bot@example.com' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ALL_FOUR = {
  GIT_AUTHOR_NAME: 'Bot Bot',
  GIT_AUTHOR_EMAIL: 'bot@example.org',
  GIT_COMMITTER_NAME: 'Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.org',
};

describe('GitIdentityService', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let logSpies: MockInstance[];
  let service: GitIdentityService;
  const signal = new AbortController().signal;
  const env = { GITLAB_HOST: HOST, GITLAB_TOKEN: TOKEN };

  const lookUp = (overrides: Record<string, string> = {}) =>
    service.missingVariables('node', { ...env, ...overrides }, HOST, signal);

  const failure = async () => {
    const error: unknown = await lookUp().then(
      () => null,
      (rejection: unknown) => rejection
    );

    expect(error).toBeInstanceOf(Error);

    return error instanceof Error ? error.message : '';
  };

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    logSpies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(level =>
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined)
    );
    service = new GitIdentityService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sets author and committer from the user's name and commit email, sending the token only in a header", async () => {
    fetchMock.mockResolvedValueOnce(json(user));

    await expect(lookUp()).resolves.toEqual({
      GIT_AUTHOR_NAME: 'Swarm Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'Swarm Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gitlab.example.com/api/v4/user');
    expect(init?.headers).toEqual(expect.objectContaining({ 'PRIVATE-TOKEN': TOKEN }));
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('skips the lookup when the env sets all four variables', async () => {
    await expect(lookUp(ALL_FOUR)).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fills only the variables the env leaves unset or empty', async () => {
    fetchMock.mockResolvedValueOnce(json(user));

    await expect(lookUp({ GIT_AUTHOR_EMAIL: 'me@example.org', GIT_COMMITTER_NAME: '' })).resolves.toEqual({
      GIT_AUTHOR_NAME: 'Swarm Bot',
      GIT_COMMITTER_NAME: 'Swarm Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    });
  });

  it('refuses an env with no GITLAB_TOKEN when a variable is missing', async () => {
    const lookup = service.missingVariables('node', { GITLAB_HOST: HOST }, HOST, signal);

    await expect(lookup).rejects.toThrow('Environment node must set GITLAB_TOKEN');
    await expect(lookup).rejects.toBeInstanceOf(RunConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('cache', () => {
    it('looks each host and token up once until the TTL runs out', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      fetchMock.mockImplementation(() => Promise.resolve(json(user)));

      await lookUp();
      await lookUp();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await service.missingVariables('node', { ...env, GITLAB_TOKEN: 'glpat-other' }, HOST, signal);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(IDENTITY_CACHE_TTL_MS + 1);
      await lookUp();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('keeps no failed lookup', async () => {
      fetchMock.mockResolvedValueOnce(json({ message: '401 Unauthorized' }, 401)).mockResolvedValueOnce(json(user));

      await expect(lookUp()).rejects.toThrow();
      await expect(lookUp()).resolves.toMatchObject({ GIT_AUTHOR_NAME: 'Swarm Bot' });
    });
  });

  describe('failures', () => {
    it('names the host, status and scope on an error status', async () => {
      fetchMock.mockResolvedValueOnce(json({ message: `401 Unauthorized ${TOKEN}` }, 401));

      const message = await failure();

      expect(message).toContain('GitLab at gitlab.example.com answered 401 to GET /api/v4/user');
      expect(message).toContain('read_user or api scope');
      expect(message).not.toContain(TOKEN);
    });

    it.each([400, 401, 403, 404])('fails a %i for good, since no retry fixes it', async status => {
      fetchMock.mockResolvedValueOnce(json({ message: 'refused' }, status));

      await expect(lookUp()).rejects.toBeInstanceOf(RunConfigError);
    });

    it.each([408, 429, 500, 503])('leaves a %i to retry', async status => {
      fetchMock.mockResolvedValueOnce(json({ message: 'busy' }, status));

      const error: unknown = await lookUp().catch((rejection: unknown) => rejection);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RunConfigError);
    });

    it('fails on a response that is not JSON', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>sign in</html>', { status: 200 }));

      expect(await failure()).toContain('unexpected response to GET /api/v4/user');
    });

    it.each([
      ['no commit email', { name: 'Swarm Bot' }],
      ['an empty name', { name: ' ', commit_email: 'bot@example.com' }],
      ['an array', [user]],
    ])('fails on a user with %s for good', async (_case, body) => {
      fetchMock.mockResolvedValueOnce(json(body));

      expect(await failure()).toContain('no name and commit email');

      fetchMock.mockResolvedValueOnce(json(body));

      await expect(lookUp()).rejects.toBeInstanceOf(RunConfigError);
    });

    it('fails on a refused redirect or network error without its cause', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${TOKEN}`));

      const message = await failure();

      expect(message).toContain('GitLab at gitlab.example.com did not answer GET /api/v4/user');
      expect(message).not.toContain(TOKEN);
    });

    it('rethrows an abort from the caller', async () => {
      const controller = new AbortController();
      const abort = new DOMException('aborted', 'AbortError');

      controller.abort(abort);
      fetchMock.mockRejectedValueOnce(abort);

      await expect(service.missingVariables('node', env, HOST, controller.signal)).rejects.toBe(abort);
    });

    it('never logs the token', async () => {
      fetchMock.mockResolvedValueOnce(json(user)).mockResolvedValueOnce(json({}, 401));

      await lookUp();
      await service.missingVariables('node', { ...env, GITLAB_TOKEN: 'glpat-other' }, HOST, signal).catch(() => null);

      for (const spy of logSpies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain('glpat-');
      }
    });
  });
});
