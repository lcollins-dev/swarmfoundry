import { Injectable, Logger } from '@nestjs/common';

import { GitLabApiService } from './gitlab-api.service';
import { GitLabMergeRequestSourceService } from './gitlab-merge-request-source.service';
import { SourceWatermarkService } from './source-watermark.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';

import { errorText, GitLabUnknownUserError } from './gitlab-api.error';
import { SILENT_EDIT_WINDOW_MS, WATERMARK_OVERLAP_MS } from './gitlab-polling.constants';
import type {
  IIssueAssignment,
  IIssueEvent,
  IIssueLabelEvent,
  IIssueProject,
  IIssueSource,
  IIssueState,
  IRequestLimits,
  SourceEventHandler,
} from './issue-source.types';
import type { IGitLabIssue, IGitLabLabelEvent, IGitLabNote } from './schema/gitlab';
import type { ISourceConfig, MergeRequestEventKind } from '@/core/foundry-config/foundry-config.types';

export const MAX_ISSUE_ATTEMPTS = 3;
export const MAX_EMITTED_PER_PROJECT = 10_000;

// GitLab writes "assigned to @a and @b and unassigned @c". The text is not an API contract.
const ASSIGNMENT_NOTE = /^assigned to (.+?)(?: and unassigned .*)?$/s;
const MENTION = /@([\w.-]+)/g;

interface IEmitted {
  updatedAt: number;
  /**
   * Labels, assignees and the newest label event and assignment ids, which can change without moving `updated_at`.
   * Null when unread.
   */
  snapshot: string | null;
  /** Read `SILENT_EDIT_WINDOW_MS` or more after `updatedAt`, so any further change moves `updated_at`. */
  settled: boolean;
}

interface IRetry {
  attempts: number;
  updatedAt: Date;
  /** The window start of the poll it first failed in, so its changes stay inside the window on a retry. */
  since: Date;
}

interface IProjectState {
  project?: IIssueProject;
  /** GitLab's `updated_at`, never the orchestrator's clock. Null until read from Postgres. */
  watermark: Date | null;
  /** The watermark Postgres holds, so an unchanged one is not written again. */
  saved: Date | null;
  /** By iid, least recently read first, so the overlap does not emit an unchanged issue twice. */
  emitted: Map<number, IEmitted>;
  /** By iid. The next poll reads these issues by iid, since the watermark has moved past them. */
  retries: Map<number, IRetry>;
}

@Injectable()
export class GitLabSourceService implements IIssueSource {
  private readonly logger = new Logger(GitLabSourceService.name);

  /** By source name, then by the project as configured. */
  private readonly states = new Map<string, Map<string, IProjectState>>();

  /** By source name: the URL and project ids whose issue watermarks were last retained, so an unchanged set is not removed again. */
  private readonly retained = new Map<string, string>();

  private warnedNoListingTime = false;

  constructor(
    private readonly gitlabApiService: GitLabApiService,
    private readonly gitlabMergeRequestSourceService: GitLabMergeRequestSourceService,
    private readonly sourceWatermarkService: SourceWatermarkService,
    private readonly foundryConfigService: FoundryConfigService
  ) {}

  /**
   * Polls a project's merge requests only while a merge request trigger on the source applies to it, even when its
   * issues failed, and removes the merge request watermarks of every other project and the issue watermarks of every
   * project not configured.
   */
  async poll(source: ISourceConfig, emit: SourceEventHandler, signal: AbortSignal): Promise<void> {
    const loaded: number[] = [];
    const watched: number[] = [];
    const unwatched: number[] = [];
    let everyWatchedLoaded = true;

    for (const configured of source.projects) {
      try {
        await this.pollProject(source, configured, emit, signal);
      } catch (error) {
        signal.throwIfAborted();

        this.logger.error(
          { source: source.name, project: configured, error: this.redactedMessage(error) },
          'poll(): Failed to poll the project, retrying on the next poll'
        );
      }

      // The issue poll loads the project, so a failed load is not tried twice in one poll.
      const { project } = this.stateOf(source.name, configured);
      const events = this.watchedEvents(source, configured);

      if (project !== undefined) {
        loaded.push(project.id);
      }

      if (events.size === 0) {
        if (project !== undefined) {
          unwatched.push(project.id);
        }

        continue;
      }

      if (project === undefined) {
        everyWatchedLoaded = false;

        continue;
      }

      watched.push(project.id);

      try {
        await this.gitlabMergeRequestSourceService.poll(source, project, events, emit, signal);
      } catch (error) {
        signal.throwIfAborted();

        this.logger.error(
          { source: source.name, project: configured, error: this.redactedMessage(error) },
          "poll(): Failed to poll the project's merge requests, retrying on the next poll"
        );
      }
    }

    await this.retainMergeRequestWatermarks(source, watched, unwatched, everyWatchedLoaded, signal);

    if (loaded.length === source.projects.length) {
      await this.retainIssueWatermarks(source, loaded, signal);
    }
  }

