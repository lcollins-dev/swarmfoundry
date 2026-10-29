import { Injectable, Logger } from '@nestjs/common';

import { GitLabApiService } from './gitlab-api.service';
import { SourceWatermarkService } from './source-watermark.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';

import { errorText, GitLabApiError } from './gitlab-api.error';
import { WATERMARK_OVERLAP_MS } from './gitlab-polling.constants';
import type { IIssueProject, IRelatedIssue, SourceEventHandler } from './issue-source.types';
import type { IGitLabMergeRequest, IGitLabRelatedIssue } from './schema/gitlab';
import type { ISourceConfig, MergeRequestEventKind } from '@/core/foundry-config/foundry-config.types';

export const MERGE_REQUEST_OVERLAP_MS = WATERMARK_OVERLAP_MS;

/** An event failing this often logs at `error` level, but is still retried, since a merge happens only once. */
export const MAX_MERGE_REQUEST_ATTEMPTS = 3;

const TITLE_ISSUE_PATTERN = /\(#(\d+)\)\s*$/;

interface IPendingEvent {
  mergeRequest: IGitLabMergeRequest;
  event: MergeRequestEventKind;
  occurredAt: Date;
}

interface IFailedEvent extends IPendingEvent {
  attempts: number;
}

interface IEmitted {
  /** The event, labels and target branch, which a trigger matches on. */
  snapshot: string;
  occurredAt: number;
}

interface IProjectState {
  /** Null until read from Postgres. */
  watermark: Date | null;
  /** The watermark Postgres holds, so an unchanged one is not written again. */
  saved: Date | null;
  /** By `keyOf`, so the overlap does not emit an unchanged event twice. */
  emitted: Map<string, IEmitted>;
  /** By `keyOf`. Emitted again on the next poll, even once the window has moved past the event. */
  retries: Map<string, IFailedEvent>;
}

/**
 * Emits a merge request event only when it happened inside the poll's window, so a comment on an old merge request
 * fires nothing. The watermark lives in Postgres, so a merge during a restart still fires once the source polls again.
 */
@Injectable()
export class GitLabMergeRequestSourceService {
  private readonly logger = new Logger(GitLabMergeRequestSourceService.name);

  /** By source name, then by project id. */
  private readonly states = new Map<string, Map<number, IProjectState>>();

  /** By source name: the URL and project ids last retained, so an unchanged set is not removed again. */
  private readonly retained = new Map<string, string>();

  constructor(
    private readonly gitlabApiService: GitLabApiService,
    private readonly sourceWatermarkService: SourceWatermarkService,
    private readonly foundryConfigService: FoundryConfigService
  ) {}

  /**
   * Emits only the `events` a trigger watches. Rejects when the listing or a watermark read or write fails. A failed
   * related issue read or handler retries the event on the next poll instead.
   */
  async poll(
    source: ISourceConfig,
    project: IIssueProject,
    events: ReadonlySet<MergeRequestEventKind>,
    emit: SourceEventHandler,
    signal: AbortSignal
  ) {
    const state = this.stateOf(source.name, project.id);

    if (state.watermark === null) {
      state.watermark = await this.sourceWatermarkService.find('mergeRequest', source, project.id);
      state.saved = state.watermark;
    }

    if (state.watermark === null) {
      await this.startWatching(source, project, state, signal);

      return;
    }

    const cutoff = new Date(state.watermark.getTime() - MERGE_REQUEST_OVERLAP_MS);
    const { mergeRequests, listedAt } = await this.gitlabApiService.listMergeRequests(
      source,
      project.id,
      { updatedAfter: cutoff },
      signal
    );

    let emitted = 0;

    for (const pending of this.dueEvents(mergeRequests, state, cutoff, events)) {
      const { mergeRequest } = pending;
      const key = this.keyOf(pending);
      const snapshot = this.snapshotOf(pending);
      const failed = state.retries.get(key);

      if (failed === undefined && state.emitted.get(key)?.snapshot === snapshot) {
        continue;
      }

      const attempts = failed?.attempts ?? 0;

      try {
        const relatedIssue = await this.relatedIssueOrNoneOnLastAttempt(source, project, pending, attempts, signal);

        await emit({
          source: source.name,
          project,
          event: pending.event,
          mergeRequest: {
            iid: mergeRequest.iid,
            title: mergeRequest.title,
            url: mergeRequest.web_url,
            sourceBranch: mergeRequest.source_branch,
            targetBranch: mergeRequest.target_branch,
            labels: mergeRequest.labels,
          },
          relatedIssue,
        });
        emitted++;

        state.retries.delete(key);
        state.emitted.set(key, { snapshot, occurredAt: pending.occurredAt.getTime() });
      } catch (error) {
        signal.throwIfAborted();

        this.recordFailure(source, project, state, { ...pending, attempts }, error);
      }
    }

    state.watermark = this.nextWatermark(state.watermark, mergeRequests, listedAt);

    this.forgetBefore(state, cutoff);
    await this.saveWatermark(source, project, state);

    this.logger.debug(
      { source: source.name, project: project.path, listed: mergeRequests.length, emitted },
      'poll(): Polled the merge requests'
    );
  }

  /**
   * Removes the source's watermarks for every project it does not watch, so watching one again starts from then rather
   * than firing every event in between. With `complete`, `watched` holds every watched project, so it also removes every
   * other project's and every other URL's. Otherwise it removes only the `unwatched` it knows. Skips an unchanged call.
   */
  async retainProjects(
    source: ISourceConfig,
    watched: readonly number[],
    unwatched: readonly number[],
    complete: boolean
  ): Promise<void> {
    const sorted = (ids: readonly number[]) => ids.toSorted((left, right) => left - right);
    const call = JSON.stringify([source.url, sorted(watched), sorted(unwatched), complete]);

    if (this.retained.get(source.name) === call) {
      return;
    }

    if (complete) {
      await this.sourceWatermarkService.retainProjects('mergeRequest', source, watched);
    } else if (unwatched.length > 0) {
      await this.sourceWatermarkService.removeProjects('mergeRequest', source, unwatched);
    }

    this.retained.set(source.name, call);

    const projects = this.states.get(source.name);

    for (const projectId of projects?.keys() ?? []) {
      if (!watched.includes(projectId)) {
        projects?.delete(projectId);
      }
    }
  }

  forget(sourceName: string): void {
    this.states.delete(sourceName);
    this.retained.delete(sourceName);
  }

  /**
   * Starts an overlap past GitLab's clock now, so the first window opens at the first poll and no merge request event
   * from before it fires.
   */
  private async startWatching(
    source: ISourceConfig,
    project: IIssueProject,
    state: IProjectState,
    signal: AbortSignal
  ): Promise<void> {
    const now = new Date();
    const { mergeRequests, listedAt } = await this.gitlabApiService.listMergeRequests(
      source,
      project.id,
      { updatedAfter: now },
      signal
    );

    const newest = mergeRequests.reduce(
      (latest, mergeRequest) => (mergeRequest.updated_at > latest ? mergeRequest.updated_at : latest),
      listedAt ?? now
    );
    const watermark = new Date(newest.getTime() + MERGE_REQUEST_OVERLAP_MS);

    await this.sourceWatermarkService.save('mergeRequest', source, project.id, watermark);

    state.watermark = watermark;
    state.saved = watermark;

    this.logger.log(
      { source: source.name, project: project.path, watermark },
      'startWatching(): Watching the merge requests from now on'
    );
  }

  /**
   * GitLab's clock at the listing, so the window moves on in a quiet project and an old event leaves it. The newest
   * `updated_at` listed stands in when GitLab sends no `Date` header.
   */
  private nextWatermark(watermark: Date, mergeRequests: IGitLabMergeRequest[], listedAt: Date | null): Date {
    let next = listedAt ?? watermark;

    if (listedAt === null) {
      for (const mergeRequest of mergeRequests) {
        if (mergeRequest.updated_at > next) {
          next = mergeRequest.updated_at;
        }
      }
    }

    return next > watermark ? next : watermark;
  }

  /**
   * On an event's last attempt, a related issue read that fails again gives no issue, so the event still fires for the
   * triggers that do not need one.
   */
  private async relatedIssueOrNoneOnLastAttempt(
    source: ISourceConfig,
    project: IIssueProject,
    pending: IPendingEvent,
    attempts: number,
    signal: AbortSignal
  ): Promise<IRelatedIssue | null> {
    try {
      return await this.relatedIssueOf(source, project, pending.mergeRequest, signal);
    } catch (error) {
      signal.throwIfAborted();

      if (attempts + 1 < MAX_MERGE_REQUEST_ATTEMPTS) {
        throw error;
      }

      this.logger.warn(
        {
          source: source.name,
          project: project.path,
          mergeRequest: pending.mergeRequest.iid,
          error: this.redactedMessage(error),
        },
        'relatedIssueOrNoneOnLastAttempt(): Failed to read the related issue again, so the event goes without one'
      );

      return null;
    }
  }

  /** Oldest first. A failed event comes from the retry set when the listing no longer yields it. */
  private dueEvents(
    mergeRequests: IGitLabMergeRequest[],
    state: IProjectState,
    cutoff: Date,
    events: ReadonlySet<MergeRequestEventKind>
  ): IPendingEvent[] {
    const due = new Map<string, IPendingEvent>(state.retries);

    for (const mergeRequest of mergeRequests) {
      const pending = this.eventOf(mergeRequest, cutoff);

      if (pending !== null) {
        due.set(this.keyOf(pending), pending);
      }
    }

    for (const [key, pending] of due) {
      if (!events.has(pending.event)) {
        due.delete(key);
        state.retries.delete(key);
      }
    }

    return [...due.values()].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  }

  /** Null unless the merge request was opened or merged inside the window and is in that state still. */
  private eventOf(mergeRequest: IGitLabMergeRequest, cutoff: Date): IPendingEvent | null {
    if (mergeRequest.state === 'opened' && mergeRequest.created_at >= cutoff) {
      return { mergeRequest, event: 'opened', occurredAt: mergeRequest.created_at };
    }

    const mergedAt = mergeRequest.merged_at ?? null;

    if (mergeRequest.state === 'merged' && mergedAt !== null && mergedAt >= cutoff) {
      return { mergeRequest, event: 'merged', occurredAt: mergedAt };
    }

    return null;
  }

  /**
   * The issue the title's trailing `(#<iid>)` names, read from the related issues when it is among them. Without one, the
   * related issue in the merge request's own project when exactly one relates, since a second may only be mentioned.
   */
  private async relatedIssueOf(
    source: ISourceConfig,
    project: IIssueProject,
    mergeRequest: IGitLabMergeRequest,
    signal: AbortSignal
  ): Promise<IRelatedIssue | null> {
    const titled = TITLE_ISSUE_PATTERN.exec(mergeRequest.title)?.[1];
    const titledIid = titled === undefined ? null : Number(titled);

    const related = (await this.readRelatedIssues(source, project, mergeRequest, signal)).filter(
      issue => issue.project_id === project.id
    );

    const chosen = related.find(issue => issue.iid === titledIid) ?? (titledIid === null ? this.onlyOf(related) : null);

    if (chosen !== null) {
      return { iid: chosen.iid, title: chosen.title, url: chosen.web_url };
    }

    if (titledIid === null) {
      return null;
    }

    const issue = await this.refusedAsNone(() => this.gitlabApiService.getIssue(source, project.id, titledIid, signal));

    return issue === null ? null : { iid: issue.iid, title: issue.title, url: issue.web_url };
  }

  private onlyOf<T>(items: readonly T[]): T | null {
    return items.length === 1 ? items[0] : null;
  }

  private async readRelatedIssues(
    source: ISourceConfig,
    project: IIssueProject,
    mergeRequest: IGitLabMergeRequest,
    signal: AbortSignal
  ): Promise<IGitLabRelatedIssue[]> {
    const related = await this.refusedAsNone(() =>
      this.gitlabApiService.listRelatedIssues(source, project.id, mergeRequest.iid, signal)
    );

    return related ?? [];
  }

  /**
   * Null when GitLab refuses the read, such as a 403 for a project with issues turned off, which no retry would change.
   * The event then goes without an issue rather than never firing. A 429 that outlasted the client's waits is retried.
   */
  private async refusedAsNone<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof GitLabApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        return null;
      }

      throw error;
    }
  }

  private recordFailure(
    source: ISourceConfig,
    project: IIssueProject,
    state: IProjectState,
    failed: IFailedEvent,
    error: unknown
  ): void {
    const { iid } = failed.mergeRequest;
    const key = this.keyOf(failed);
    const attempts = failed.attempts + 1;
    const context = {
      source: source.name,
      project: project.path,
      mergeRequest: iid,
      event: failed.event,
      attempts,
      error: this.redactedMessage(error),
    };

    state.retries.set(key, { ...failed, attempts });

    if (attempts >= MAX_MERGE_REQUEST_ATTEMPTS) {
      this.logger.error(
        context,
        'recordFailure(): The merge request event keeps failing, retrying it on the next poll'
      );

      return;
    }

    this.logger.warn(context, 'recordFailure(): Failed to emit the merge request event, retrying it on the next poll');
  }

  /** An event that happened before the window cannot be emitted again from the listing. */
  private forgetBefore(state: IProjectState, cutoff: Date): void {
    for (const [key, emitted] of state.emitted) {
      if (emitted.occurredAt < cutoff.getTime()) {
        state.emitted.delete(key);
      }
    }
  }

  /** Holds back at the oldest event awaiting a retry, so a restart lists it again rather than losing it. */
  private async saveWatermark(source: ISourceConfig, project: IIssueProject, state: IProjectState): Promise<void> {
    let saved = state.watermark;

    for (const failed of state.retries.values()) {
      if (saved === null || failed.occurredAt < saved) {
        saved = failed.occurredAt;
      }
    }

    if (saved === null || saved.getTime() === state.saved?.getTime()) {
      return;
    }

    await this.sourceWatermarkService.save('mergeRequest', source, project.id, saved);
    state.saved = saved;
  }

  /** A merge request's `opened` and `merged` events are kept apart, so a merge never replaces an `opened` retry. */
  private keyOf(pending: IPendingEvent): string {
    return `${pending.mergeRequest.iid}:${pending.event}`;
  }

  private snapshotOf(pending: IPendingEvent): string {
    const { mergeRequest } = pending;

    return JSON.stringify({
      event: pending.event,
      labels: mergeRequest.labels.toSorted(),
      targetBranch: mergeRequest.target_branch,
    });
  }

  private stateOf(sourceName: string, projectId: number): IProjectState {
    const projects = this.states.get(sourceName) ?? new Map<number, IProjectState>();
    this.states.set(sourceName, projects);

    const state = projects.get(projectId) ?? {
      watermark: null,
      saved: null,
      emitted: new Map<string, IEmitted>(),
      retries: new Map<string, IFailedEvent>(),
    };
    projects.set(projectId, state);

    return state;
  }

  private redactedMessage(error: unknown): unknown {
    return this.foundryConfigService.redact(errorText(error));
  }
}
