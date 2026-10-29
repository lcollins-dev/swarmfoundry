import type { ISourceConfig, MergeRequestEventKind } from '@/core/foundry-config/foundry-config.types';

export type IssueChangeKind = 'label' | 'assignment';

/** A label event or an assignment, which an issue task keys on. */
export interface IIssueChange {
  kind: IssueChangeKind;
  /** Unique per source and kind. GitLab numbers label events and notes apart, so ids of two kinds do not compare. */
  id: number;
  createdAt: Date;
  /** Null when GitLab no longer has the user. */
  actor: string | null;
}

export interface IIssueLabelEvent extends Omit<IIssueChange, 'kind'> {
  label: string;
  action: 'add' | 'remove';
}

/** From GitLab's system note, as no API lists assignments. */
export interface IIssueAssignment extends Omit<IIssueChange, 'kind'> {
  /** The users the note assigns. Those it unassigns are left out. */
  usernames: string[];
}

export interface IIssueProject {
  id: number;
  path: string;
  url: string;
}

export interface IIssue {
  iid: number;
  title: string;
  url: string;
  labels: string[];
  /** A username. Null when GitLab no longer has the user. */
  author: string | null;
  /** Usernames. */
  assignees: string[];
  updatedAt: Date;
}

export interface IRequestLimits {
  timeoutMs: number;
  rateLimitRetries: number;
}

export interface IIssueState {
  open: boolean;
  labels: string[];
  /** Usernames. */
  assignees: string[];
}

export interface IIssueEvent {
  source: string;
  project: IIssueProject;
  issue: IIssue;
  /** Inside the poll's window, oldest first. */
  labelEvents: IIssueLabelEvent[];
  /** Inside the poll's window, oldest first. */
  assignments: IIssueAssignment[];
}

export interface IMergeRequest {
  iid: number;
  title: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  labels: string[];
}

export interface IRelatedIssue {
  iid: number;
  title: string;
  url: string;
}

/** Emitted by every poll whose window holds the event, so the handler may see it more than once. */
export interface IMergeRequestEvent {
  source: string;
  project: IIssueProject;
  event: MergeRequestEventKind;
  mergeRequest: IMergeRequest;
  /** In the merge request's own project. Null when it relates to none. */
  relatedIssue: IRelatedIssue | null;
}

export type ISourceEvent = IIssueEvent | IMergeRequestEvent;

/**
 * Persist or enqueue the event, then resolve. Never wait for a run: the poll waits on each handler, and shutdown waits on
 * the poll. A rejection makes the source emit the event again on the next poll, up to a few attempts.
 */
export type SourceEventHandler = (event: ISourceEvent) => Promise<void>;

/** Implemented once per source `type`, as an injectable that keeps each configured source's poll state. */
export interface IIssueSource {
  /**
   * Emits one event per open issue updated since the source's last poll, oldest change first, then one per merge request
   * opened or merged since, and awaits each. Rejects only when `signal` aborts; it logs any other failure and retries it
   * on later polls.
   */
  poll(source: ISourceConfig, emit: SourceEventHandler, signal: AbortSignal): Promise<void>;

  /** Null when the issue no longer exists, or the source's token cannot see it. */
  readIssue(
    source: ISourceConfig,
    projectId: number,
    issueIid: number,
    signal: AbortSignal,
    limits?: IRequestLimits
  ): Promise<IIssueState | null>;

  relabel(
    source: ISourceConfig,
    projectId: number,
    issueIid: number,
    add: readonly string[],
    remove: readonly string[],
    signal: AbortSignal
  ): Promise<void>;

  /** Replaces the issue's assignees. Rejects naming the first username the source has no user for. */
  assign(
    source: ISourceConfig,
    projectId: number,
    issueIid: number,
    usernames: readonly string[],
    signal: AbortSignal
  ): Promise<void>;

  /** Posts `body` as written, so the caller redacts it. */
  comment(source: ISourceConfig, projectId: number, issueIid: number, body: string, signal: AbortSignal): Promise<void>;

  /** Drops the source's poll state, so its next poll starts as the first poll after startup does. */
  forget(sourceName: string): void;
}
