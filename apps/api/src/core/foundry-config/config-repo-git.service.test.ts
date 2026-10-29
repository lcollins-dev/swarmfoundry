import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigRepoGitService, GitError } from './config-repo-git.service';
import { SecretRedactionService } from './secret-redaction.service';

import type { IConfigRepo } from './foundry-config.types';

const TOKEN = 'glpat-config-repo-secret';
const BRANCH = 'main';

interface IRequest {
  url: string;
  headers: IncomingHttpHeaders;
}

/** A dumb-HTTP git remote: the bare repo's files served as they are, which `git fetch` reads without a git server. */
class DumbHttpRemote {
  readonly requests: IRequest[] = [];
  redirectTo: string | null = null;

  private readonly server: Server;

  constructor(private readonly root: string) {
    this.server = createServer((request, response) => {
      const url = request.url ?? '/';
      this.requests.push({ url, headers: request.headers });

      if (this.redirectTo !== null) {
        response.writeHead(302, { location: `${this.redirectTo}${url}` }).end();

        return;
      }

      const path = resolve(this.root, `.${decodeURIComponent(new URL(url, 'http://localhost').pathname)}`);

      try {
        if (!path.startsWith(this.root) || !statSync(path).isFile()) {
          throw new Error('not a file');
        }

        response.writeHead(200).end(readFileSync(path));
      } catch {
        response.writeHead(404).end();
      }
    });
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;

    return `http://127.0.0.1:${port}/origin.git`;
  }

  listen(): Promise<void> {
    return new Promise(resolveListen => this.server.listen(0, '127.0.0.1', resolveListen));
  }

  close(): Promise<void> {
    return new Promise(resolveClose => this.server.close(() => resolveClose()));
  }
}