  async readIssue(
    source: ISourceConfig,
    projectId: number,
    issueIid: number,
    signal: AbortSignal,
    limits?: IRequestLimits
  ): Promise<IIssueState | null> {
    const issue = await this.gitlabApiService.getIssue(source, projectId, issueIid, signal, limits);

    if (issue === null) {
      return null;
    }

    return { open: issue.state === 'opened', labels: issue.labels, assignees: this.usernamesOf(issue) };
  }

  async relabel(
    source: ISourceConfig,
    projectId: number,
    issueIid: number,
    add: readonly string[],
    remove: readonly string[],
    signal: AbortSignal
  ): Promise<void> {
    await this.gitlabApiService.updateIssue(
      source,
      projectId,
      issueIid,
      { addLabels: add.length === 0 ? undefined : add, removeLabels: remove.length === 0 ? undefined : remove },
      signal
    );
  }

  async assign(
    source: ISourceConfig,
    projectId: number,
    issueIid: number,
    usernames: readonly string[],
    signal: AbortSignal
  ): Promise<void> {
    const ids = await Promise.all(
      usernames.map(username => this.gitlabApiService.findUserId(source, username, signal))
    );
    const assigneeIds: number[] = [];

    for (const [index, id] of ids.entries()) {
      if (id === null) {
        throw new GitLabUnknownUserError(usernames[index]);
      }

      assigneeIds.push(id);
    }

    await this.gitlabApiService.updateIssue(source, projectId, issueIid, { assigneeIds }, signal);
  }

  comment(source: ISourceConfig, projectId: number, issueIid: number, body: string, signal: AbortSignal) {
    return this.gitlabApiService.createNote(source, projectId, issueIid, body, signal);
  }

