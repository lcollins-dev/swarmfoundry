import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { SecretRedactionService } from './secret-redaction.service';

import type { IConfigRepo } from './foundry-config.types';

export const GIT_TIMEOUT_MS = 60_000;

/** A first fetch copies the repo's whole history. */
export const FETCH_TIMEOUT_MS = 5 * 60_000;

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Holds the repo URL the clone was made from, so a clone of another repo is replaced rather than reused. */
const URL_KEY = 'swarmfoundry.url';

interface IGitOptions {
  /** Exit codes that resolve rather than reject. */
  exitCodes?: readonly number[];
  /** False for a command that runs before the clone exists. */
  inRepo?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}

interface IGitResult {
  exitCode: number;
  stdout: string;
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Runs git against a bare clone of the config repo. Every command runs with no shell, no hooks, no credential helper,
 * no system or global git config and no redirects, and the token reaches git only through its environment.
 */
@Injectable()
export class ConfigRepoGitService {
  constructor(private readonly secretRedactionService: SecretRedactionService) {}

  /** Makes the bare clone, replacing one made from another URL. */
  async init(repo: IConfigRepo, signal: AbortSignal): Promise<void> {
    if (existsSync(join(repo.gitDir, 'HEAD'))) {
      const url = await this.git(repo, ['config', '--get', URL_KEY], signal, { exitCodes: [0, 1] });

      if (url.stdout.trim() === repo.url) {
        return;
      }

      await rm(repo.gitDir, { recursive: true, force: true });
    }

    await mkdir(dirname(repo.gitDir), { recursive: true });
    await this.git(repo, ['init', '--quiet', '--bare', repo.gitDir], signal, { inRepo: false });
    await this.git(repo, ['config', URL_KEY, repo.url], signal);
  }

  /** Fetches the branch alone, into `trackingRef`, and returns its head. */
  async fetch(repo: IConfigRepo, signal: AbortSignal): Promise<string> {
    const refspec = `+refs/heads/${repo.branch}:${this.trackingRef(repo)}`;

    await this.git(repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', repo.url, refspec], signal, {
      timeoutMs: FETCH_TIMEOUT_MS,
    });

    const head = await this.resolve(repo, this.trackingRef(repo), signal);

    if (head === null) {
      throw new GitError(`Fetched ${repo.branch} but cannot read its head`);
    }

    return head;
  }

  /** The commit `ref` names, or null when it names none. */
  async resolve(repo: IConfigRepo, ref: string, signal: AbortSignal): Promise<string | null> {
    const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`];
    const result = await this.git(repo, args, signal, { exitCodes: [0, 1] });

    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async isAncestor(repo: IConfigRepo, ancestor: string, descendant: string, signal: AbortSignal): Promise<boolean> {
    const result = await this.git(repo, ['merge-base', '--is-ancestor', ancestor, descendant], signal, {
      exitCodes: [0, 1],
    });

    return result.exitCode === 0;
  }

  async listFiles(repo: IConfigRepo, sha: string, signal: AbortSignal): Promise<string[]> {
    const result = await this.git(repo, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha], signal);

    return result.stdout.split('\0').filter(path => path !== '');
  }

  /**
   * Writes the commit's `folder` into `target`, emptied first. A symlink is written as a plain file holding its target,
   * so no file reaches outside `target`. False when `folder` is not a folder in the commit.
   */
  async export(repo: IConfigRepo, sha: string, folder: string, target: string, signal: AbortSignal): Promise<boolean> {
    const tree = folder === '' ? `${sha}^{tree}` : `${sha}:${folder}`;
    const type = await this.git(repo, ['cat-file', '-t', tree], signal, { exitCodes: [0, 128] });

    if (type.exitCode !== 0 || type.stdout.trim() !== 'tree') {
      return false;
    }

    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });

    const env = { GIT_INDEX_FILE: `${target}.index` };

    await this.git(repo, ['read-tree', tree], signal, { env });
    await this.git(repo, [`--work-tree=${target}`, 'checkout-index', '--all', '--force'], signal, { env });
    await rm(env.GIT_INDEX_FILE, { force: true });

    return true;
  }

  async setRef(repo: IConfigRepo, ref: string, sha: string, signal: AbortSignal): Promise<void> {
    await this.git(repo, ['update-ref', ref, sha], signal);
  }

  trackingRef(repo: IConfigRepo): string {
    return `refs/remotes/origin/${repo.branch}`;
  }

  /** Rejects with a message free of the token. */
  private git(
    repo: IConfigRepo,
    args: readonly string[],
    signal: AbortSignal,
    options: IGitOptions = {}
  ): Promise<IGitResult> {
    const { exitCodes = [0], inRepo = true, timeoutMs = GIT_TIMEOUT_MS } = options;
    const fullArgs = inRepo ? [`--git-dir=${repo.gitDir}`, ...args] : [...args];
    const env = { ...this.environment(repo), ...options.env };

    return new Promise((resolve, reject) => {
      execFile(
        'git',
        fullArgs,
        { env, signal, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : null;

          if (exitCode !== null && exitCodes.includes(exitCode)) {
            resolve({ exitCode, stdout });

            return;
          }

          reject(new GitError(this.failure(repo, args[0] ?? 'git', exitCode, error, stderr)));
        }
      );
    });
  }

  private failure(
    repo: IConfigRepo,
    command: string,
    exitCode: number | null,
    error: Error | null,
    stderr: string
  ): string {
    const reason =
      exitCode === null
        ? error?.name === 'AbortError'
          ? 'aborted'
          : 'timed out or failed to run'
        : `exit code ${exitCode}`;
    const detail = stderr.trim().split('\n').slice(-5).join(' ').slice(0, 1000);
    const message =
      detail === '' ? `git ${command} failed (${reason})` : `git ${command} failed (${reason}): ${detail}`;

    return this.secretRedactionService.redactText(message, this.secretsOf(repo));
  }

  private secretsOf(repo: IConfigRepo): string[] {
    return repo.token === '' ? [] : [repo.token, this.authorization(repo.token)];
  }

  private authorization(token: string): string {
    return `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
  }

  /** Git's own settings only, so no orchestrator secret reaches git or a transport it starts. */
  private environment(repo: IConfigRepo): Record<string, string> {
    const settings: [string, string][] = [
      ['credential.helper', ''],
      ['core.hooksPath', '/dev/null'],
      ['core.symlinks', 'false'],
      ['http.followRedirects', 'false'],
      ['transfer.fsckObjects', 'true'],
      ['protocol.allow', 'never'],
      ['protocol.https.allow', 'always'],
      ['protocol.http.allow', 'always'],
    ];

    if (repo.token !== '') {
      settings.push(['http.extraHeader', `Authorization: ${this.authorization(repo.token)}`]);
    }

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: String(settings.length),
    };

    for (const [index, [key, value]] of settings.entries()) {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    }

    return env;
  }
}
