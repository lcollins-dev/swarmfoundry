import { Injectable } from '@nestjs/common';

import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { IssueSourceService } from '@/core/issue-source/issue-source.service';
import { TaskService } from '@/core/task/task.service';

import type { IActionAgent, IActionHandler, IFailureMessage, IStepRequest } from './actions.types';
import type { IStaticStepConfig } from '@/core/foundry-config/foundry-config.types';
import { GitLabApiError } from '@/core/issue-source/gitlab-api.error';
import { DeploymentFault, RunOutcome, type IRunJudgement, type IRunReport } from '@/core/task/task.types';

const UNAUTHORIZED = 401;
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;

const TIMEOUT_ERROR_NAMES = new Set(['TimeoutError', 'AbortError']);

const ERROR_MAX_LENGTH = 2000;

interface IIssueRef {
  projectId: number;
  issueIid: number;
}

/**
 * Runs the `relabel`, `comment` and `assign` steps against the task's issue with the source's token: the issue itself
 * for an issue trigger, the related issue for a merge request trigger. Never rejects.
 */
@Injectable()
export class IssueActionService implements IActionHandler<IStaticStepConfig> {
  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly issueSourceService: IssueSourceService,
    private readonly taskService: TaskService
  ) {}

  isReady(): boolean {
    return true;
  }

  agentOf(): IActionAgent | null {
    return null;
  }

  /** A merge request task with no related issue completes with nothing to do, and the run's `result` says so. */
  async run(request: IStepRequest<IStaticStepConfig>): Promise<IRunReport> {
    const { step, task, run } = request;
    const { projectId, issueIid } = task;

    if (projectId === null || issueIid === null) {
      const mergeRequest = task.mergeRequestIid === null ? 'The task' : `Merge request !${task.mergeRequestIid}`;

      return this.done(`${mergeRequest} relates to no issue, so the ${step.kind} step had nothing to act on`);
    }

    try {
      return this.done(await this.act(request, { projectId, issueIid }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = this.foundryConfigService.redactText(message).slice(0, ERROR_MAX_LENGTH);

      return {
        exitCode: null,
        result: null,
        error: `${run.list}[${run.step}] (${step.kind}) failed: ${redacted}`,
        deploymentFault: this.deploymentFault(error),
      };
    }
  }

  /** Acts again from the start, since a static step leaves nothing to follow. */
  resume(request: IStepRequest<IStaticStepConfig>): Promise<IRunReport> {
    return this.run(request);
  }

  judge(_step: IStaticStepConfig, report: IRunReport): IRunJudgement {
    return report.error === null
      ? { outcome: RunOutcome.SUCCEEDED, error: null, deploymentFault: null }
      : { outcome: RunOutcome.FAILED, error: report.error, deploymentFault: report.deploymentFault ?? null };
  }

  secretsOf(): string[] {
    return [];
  }

  removeLeftoversExcept(): Promise<void> {
    return Promise.resolve();
  }

  failureMessage(): Promise<IFailureMessage | null> {
    return Promise.resolve(null);
  }

  private async act(request: IStepRequest<IStaticStepConfig>, { projectId, issueIid }: IIssueRef): Promise<string> {
    const { trigger, step, task, run, failure, signal } = request;
    const { source } = trigger;

    if (step.kind === 'relabel') {
      await this.issueSourceService.relabel(source, projectId, issueIid, step.add, step.remove, signal);

      const added = step.add.length === 0 ? [] : [`added ${step.add.join(', ')}`];
      const removed = step.remove.length === 0 ? [] : [`removed ${step.remove.join(', ')}`];

      return `Relabelled issue ${issueIid}: ${[...added, ...removed].join('; ')}`;
    }

    if (step.kind === 'assign') {
      await this.issueSourceService.assign(source, projectId, issueIid, step.usernames, signal);

      return `Assigned issue ${issueIid} to ${step.usernames.join(', ')}`;
    }

    const context = await this.taskService.promptContext(trigger, task, run);
    const body = this.foundryConfigService.renderComment(step, { ...context, failure });

    await this.issueSourceService.comment(
      source,
      projectId,
      issueIid,
      this.foundryConfigService.redactText(body),
      signal
    );

    return `Commented on issue ${issueIid}`;
  }

  private done(summary: string): IRunReport {
    return { exitCode: null, result: summary, error: null };
  }

  /**
   * A 429, a 5xx, a network error or a timeout is transient, and a 401 a refused token. Any other 4xx or an unknown user
   * is the step's own failure, since a 403 can be one project's permission.
   */
  private deploymentFault(error: unknown): DeploymentFault | undefined {
    if (error instanceof GitLabApiError && error.status === UNAUTHORIZED) {
      return DeploymentFault.PERMANENT;
    }

    return this.isTransient(error) ? DeploymentFault.TRANSIENT : undefined;
  }

  private isTransient(error: unknown): boolean {
    if (error instanceof GitLabApiError) {
      return error.status === TOO_MANY_REQUESTS || error.status >= SERVER_ERROR;
    }

    // fetch rejects a network failure and a refused redirect alike, but only the network failure's cause has a code.
    if (error instanceof TypeError) {
      return error.cause instanceof Error && 'code' in error.cause && typeof error.cause.code === 'string';
    }

    return error instanceof Error && TIMEOUT_ERROR_NAMES.has(error.name);
  }
}
