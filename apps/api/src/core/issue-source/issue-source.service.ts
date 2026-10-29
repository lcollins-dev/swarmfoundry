import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';

import { GitLabSourceService } from './gitlab-source.service';
import { SourceWatermarkService } from './source-watermark.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';

import type { IIssueSource, IIssueState, IRequestLimits, SourceEventHandler } from './issue-source.types';
import type { ISourceConfig } from '@/core/foundry-config/foundry-config.types';

interface ISourceLoop {
  source: ISourceConfig;
  controller: AbortController;
  timer: NodeJS.Timeout | null;
  poll: Promise<void> | null;
}

@Injectable()
export class IssueSourceService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(IssueSourceService.name);

  private readonly sourcesByType: Record<ISourceConfig['type'], IIssueSource>;

  /** By source name. */
  private readonly loops = new Map<string, ISourceLoop>();

  private controller: AbortController | null = null;
  private stopFollowingSwaps: (() => void) | null = null;

  /** Swaps are followed one at a time, so a source never has two loops. The startup sweep runs first. */
  private following: Promise<void> = Promise.resolve();

  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    gitlabSourceService: GitLabSourceService,
    private readonly sourceWatermarkService: SourceWatermarkService
  ) {
    this.sourcesByType = { gitlab: gitlabSourceService };
  }

  /**
   * Starts polling every configured source, handing each event to `handler`. Nothing polls before this call, so call
   * it once the handler can take events. Returns `stop`.
   */
  start(handler: SourceEventHandler): () => Promise<void> {
    if (this.controller !== null) {
      throw new Error('IssueSourceService is already started');
    }

    this.controller = new AbortController();

    const sources = this.foundryConfigService.sources;

    if (sources.length === 0) {
      this.logger.log('start(): No sources configured, so nothing is polled');
    }

    for (const source of sources) {
      this.startLoop(source, handler);
    }

    this.following = this.retainWatermarks();

    this.stopFollowingSwaps = this.foundryConfigService.onSwap(() => {
      this.following = this.following
        .then(() => this.followSwap(handler))
        .catch((error: unknown) => {
          this.logger.error({ error }, 'start(): Failed to follow the config swap');
        });
    });

    return () => this.stop();
  }

  /** Aborts every request and wait in flight, then resolves once each running poll and handler has finished. */
  async stop(): Promise<void> {
    this.controller?.abort();
    this.stopFollowingSwaps?.();
    this.stopFollowingSwaps = null;

    await this.following;
    await Promise.all([...this.loops.values()].map(loop => this.stopLoop(loop)));
  }

  /** Reads the issue with the source's own token. Null when it no longer exists. */
  readIssue(
    source: ISourceConfig,
    projectId: number,
    issueIid: number,
    signal: AbortSignal,
    limits?: IRequestLimits
  ): Promise<IIssueState | null> {
    return this.sourcesByType[source.type].readIssue(source, projectId, issueIid, signal, limits);
  }

  relabel(
    source: ISourceConfig,
    projectId: number,
    issueIid: number,
    add: readonly string[],
    remove: readonly string[],
    signal: AbortSignal
  ): Promise<void> {
    return this.sourcesByType[source.type].relabel(source, projectId, issueIid, add, remove, signal);
  }

  /** Replaces the issue's assignees. */
  assign(
    source: ISourceConfig,
    projectId: number,
    issueIid: number,
    usernames: readonly string[],
    signal: AbortSignal
  ): Promise<void> {
    return this.sourcesByType[source.type].assign(source, projectId, issueIid, usernames, signal);
  }

  /** Posts `body` as written, with the source's own token, so redact it first. */
  comment(
    source: ISourceConfig,
    projectId: number,
    issueIid: number,
    body: string,
    signal: AbortSignal
  ): Promise<void> {
    return this.sourcesByType[source.type].comment(source, projectId, issueIid, body, signal);
  }

  async beforeApplicationShutdown() {
    await this.stop();
  }

  /** Stops the loop of every source the swap removed or changed, then starts one for each source without a loop. */
  private async followSwap(handler: SourceEventHandler): Promise<void> {
    const sources = new Map(this.foundryConfigService.sources.map(source => [source.name, source]));

    for (const [name, loop] of this.loops) {
      const source = sources.get(name);

      if (source !== undefined && isDeepStrictEqual(source, loop.source)) {
        continue;
      }

      await this.stopLoop(loop);
      this.loops.delete(name);

      // Its project ids may belong to another GitLab, so the new loop reads them and its watermarks again.
      this.sourcesByType[loop.source.type].forget(name);

      this.logger.log(
        { source: name },
        source === undefined
          ? 'followSwap(): The source left the config, so it is no longer polled'
          : 'followSwap(): The source changed, so its polling restarts'
      );
    }

    for (const source of sources.values()) {
      if (!this.loops.has(source.name) && this.controller?.signal.aborted === false) {
        this.startLoop(source, handler);
      }
    }

    await this.retainWatermarks();
  }

  /**
   * Removes the issue and merge request watermarks of sources no longer configured, so a source added back later starts
   * afresh rather than firing every change in between. Keeps them all while no source is configured, as when the config is
   * missing. Never rejects.
   */
  private async retainWatermarks(): Promise<void> {
    const names = this.foundryConfigService.sources.map(source => source.name);

    if (names.length === 0) {
      return;
    }

    try {
      await this.sourceWatermarkService.retainSources(names);
    } catch (error) {
      this.logger.error({ error }, 'retainWatermarks(): Failed to remove the watermarks of removed sources');
    }
  }

  private startLoop(source: ISourceConfig, handler: SourceEventHandler): void {
    if (new URL(source.url).protocol === 'http:') {
      this.logger.warn(
        { source: source.name, url: this.foundryConfigService.redact(source.url) },
        'startLoop(): The source uses plain http, so its token crosses the network unencrypted'
      );
    }

    this.logger.log(
      { source: source.name, projects: source.projects, pollIntervalMs: source.pollInterval },
      'startLoop(): Polling the source'
    );

    const loop: ISourceLoop = { source, controller: new AbortController(), timer: null, poll: null };
    this.loops.set(source.name, loop);
    this.schedule(loop, handler, 0);
  }

  /** Resolves once the loop's running poll and handler have finished. */
  private async stopLoop(loop: ISourceLoop): Promise<void> {
    loop.controller.abort();

    if (loop.timer !== null) {
      clearTimeout(loop.timer);
      loop.timer = null;
    }

    await loop.poll;
  }

  private schedule(loop: ISourceLoop, handler: SourceEventHandler, delayMs: number): void {
    loop.timer = setTimeout(() => {
      loop.timer = null;
      loop.poll = this.pollThenReschedule(loop, handler).finally(() => {
        loop.poll = null;
      });
    }, delayMs);
  }

  private async pollThenReschedule(loop: ISourceLoop, handler: SourceEventHandler): Promise<void> {
    const { source, controller } = loop;

    try {
      await this.sourcesByType[source.type].poll(source, handler, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        this.logger.error(
          { source: source.name, error: this.foundryConfigService.redact(String(error)) },
          'pollThenReschedule(): The poll failed unexpectedly'
        );
      }
    }

    if (!controller.signal.aborted) {
      this.schedule(loop, handler, source.pollInterval);
    }
  }
}
