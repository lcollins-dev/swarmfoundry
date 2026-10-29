import { Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { z } from 'zod';

import { GitLabApiError } from './gitlab-api.error';
import type { IRequestLimits } from './issue-source.types';
import {
  gitlabIssueSchema,
  gitlabLabelEventSchema,
  gitlabMergeRequestSchema,
  gitlabNoteSchema,
  gitlabProjectSchema,
  gitlabRelatedIssueSchema,
  gitlabUserSchema,
  type IGitLabIssue,
  type IGitLabLabelEvent,
  type IGitLabMergeRequest,
  type IGitLabNote,
  type IGitLabProject,
  type IGitLabRelatedIssue,
} from './schema/gitlab';
import type { ISourceConfig } from '@/core/foundry-config/foundry-config.types';

const PAGE_SIZE = '100';
const REQUEST_TIMEOUT_MS = 30_000;

export const RATE_LIMIT_MAX_RETRIES = 5;

const DEFAULT_LIMITS: IRequestLimits = { timeoutMs: REQUEST_TIMEOUT_MS, rateLimitRetries: RATE_LIMIT_MAX_RETRIES };
const RATE_LIMIT_FALLBACK_MS = 10_000;
const RATE_LIMIT_MIN_WAIT_MS = 1_000;
const RATE_LIMIT_MAX_WAIT_MS = 15 * 60_000;

export type IGitLabConnection = Pick<ISourceConfig, 'url' | 'token'>;

export interface IIssueFilter {
  state?: 'opened';
  updatedAfter?: Date;
  iids?: number[];
}

export interface IMergeRequestFilter {
  updatedAfter: Date;
}

type QueryParams = Record<string, string | string[]>;

export interface IIssueChanges {
  addLabels?: readonly string[];
  removeLabels?: readonly string[];
  assigneeIds?: number[];
}

type Method = 'GET' | 'PUT' | 'POST';

const NOT_FOUND = 404;

export interface IIssueListing {
  /** Newest change first. */
  issues: IGitLabIssue[];
  /** GitLab's clock when the listing began, from the `Date` header. Null when the header is missing. */
  listedAt: Date | null;
}

export interface IMergeRequestListing {
  /** Newest change first, in every state. */
  mergeRequests: IGitLabMergeRequest[];
  /** GitLab's clock when the listing began, from the `Date` header. Null when the header is missing. */
  listedAt: Date | null;
}

interface IPages<T> {
  items: T[];
  firstAnsweredAt: Date | null;
}

@Injectable()
export class GitLabApiService {
  private readonly logger = new Logger(GitLabApiService.name);

  async getProject(connection: IGitLabConnection, project: string, signal: AbortSignal): Promise<IGitLabProject> {
    const { body } = await this.get(connection, `/projects/${encodeURIComponent(project)}`, {}, signal);

    return gitlabProjectSchema.parse(body);
  }

  /** Null when the issue does not exist, or the token cannot see it. */
  async getIssue(
    connection: IGitLabConnection,
    projectId: number,
    issueIid: number,
    signal: AbortSignal,
    limits: IRequestLimits = DEFAULT_LIMITS
  ): Promise<IGitLabIssue | null> {
    try {
      const { body } = await this.get(connection, `/projects/${projectId}/issues/${issueIid}`, {}, signal, limits);

      return gitlabIssueSchema.parse(body);
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === NOT_FOUND) {
        return null;
      }

      throw error;
    }
  }

  /** An added scoped label replaces the issue's label of the same scope. `assignee_ids` replaces every assignee. */
  async updateIssue(
    connection: IGitLabConnection,
    projectId: number,
    issueIid: number,
    changes: IIssueChanges,
    signal: AbortSignal
  ): Promise<void> {
    const { addLabels, removeLabels, assigneeIds } = changes;
    const payload: Record<string, string | number[]> = {};

    if (addLabels !== undefined) {
      payload.add_labels = addLabels.join(',');
    }

    if (removeLabels !== undefined) {
      payload.remove_labels = removeLabels.join(',');
    }

    if (assigneeIds !== undefined) {
      payload.assignee_ids = assigneeIds;
    }

    await this.send(connection, 'PUT', `/projects/${projectId}/issues/${issueIid}`, payload, signal);
  }

  /** Null when GitLab has no such user. */
  async findUserId(connection: IGitLabConnection, username: string, signal: AbortSignal): Promise<number | null> {
    const { body } = await this.get(connection, '/users', { username }, signal);
    const users = z.array(gitlabUserSchema).parse(body);

    return users.find(user => user.username.toLowerCase() === username.toLowerCase())?.id ?? null;
  }

  async createNote(
    connection: IGitLabConnection,
    projectId: number,
    issueIid: number,
    body: string,
    signal: AbortSignal
  ): Promise<void> {
    await this.send(connection, 'POST', `/projects/${projectId}/issues/${issueIid}/notes`, { body }, signal);
  }

  async listIssues(
    connection: IGitLabConnection,
    projectId: number,
    filter: IIssueFilter,
    signal: AbortSignal
  ): Promise<IIssueListing> {
    const params: QueryParams = { order_by: 'updated_at', sort: 'desc' };

    if (filter.state !== undefined) {
      params.state = filter.state;
    }

    if (filter.updatedAfter !== undefined) {
      params.updated_after = filter.updatedAfter.toISOString();
    }

    if (filter.iids !== undefined) {
      params['iids[]'] = filter.iids.map(String);
    }

    const { items, firstAnsweredAt } = await this.getAll(
      connection,
      `/projects/${projectId}/issues`,
      params,
      gitlabIssueSchema,
      signal
    );

    return { issues: items, listedAt: firstAnsweredAt };
  }

  async listLabelEvents(
    connection: IGitLabConnection,
    projectId: number,
    issueIid: number,
    signal: AbortSignal
  ): Promise<IGitLabLabelEvent[]> {
    const { items } = await this.getAll(
      connection,
      `/projects/${projectId}/issues/${issueIid}/resource_label_events`,
      {},
      gitlabLabelEventSchema,
      signal
    );

    return items;
  }

  /** Oldest first. `activity_filter` leaves out comments, but a caller still checks `system`. */
  async listSystemNotes(
    connection: IGitLabConnection,
    projectId: number,
    issueIid: number,
    signal: AbortSignal
  ): Promise<IGitLabNote[]> {
    const { items } = await this.getAll(
      connection,
      `/projects/${projectId}/issues/${issueIid}/notes`,
      { activity_filter: 'only_activity', order_by: 'created_at', sort: 'asc' },
      gitlabNoteSchema,
      signal
    );

    return items;
  }

  async listMergeRequests(
    connection: IGitLabConnection,
    projectId: number,
    filter: IMergeRequestFilter,
    signal: AbortSignal
  ): Promise<IMergeRequestListing> {
    const params: QueryParams = {
      order_by: 'updated_at',
      sort: 'desc',
      state: 'all',
      updated_after: filter.updatedAfter.toISOString(),
    };

    const { items, firstAnsweredAt } = await this.getAll(
      connection,
      `/projects/${projectId}/merge_requests`,
      params,
      gitlabMergeRequestSchema,
      signal
    );

    return { mergeRequests: items, listedAt: firstAnsweredAt };
  }

  /** Issues the merge request mentions or closes, in any project. */
  async listRelatedIssues(
    connection: IGitLabConnection,
    projectId: number,
    mergeRequestIid: number,
    signal: AbortSignal
  ): Promise<IGitLabRelatedIssue[]> {
    const { items } = await this.getAll(
      connection,
      `/projects/${projectId}/merge_requests/${mergeRequestIid}/related_issues`,
      {},
      gitlabRelatedIssueSchema,
      signal
    );

    return items;
  }

  rateLimitDelayMs(headers: Headers, attempt: number, now = Date.now()): number {
    const retryAfter = headers.get('retry-after');
    const reset = headers.get('ratelimit-reset');

    let delay = Number.NaN;

    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    } else if (reset !== null) {
      delay = Number(reset) * 1000 - now;
    }

    if (!Number.isFinite(delay)) {
      delay = RATE_LIMIT_FALLBACK_MS * 2 ** attempt;
    }

    return Math.min(Math.max(delay, RATE_LIMIT_MIN_WAIT_MS), RATE_LIMIT_MAX_WAIT_MS);
  }

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return sleepFor(milliseconds, undefined, { signal });
  }

  private async getAll<T>(
    connection: IGitLabConnection,
    path: string,
    params: QueryParams,
    schema: z.ZodType<T>,
    signal: AbortSignal
  ): Promise<IPages<T>> {
    const items: T[] = [];
    let firstAnsweredAt: Date | null = null;
    let page = 1;

    for (;;) {
      const pageParams = { ...params, per_page: PAGE_SIZE, page: String(page) };
      const { body, headers } = await this.get(connection, path, pageParams, signal);

      items.push(...z.array(schema).parse(body));

      if (page === 1) {
        firstAnsweredAt = this.answeredAt(headers);
      }

      const nextPage = Number(headers.get('x-next-page') ?? '');

      if (!Number.isInteger(nextPage) || nextPage <= page) {
        return { items, firstAnsweredAt };
      }

      page = nextPage;
    }
  }

  private async get(
    connection: IGitLabConnection,
    path: string,
    params: QueryParams,
    signal: AbortSignal,
    limits: IRequestLimits = DEFAULT_LIMITS
  ): Promise<{ body: unknown; headers: Headers }> {
    const url = this.url(connection, path);

    for (const [name, value] of Object.entries(params)) {
      for (const item of typeof value === 'string' ? [value] : value) {
        url.searchParams.append(name, item);
      }
    }

    const response = await this.request(connection, 'GET', url, path, undefined, signal, limits);
    const body: unknown = await response.json();

    return { body, headers: response.headers };
  }

  private async send(
    connection: IGitLabConnection,
    method: Method,
    path: string,
    payload: Record<string, string | number[]>,
    signal: AbortSignal
  ): Promise<void> {
    const url = this.url(connection, path);
    const response = await this.request(connection, method, url, path, payload, signal, DEFAULT_LIMITS);

    await response.body?.cancel();
  }

  /** Waits out a 429 and retries, up to `limits.rateLimitRetries` times. Resolves with a 2xx response only. */
  private async request(
    connection: IGitLabConnection,
    method: Method,
    url: URL,
    path: string,
    payload: Record<string, string | number[]> | undefined,
    signal: AbortSignal,
    limits: IRequestLimits
  ): Promise<Response> {
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': connection.token, Accept: 'application/json' };

    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    for (let attempt = 0; ; attempt++) {
      // `redirect: 'error'`, since fetch forwards a custom header such as PRIVATE-TOKEN across origins.
      const response = await fetch(url, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]),
      });

      if (response.status === 429 && attempt < limits.rateLimitRetries) {
        await response.body?.cancel();

        const delayMs = this.rateLimitDelayMs(response.headers, attempt);

        this.logger.warn(
          { method, path, delayMs, attempt: attempt + 1 },
          'request(): GitLab rate-limited the request, waiting before retrying'
        );

        await this.sleep(delayMs, signal);

        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();

        throw new GitLabApiError(response.status, method, path);
      }

      return response;
    }
  }

  private url(connection: IGitLabConnection, path: string): URL {
    return new URL(`${connection.url.replace(/\/+$/, '')}/api/v4${path}`);
  }

  private answeredAt(headers: Headers): Date | null {
    const date = Date.parse(headers.get('date') ?? '');

    return Number.isNaN(date) ? null : new Date(date);
  }
}
