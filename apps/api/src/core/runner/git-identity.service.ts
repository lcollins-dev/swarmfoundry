import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { RunConfigError } from './run-config.error';
import { gitlabUserSchema } from './schema/gitlab-user';

export const GIT_IDENTITY_VARIABLES = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

type GitIdentityVariable = (typeof GIT_IDENTITY_VARIABLES)[number];

/** Long enough that a burst of runs looks the user up once, short enough that a profile change reaches the next run. */
export const IDENTITY_CACHE_TTL_MS = 10 * 60_000;

const REQUEST_TIMEOUT_MS = 30_000;
const USER_PATH = '/api/v4/user';

const SCOPE_HINT =
  "Give the environment's GITLAB_TOKEN the read_user or api scope, or set GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, " +
  'GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL in its env.';

interface IGitIdentity {
  name: string;
  email: string;
}

interface ICachedIdentity {
  identity: IGitIdentity;
  expiresAt: number;
}

@Injectable()
export class GitIdentityService {
  /** Keyed by a hash of host and token, so the cache never holds a token. Only successful lookups are kept. */
  private readonly cache = new Map<string, ICachedIdentity>();

  /** Fills the git identity variables `env` leaves empty from the GitLab user behind its GITLAB_TOKEN on `host`. */
  async missingVariables(
    environmentName: string,
    env: Readonly<Record<string, string>>,
    host: string,
    signal: AbortSignal
  ): Promise<Partial<Record<GitIdentityVariable, string>>> {
    const missing = GIT_IDENTITY_VARIABLES.filter(name => (Object.hasOwn(env, name) ? env[name] : '') === '');

    if (missing.length === 0) {
      return {};
    }

    const token = Object.hasOwn(env, 'GITLAB_TOKEN') ? env.GITLAB_TOKEN : '';

    if (token === '') {
      throw new RunConfigError(
        `Environment ${environmentName} must set GITLAB_TOKEN, so agents commit as its user, or set all of ` +
          GIT_IDENTITY_VARIABLES.join(', ')
      );
    }

    const { name, email } = await this.identity(host, token, signal);
    const values: Record<GitIdentityVariable, string> = {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };

    return Object.fromEntries(missing.map(variable => [variable, values[variable]]));
  }

  private async identity(host: string, token: string, signal: AbortSignal): Promise<IGitIdentity> {
    const key = createHash('sha256').update(`${host}\0${token}`).digest('hex');
    const cached = this.cache.get(key);

    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.identity;
    }

    const identity = await this.lookUp(host, token, signal);

    this.cache.set(key, { identity, expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS });

    return identity;
  }

  /** Every error names the host and path only, so it never carries the token or a response body. */
  private async lookUp(host: string, token: string, signal: AbortSignal): Promise<IGitIdentity> {
    let response: Response;

    try {
      // `redirect: 'error'`, since fetch forwards a custom header such as PRIVATE-TOKEN across origins.
      response = await fetch(`https://${host}${USER_PATH}`, {
        headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }

      throw new Error(`GitLab at ${host} did not answer GET ${USER_PATH} for the git identity`);
    }

    if (!response.ok) {
      await response.body?.cancel();

      const message = `GitLab at ${host} answered ${response.status} to GET ${USER_PATH} for the git identity. ${SCOPE_HINT}`;

      throw this.isRefusal(response.status) ? new RunConfigError(message) : new Error(message);
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      throw new Error(`GitLab at ${host} sent an unexpected response to GET ${USER_PATH} for the git identity`);
    }

    const user = gitlabUserSchema.safeParse(body);

    if (!user.success) {
      throw new RunConfigError(
        `GitLab at ${host} sent no name and commit email from GET ${USER_PATH} for the git identity`
      );
    }

    return { name: user.data.name, email: user.data.commit_email };
  }

  private isRefusal(status: number): boolean {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}