/** Plain git for the test's own repos, with no user config. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@test', '-c', 'init.defaultBranch=main', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }
  ).trim();

describe('ConfigRepoGitService', () => {
  const signal = new AbortController().signal;
  const service = new ConfigRepoGitService(new SecretRedactionService());

  let dir: string;
  let work: string;
  let origin: string;
  let remote: DumbHttpRemote;
  let repo: IConfigRepo;

  /** Commits `files` on `branch` of the work repo and publishes it to the remote. */
  const commit = (files: Record<string, string>, branch = BRANCH): string => {
    git(work, 'checkout', '--quiet', '-B', branch);

    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }

    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '--allow-empty', '-m', 'Change');
    git(work, 'push', '--quiet', '--force', origin, `${branch}:${branch}`);
    git(origin, 'update-server-info');

    return git(work, 'rev-parse', 'HEAD');
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'config-repo-git-'));
    work = join(dir, 'work');
    origin = join(dir, 'remote', 'origin.git');

    mkdirSync(work);
    git(dir, 'init', '--quiet', '--bare', origin);
    git(work, 'init', '--quiet');

    remote = new DumbHttpRemote(join(dir, 'remote'));
    await remote.listen();

    repo = { url: remote.url, branch: BRANCH, token: TOKEN, gitDir: join(dir, 'clone', 'repo.git') };
    await service.init(repo, signal);
  });

  afterEach(async () => {
    await remote.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fetches the branch's head", async () => {
    const sha = commit({ 'swarmfoundry.yaml': 'sources: {}' });

    await expect(service.fetch(repo, signal)).resolves.toBe(sha);
    await expect(service.resolve(repo, service.trackingRef(repo), signal)).resolves.toBe(sha);
  });

  it('fetches no other branch', async () => {
    commit({ 'swarmfoundry.yaml': 'main' });
    const other = commit({ 'swarmfoundry.yaml': 'other' }, 'unreviewed');

    await service.fetch(repo, signal);

    await expect(service.resolve(repo, other, signal)).resolves.toBeNull();
    await expect(service.resolve(repo, 'refs/remotes/origin/unreviewed', signal)).resolves.toBeNull();
  });

  it('sends the token in a header only', async () => {
    commit({ 'swarmfoundry.yaml': 'sources: {}' });

    await service.fetch(repo, signal);

    const expected = `Basic ${Buffer.from(`oauth2:${TOKEN}`).toString('base64')}`;

    expect(remote.requests.length).toBeGreaterThan(0);
    expect(remote.requests.every(request => request.headers.authorization === expected)).toBe(true);
    expect(remote.requests.some(request => request.url.includes(TOKEN))).toBe(false);
  });

  it('sends no header without a token', async () => {
    commit({ 'swarmfoundry.yaml': 'sources: {}' });

    await service.fetch({ ...repo, token: '' }, signal);

    expect(remote.requests.every(request => request.headers.authorization === undefined)).toBe(true);
  });

  it('refuses a redirect, so the token never reaches another host', async () => {
    commit({ 'swarmfoundry.yaml': 'sources: {}' });
    const other = new DumbHttpRemote(join(dir, 'remote'));
    await other.listen();
    remote.redirectTo = new URL(other.url).origin;

    try {
      const fetching = service.fetch(repo, signal);

      await expect(fetching).rejects.toThrow(GitError);
      await expect(fetching).rejects.not.toThrow(TOKEN);
      expect(other.requests).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('names the failure without the token when the remote cannot be reached', async () => {
    const unreachable = { ...repo, url: 'http://127.0.0.1:1/origin.git' };

    const fetching = service.fetch(unreachable, signal);

    await expect(fetching).rejects.toThrow(/git fetch failed \(exit code \d+\)/);
    await expect(fetching).rejects.not.toThrow(TOKEN);
  });

  it('lists every file in a commit, nested ones included', async () => {
    const sha = commit({ 'config/swarmfoundry.yaml': 'a', 'config/prompts/implement.md': 'b', 'README.md': 'c' });
    await service.fetch(repo, signal);

    await expect(service.listFiles(repo, sha, signal)).resolves.toEqual(
      expect.arrayContaining(['config/swarmfoundry.yaml', 'config/prompts/implement.md', 'README.md'])
    );
  });

  describe('export', () => {
    it("writes the commit's folder alone into the target", async () => {
      const sha = commit({ 'config/swarmfoundry.yaml': 'config', 'other/secret.txt': 'other' });
      await service.fetch(repo, signal);
      const target = join(dir, 'checkout');

      await expect(service.export(repo, sha, 'config', target, signal)).resolves.toBe(true);

      expect(readFileSync(join(target, 'swarmfoundry.yaml'), 'utf8')).toBe('config');
      expect(() => statSync(join(target, 'other'))).toThrow();
      expect(() => statSync(`${target}.index`)).toThrow();
    });

    it('writes the whole commit for the root folder, replacing what the target held', async () => {
      const sha = commit({ 'swarmfoundry.yaml': 'root' });
      await service.fetch(repo, signal);
      const target = join(dir, 'checkout');
      mkdirSync(target);
      writeFileSync(join(target, 'stale.md'), 'stale');

      await service.export(repo, sha, '', target, signal);

      expect(readFileSync(join(target, 'swarmfoundry.yaml'), 'utf8')).toBe('root');
      expect(() => statSync(join(target, 'stale.md'))).toThrow();
    });

    it('writes a symlink as a plain file holding its target', async () => {
      symlinkSync('/etc/hostname', join(work, 'leak.md'));
      const sha = commit({ 'swarmfoundry.yaml': 'root' });
      await service.fetch(repo, signal);
      const target = join(dir, 'checkout');

      await service.export(repo, sha, '', target, signal);

      expect(lstatSync(join(target, 'leak.md')).isFile()).toBe(true);
      expect(readFileSync(join(target, 'leak.md'), 'utf8')).toBe('/etc/hostname');
    });

    it('returns false for a folder the commit lacks', async () => {
      const sha = commit({ 'swarmfoundry.yaml': 'root' });
      await service.fetch(repo, signal);

      await expect(service.export(repo, sha, 'missing', join(dir, 'checkout'), signal)).resolves.toBe(false);
      await expect(service.export(repo, sha, 'swarmfoundry.yaml', join(dir, 'checkout'), signal)).resolves.toBe(false);
    });
  });

  it('records a ref and tells an ancestor from a commit off the branch', async () => {
    const first = commit({ 'swarmfoundry.yaml': 'first' });
    const second = commit({ 'swarmfoundry.yaml': 'second' });
    await service.fetch(repo, signal);

    await service.setRef(repo, 'refs/swarmfoundry/good/main', first, signal);

    await expect(service.resolve(repo, 'refs/swarmfoundry/good/main', signal)).resolves.toBe(first);
    await expect(service.isAncestor(repo, first, second, signal)).resolves.toBe(true);
    await expect(service.isAncestor(repo, second, first, signal)).resolves.toBe(false);
  });

  it('keeps a clone of the same URL and replaces one of another', async () => {
    const sha = commit({ 'swarmfoundry.yaml': 'root' });
    await service.fetch(repo, signal);

    await service.init(repo, signal);

    await expect(service.resolve(repo, sha, signal)).resolves.toBe(sha);

    await service.init({ ...repo, url: 'http://127.0.0.1:1/another.git' }, signal);

    await expect(service.resolve(repo, sha, signal)).resolves.toBeNull();
  });
});
