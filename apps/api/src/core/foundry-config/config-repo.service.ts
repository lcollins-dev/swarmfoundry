import { Injectable, Logger } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';

import { ConfigRepoGitService } from './config-repo-git.service';
import { ConfigRevisionService } from './config-revision.service';
import { FoundryConfigLoaderService } from './foundry-config-loader.service';
import { ConfigService } from '@/config/config.service';

import { FoundryConfigError } from './foundry-config.error';
import type { IConfigIssue, IConfigRepo, IConfigRevision, ILoadedFoundryConfig } from './foundry-config.types';
import { ConfigError, SECRETS } from '@/config/config.schema';

export const CONFIG_FILE = 'swarmfoundry.yaml';

const DOT_ENV = '.env';

/** SHA-1 or SHA-256, as git writes them. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Loads revisions of the config repo's branch, one at a time, and records each verdict. A revision loads only from the
 * clone's own checkout, with `${VAR}` from the environment alone. A new head becomes the branch's last good revision
 * once it loads.
 */
@Injectable()
export class ConfigRepoService {
  private readonly logger = new Logger(ConfigRepoService.name);

  /** The last head a load reached a verdict on, so a broken one is tried again only once the branch moves. */
  private lastTried: string | null = null;

  /** Every load writes the same checkout folder, so each waits for the one before it. Never rejects. */
  private loading: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly configService: ConfigService,
    private readonly configRepoGitService: ConfigRepoGitService,
    private readonly foundryConfigLoaderService: FoundryConfigLoaderService,
    private readonly configRevisionService: ConfigRevisionService
  ) {}

  /** Null when the config loads from a local file. */
  get repo(): IConfigRepo | null {
    const { configRepo, configBranch, configToken, configCloneDir } = this.configService;

    if (configRepo === undefined || configBranch === undefined) {
      return null;
    }

    return {
      url: configRepo,
      branch: configBranch,
      token: configToken,
      gitDir: join(resolve(configCloneDir), 'repo.git'),
    };
  }

  /**
   * Loads the branch head, or the last good revision when the head is broken or cannot be fetched. Throws a
   * `ConfigError` when neither loads.
   */
  async loadAtStartup(repo: IConfigRepo, signal: AbortSignal): Promise<IConfigRevision> {
    try {
      await this.configRepoGitService.init(repo, signal);
    } catch (error) {
      throw new ConfigError(`Cannot prepare the config repo's clone at ${repo.gitDir}: ${this.messageOf(error)}`);
    }

    let head: string | null = null;

    try {
      head = await this.configRepoGitService.fetch(repo, signal);
    } catch (error) {
      this.logger.warn(
        { url: repo.url, branch: repo.branch, error: this.messageOf(error) },
        'loadAtStartup(): Cannot fetch the config branch, so it falls back to the last good revision'
      );
    }

    if (head !== null) {
      const revision = await this.tryLoad(repo, head, signal);

      if (revision !== null) {
        return revision;
      }
    }

    const good = await this.lastGood(repo, signal);

    if (good === null) {
      throw new ConfigError(
        head === null
          ? `Cannot fetch ${repo.branch} of ${repo.url}, and the clone holds no good revision of it`
          : `Revision ${head} of ${repo.branch} does not load, and the clone holds no good revision of it`
      );
    }

    this.logger.warn({ sha: good, head }, `loadAtStartup(): Starting on the last good revision, ${good}`);

    return this.load(repo, good, signal);
  }

  /** Fetches the branch, and loads its head when it moved. Null when there is nothing new that loads. Never rejects. */
  async pollHead(repo: IConfigRepo, signal: AbortSignal): Promise<IConfigRevision | null> {
    let head: string;

    try {
      head = await this.configRepoGitService.fetch(repo, signal);
    } catch (error) {
      if (!signal.aborted) {
        this.logger.warn(
          { url: repo.url, branch: repo.branch, error: this.messageOf(error) },
          'pollHead(): Cannot fetch the config branch, so the running config stays'
        );
      }

      return null;
    }

    return head === this.lastTried ? null : this.tryLoad(repo, head, signal);
  }

  /**
   * Loads a revision a task is pinned to, such as after a restart, while the branch still reaches it. It never becomes
   * the last good revision, so a startup never falls back to it. Null when it does not load. Never rejects.
   */
  async loadPinned(repo: IConfigRepo, sha: string, signal: AbortSignal): Promise<IConfigRevision | null> {
    if (!SHA.test(sha)) {
      this.logger.error({ sha }, 'loadPinned(): A task is pinned to a malformed sha, so it is not loaded');

      return null;
    }

    try {
      if (!(await this.isOnBranch(repo, sha, signal))) {
        this.logger.error(
          { sha, branch: repo.branch },
          `loadPinned(): Revision ${sha} is no longer on ${repo.branch}, so it is not loaded`
        );

        return null;
      }

      const revision = await this.load(repo, sha, signal);

      this.logger.log({ sha }, `loadPinned(): Loaded pinned revision ${sha}`);

      return revision;
    } catch (error) {
      this.logFailure('loadPinned', sha, error, signal);

      return null;
    }
  }

  /** Logs why a revision does not load, one line per error. Null when it does not. */
  private async tryLoad(repo: IConfigRepo, sha: string, signal: AbortSignal): Promise<IConfigRevision | null> {
    try {
      const revision = await this.load(repo, sha, signal);
      this.lastTried = sha;

      await this.markGood(repo, sha, signal);

      return revision;
    } catch (error) {
      // Any other error is no verdict on the revision, so the next poll tries it again.
      if (error instanceof FoundryConfigError) {
        this.lastTried = sha;
      }

      this.logFailure('tryLoad', sha, error, signal);

      return null;
    }
  }

  private logFailure(caller: string, sha: string, error: unknown, signal: AbortSignal): void {
    if (error instanceof FoundryConfigError) {
      for (const issue of error.issues) {
        this.logger.error(
          { sha, path: issue.path, reason: issue.message },
          `${caller}(): Revision ${sha} is invalid at ${issue.path}: ${issue.message}`
        );
      }
    } else if (!signal.aborted) {
      this.logger.error({ sha, error: this.messageOf(error) }, `${caller}(): Failed to load revision ${sha}`);
    }
  }

  /**
   * Records the verdict. A revision that loads is recorded before it returns, since tasks pinned to it reference its
   * row, so a failed write fails the load. Throws a `FoundryConfigError` for a revision that does not load.
   */
  private load(repo: IConfigRepo, sha: string, signal: AbortSignal): Promise<IConfigRevision> {
    const load = async (): Promise<IConfigRevision> => {
      let loaded: ILoadedFoundryConfig;

      try {
        loaded = await this.read(repo, sha, signal);
      } catch (error) {
        if (error instanceof FoundryConfigError) {
          await this.recordFailure(sha, error.issues);
        }

        throw error;
      }

      return { id: await this.configRevisionService.recordLoad(sha, []), sha, loaded };
    };

    const loaded = this.loading.then(load);
    this.loading = loaded.catch(() => undefined);

    return loaded;
  }

  /** A failed write leaves the verdict to the log alone, since nothing references a failed revision. */
  private async recordFailure(sha: string, issues: readonly IConfigIssue[]): Promise<void> {
    try {
      await this.configRevisionService.recordLoad(sha, issues);
    } catch (error) {
      this.logger.warn({ sha, error: this.messageOf(error) }, `recordFailure(): Failed to record revision ${sha}`);
    }
  }

  private async read(repo: IConfigRepo, sha: string, signal: AbortSignal): Promise<ILoadedFoundryConfig> {
    const files = await this.configRepoGitService.listFiles(repo, sha, signal);
    const dotEnvs = files.filter(path => posix.basename(path) === DOT_ENV);

    if (dotEnvs.length > 0) {
      throw this.revisionError(
        sha,
        dotEnvs.map(path => ({
          path,
          message: "is a .env file, which a config repo must not hold; keep secrets in the deployment's environment",
        }))
      );
    }

    const folder = this.configService.configPath;
    const checkout = join(resolve(this.configService.configCloneDir), 'checkout');

    try {
      if (!(await this.configRepoGitService.export(repo, sha, folder, checkout, signal))) {
        throw this.revisionError(sha, [
          { path: '(root)', message: `SWARMFOUNDRY_CONFIG_PATH ${folder} is not a folder in the revision` },
        ]);
      }

      return this.foundryConfigLoaderService.load(join(checkout, CONFIG_FILE), this.variables(), {
        readDotEnv: false,
        root: checkout,
      });
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  }

  /** The last revision that loaded, while the branch still reaches it. */
  private async lastGood(repo: IConfigRepo, signal: AbortSignal): Promise<string | null> {
    try {
      const good = await this.configRepoGitService.resolve(repo, this.goodRef(repo), signal);

      if (good === null) {
        return null;
      }

      if (!(await this.isOnBranch(repo, good, signal))) {
        this.logger.warn(
          { sha: good, branch: repo.branch },
          'lastGood(): The last good revision is no longer on the branch, so it is not used'
        );

        return null;
      }

      return good;
    } catch (error) {
      this.logger.error({ error: this.messageOf(error) }, 'lastGood(): Failed to read the last good revision');

      return null;
    }
  }

  private async isOnBranch(repo: IConfigRepo, sha: string, signal: AbortSignal): Promise<boolean> {
    const tracking = await this.configRepoGitService.resolve(repo, this.configRepoGitService.trackingRef(repo), signal);

    if (tracking === null || (await this.configRepoGitService.resolve(repo, sha, signal)) !== sha) {
      return false;
    }

    return this.configRepoGitService.isAncestor(repo, sha, tracking, signal);
  }

  private async markGood(repo: IConfigRepo, sha: string, signal: AbortSignal): Promise<void> {
    try {
      await this.configRepoGitService.setRef(repo, this.goodRef(repo), sha, signal);
    } catch (error) {
      this.logger.warn(
        { sha, error: this.messageOf(error) },
        'markGood(): Failed to record the revision as good, so a restart may fall back to an older one'
      );
    }
  }

  /** Per branch, so a deployment moved to another branch never falls back to one of the old branch's revisions. */
  private goodRef(repo: IConfigRepo): string {
    return `refs/swarmfoundry/good/${repo.branch}`;
  }

  /** The environment without the orchestrator's own secrets, so a merged change cannot hand them to an agent. */
  private variables(): Record<string, string | undefined> {
    const secrets = new Set<string>(SECRETS);

    return Object.fromEntries(Object.entries(process.env).filter(([name]) => !secrets.has(name)));
  }

  private revisionError(sha: string, issues: readonly IConfigIssue[]): FoundryConfigError {
    return new FoundryConfigError(`Revision ${sha}`, issues);
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