  /** A watched project not yet loaded has an unknown id, so only the unwatched ones known are removed until it loads. */
  private async retainMergeRequestWatermarks(
    source: ISourceConfig,
    watched: number[],
    unwatched: number[],
    everyWatchedLoaded: boolean,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await this.gitlabMergeRequestSourceService.retainProjects(source, watched, unwatched, everyWatchedLoaded);
    } catch (error) {
      signal.throwIfAborted();

      this.logger.error(
        { source: source.name, error: this.redactedMessage(error) },
        'retainMergeRequestWatermarks(): Failed to remove the watermarks of unwatched projects'
      );
    }
  }

  /** Runs only once every configured project has loaded, since the id of one that has not is unknown. */
  private async retainIssueWatermarks(source: ISourceConfig, projectIds: number[], signal: AbortSignal): Promise<void> {
    const call = JSON.stringify([source.url, projectIds.toSorted((left, right) => left - right)]);

    if (this.retained.get(source.name) === call) {
      return;
    }

    try {
      await this.sourceWatermarkService.retainProjects('issue', source, projectIds);
      this.retained.set(source.name, call);
    } catch (error) {
      signal.throwIfAborted();

      this.logger.error(
        { source: source.name, error: this.redactedMessage(error) },
        'retainIssueWatermarks(): Failed to remove the issue watermarks of projects no longer configured'
      );
    }
  }

  /** The events of every merge request trigger on the source that applies to the project, compared as `appliesTo` does. */
  private watchedEvents(source: ISourceConfig, configured: string): Set<MergeRequestEventKind> {
    const path = configured.toLowerCase();
    const events = new Set<MergeRequestEventKind>();

    for (const { source: triggerSource, mergeRequest } of this.foundryConfigService.triggers) {
      const projects = mergeRequest?.projects ?? [];

      if (
        mergeRequest !== undefined &&
        triggerSource.name === source.name &&
        (projects.length === 0 || projects.some(project => project.toLowerCase() === path))
      ) {
        events.add(mergeRequest.event);
      }
    }

    return events;
  }

  forget(sourceName: string): void {
    this.states.delete(sourceName);
    this.retained.delete(sourceName);
    this.gitlabMergeRequestSourceService.forget(sourceName);
  }

  // Lists every state: a close moves the issue to the front of the page order, where a state filter would drop it and
  // shift an unread issue onto a page already read.
  private async pollProject(
    source: ISourceConfig,
    configured: string,
    emit: SourceEventHandler,
    signal: AbortSignal
  ): Promise<void> {
    const state = this.stateOf(source.name, configured);
    const project = state.project ?? (await this.loadProject(source, configured, signal));
    state.project = project;

    if (state.watermark === null) {
      state.watermark = await this.sourceWatermarkService.find('issue', source, project.id);
      state.saved = state.watermark;
    }

    if (state.watermark === null) {
      await this.startWatching(source, project, state, signal);

      return;
    }

    const cutoff = new Date(state.watermark.getTime() - WATERMARK_OVERLAP_MS);

    const { issues, listedAt } = await this.gitlabApiService.listIssues(
      source,
      project.id,
      { updatedAfter: cutoff },
      signal
    );

    if (listedAt === null) {
      this.warnNoListingTime(source);
    }

    const retried = await this.readRetries(source, project, state, issues, signal);

    for (const issue of issues) {
      if (issue.updated_at > state.watermark) {
        state.watermark = issue.updated_at;
      }
    }

    let emitted = 0;

    const due = [...issues, ...retried].sort((left, right) => left.updated_at.getTime() - right.updated_at.getTime());

    for (const issue of due) {
      if (issue.state !== 'opened') {
        state.retries.delete(issue.iid);

        continue;
      }

      const known = state.retries.has(issue.iid) ? undefined : state.emitted.get(issue.iid);
      const sameUpdate = known?.updatedAt === issue.updated_at.getTime();

      if (sameUpdate && known.settled) {
        continue;
      }

      const settled = listedAt !== null && listedAt.getTime() - issue.updated_at.getTime() >= SILENT_EDIT_WINDOW_MS;
      const since = state.retries.get(issue.iid)?.since ?? cutoff;
      let snapshot: string | null = null;

      try {
        const [labelEvents, notes] = await Promise.all([
          this.gitlabApiService.listLabelEvents(source, project.id, issue.iid, signal),
          this.gitlabApiService.listSystemNotes(source, project.id, issue.iid, signal),
        ]);
        const read = this.toEvent(source.name, project, issue, labelEvents, notes);
        snapshot = this.snapshotOf(read);
        const event = this.since(read, since);

        if (!sameUpdate || known.snapshot !== snapshot) {
          await emit(event);
          emitted++;
        }

        state.retries.delete(issue.iid);
        this.remember(state, issue.iid, { updatedAt: issue.updated_at.getTime(), snapshot, settled });
      } catch (error) {
        signal.throwIfAborted();

        const read = { updatedAt: issue.updated_at.getTime(), snapshot, settled };
        this.recordFailure(source, project, state, issue.iid, { updatedAt: issue.updated_at, since }, error, read);
      }
    }

    this.forgetBefore(state, cutoff);
    await this.saveWatermark(source, project, state);

    this.logger.debug(
      { source: source.name, project: project.path, listed: issues.length, retried: retried.length, emitted },
      'pollProject(): Polled the project'
    );
  }

  /**
   * Starts an overlap past GitLab's clock now, so the first listing opens at the first poll and no issue untouched since
   * fires.
   */
  private async startWatching(
    source: ISourceConfig,
    project: IIssueProject,
    state: IProjectState,
    signal: AbortSignal
  ): Promise<void> {
    const now = new Date();
    const { issues, listedAt } = await this.gitlabApiService.listIssues(
      source,
      project.id,
      { updatedAfter: now },
      signal
    );

    const newest = issues.reduce(
      (latest, issue) => (issue.updated_at > latest ? issue.updated_at : latest),
      listedAt ?? now
    );
    const watermark = new Date(newest.getTime() + WATERMARK_OVERLAP_MS);

    // Kept even when the write fails, so the next poll saves it rather than starting again later.
    state.watermark = watermark;

    await this.sourceWatermarkService.save('issue', source, project.id, watermark);
    state.saved = watermark;

    this.logger.log(
      { source: source.name, project: project.path, watermark },
      'startWatching(): Watching the issues from now on'
    );
  }

  /**
   * Holds back to an overlap past the earliest window start of an issue awaiting a retry, so a restart lists it again
   * with its changes inside the window, and lists nothing older.
   */
  private async saveWatermark(source: ISourceConfig, project: IIssueProject, state: IProjectState): Promise<void> {
    let saved = state.watermark;

    for (const { since } of state.retries.values()) {
      const held = new Date(since.getTime() + WATERMARK_OVERLAP_MS);

      if (saved === null || held < saved) {
        saved = held;
      }
    }

    if (saved === null || saved.getTime() === state.saved?.getTime()) {
      return;
    }

    await this.sourceWatermarkService.save('issue', source, project.id, saved);
    state.saved = saved;
  }

  private async readRetries(
    source: ISourceConfig,
    project: IIssueProject,
    state: IProjectState,
    listed: IGitLabIssue[],
    signal: AbortSignal
  ): Promise<IGitLabIssue[]> {
    const listedIids = new Set(listed.map(issue => issue.iid));
    const pending = [...state.retries].filter(([iid]) => !listedIids.has(iid));
    const iids = pending.map(([iid]) => iid);

    if (iids.length === 0) {
      return [];
    }

    try {
      const { issues } = await this.gitlabApiService.listIssues(source, project.id, { iids }, signal);
      const found = new Set(issues.map(issue => issue.iid));

      // GitLab no longer returns a deleted or moved issue.
      for (const iid of iids.filter(missing => !found.has(missing))) {
        state.retries.delete(iid);
      }

      return issues;
    } catch (error) {
      signal.throwIfAborted();

      for (const [iid, retry] of pending) {
        this.recordFailure(source, project, state, iid, retry, error);
      }

      return [];
    }
  }

  private recordFailure(
    source: ISourceConfig,
    project: IIssueProject,
    state: IProjectState,
    iid: number,
    { updatedAt, since }: Omit<IRetry, 'attempts'>,
    error: unknown,
    read?: IEmitted
  ): void {
    const attempts = (state.retries.get(iid)?.attempts ?? 0) + 1;
    const context = { source: source.name, project: project.path, iid, attempts, error: this.redactedMessage(error) };

    if (attempts >= MAX_ISSUE_ATTEMPTS) {
      state.retries.delete(iid);
      this.logger.error(context, 'recordFailure(): Giving up on the issue, re-add its label or reassign it to run it');

      // The overlap would otherwise list the issue again and restart its attempts.
      if (read !== undefined) {
        this.remember(state, iid, read);
      }

      return;
    }

    state.retries.set(iid, { attempts, updatedAt, since });
    this.logger.warn(context, 'recordFailure(): Failed to emit the issue, retrying it on the next poll');
  }

  private remember(state: IProjectState, issueIid: number, read: IEmitted): void {
    state.emitted.delete(issueIid);
    state.emitted.set(issueIid, read);

    for (const iid of state.emitted.keys()) {
      if (state.emitted.size <= MAX_EMITTED_PER_PROJECT) {
        break;
      }

      state.emitted.delete(iid);
    }
  }

  private warnNoListingTime(source: ISourceConfig): void {
    if (this.warnedNoListingTime) {
      return;
    }

    this.warnedNoListingTime = true;
    this.logger.warn(
      { source: source.name },
      'warnNoListingTime(): GitLab sent no Date header, so issues inside the overlap are read again on every poll'
    );
  }

  private stateOf(sourceName: string, configured: string): IProjectState {
    const projects = this.states.get(sourceName) ?? new Map<string, IProjectState>();
    this.states.set(sourceName, projects);

    const state = projects.get(configured) ?? {
      watermark: null,
      saved: null,
      emitted: new Map<number, IEmitted>(),
      retries: new Map<number, IRetry>(),
    };
    projects.set(configured, state);

    return state;
  }

  private async loadProject(source: ISourceConfig, configured: string, signal: AbortSignal): Promise<IIssueProject> {
    const project = await this.gitlabApiService.getProject(source, configured, signal);

    return { id: project.id, path: project.path_with_namespace, url: project.web_url };
  }

  private forgetBefore(state: IProjectState, cutoff: Date): void {
    for (const [iid, read] of state.emitted) {
      if (read.updatedAt < cutoff.getTime()) {
        state.emitted.delete(iid);
      }
    }
  }

  private toEvent(
    sourceName: string,
    project: IIssueProject,
    issue: IGitLabIssue,
    labelEvents: IGitLabLabelEvent[],
    notes: IGitLabNote[]
  ): IIssueEvent {
    return {
      source: sourceName,
      project,
      issue: {
        iid: issue.iid,
        title: issue.title,
        url: issue.web_url,
        labels: issue.labels,
        author: issue.author?.username ?? null,
        assignees: this.usernamesOf(issue),
        updatedAt: issue.updated_at,
      },
      labelEvents: labelEvents
        .flatMap(event => this.toLabelEvent(event))
        .sort((left, right) => this.compareOldestFirst(left, right)),
      assignments: notes
        .flatMap(note => this.toAssignment(note))
        .sort((left, right) => this.compareOldestFirst(left, right)),
    };
  }

  /** Without the changes made before `since`, so a task keys only on a change inside the window. */
  private since(event: IIssueEvent, since: Date): IIssueEvent {
    return {
      ...event,
      labelEvents: event.labelEvents.filter(labelEvent => labelEvent.createdAt >= since),
      assignments: event.assignments.filter(assignment => assignment.createdAt >= since),
    };
  }

  /** Taken before `since`, so the window moving on alone does not emit the issue again. */
  private snapshotOf(event: IIssueEvent): string {
    const newestOf = (changes: readonly { id: number }[]) => Math.max(0, ...changes.map(change => change.id));

    return JSON.stringify({
      labels: event.issue.labels.toSorted(),
      assignees: event.issue.assignees.toSorted(),
      newestLabelEvent: newestOf(event.labelEvents),
      newestAssignment: newestOf(event.assignments),
    });
  }

  private usernamesOf(issue: IGitLabIssue): string[] {
    return issue.assignees.map(assignee => assignee.username);
  }

  private toLabelEvent(event: IGitLabLabelEvent): IIssueLabelEvent[] {
    if (event.label === null || (event.action !== 'add' && event.action !== 'remove')) {
      return [];
    }

    return [
      {
        id: event.id,
        label: event.label.name,
        action: event.action,
        createdAt: event.created_at,
        actor: event.user?.username ?? null,
      },
    ];
  }

  /** Only a system note counts, since anyone who can comment could write the same text. */
  private toAssignment(note: IGitLabNote): IIssueAssignment[] {
    const assigned = note.system ? ASSIGNMENT_NOTE.exec(note.body) : null;

    if (assigned === null) {
      return [];
    }

    return [
      {
        id: note.id,
        usernames: [...assigned[1].matchAll(MENTION)].map(mention => mention[1]),
        createdAt: note.created_at,
        actor: note.author?.username ?? null,
      },
    ];
  }

  private compareOldestFirst(left: { id: number; createdAt: Date }, right: { id: number; createdAt: Date }): number {
    const byTime = left.createdAt.getTime() - right.createdAt.getTime();

    return byTime === 0 ? left.id - right.id : byTime;
  }

  private redactedMessage(error: unknown): unknown {
    return this.foundryConfigService.redact(errorText(error));
  }
}
