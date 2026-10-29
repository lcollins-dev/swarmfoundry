import { Injectable } from '@nestjs/common';

import type { Task } from '@/core/task/entities/task.entity';

import { TriggerMatchService } from './trigger-match.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { IssueSourceService } from '@/core/issue-source/issue-source.service';
import { TaskService } from '@/core/task/task.service';

import type { TaskCheck } from './trigger-engine.types';
import type {
  IMergeRequestTriggerConfig,
  ITriggerConfig,
  TriggerKind,
} from '@/core/foundry-config/foundry-config.types';
import { triggerKindOf } from '@/core/foundry-config/trigger-kind';
import type { IIssueState, IRequestLimits } from '@/core/issue-source/issue-source.types';
import { taskKindOf } from '@/core/task/task-kind';
import { StepList } from '@/core/task/task.types';

const KIND_NAMES: Record<TriggerKind, string> = {
  issue: 'issue labels',
  schedule: 'a schedule',
  mergeRequest: 'merge request events',
};

/** A deferral is cheap, so a slow or rate-limiting GitLab must not hold up the dispatch pass. */
export const CHECK_LIMITS: IRequestLimits = { timeoutMs: 10_000, rateLimitRetries: 0 };

@Injectable()
export class TaskCheckService {
  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly issueSourceService: IssueSourceService,
    private readonly triggerMatchService: TriggerMatchService,
    private readonly taskService: TaskService
  ) {}

  /**
   * Matches the issue against the trigger only before the task's first run, and after that only checks it is open. A
   * scheduled or merge request task has no issue to read, so it starts unless the trigger changed under it. A failure
   * step always starts, since the task has already failed and its failure is still reported. Rejects when `signal`
   * aborts or the database fails.
   */
  async check(trigger: ITriggerConfig, task: Task, signal: AbortSignal): Promise<TaskCheck> {
    if (task.list === StepList.FAILURE_STEPS) {
      return { kind: 'start' };
    }

    const triggerKind = triggerKindOf(trigger);
    const taskKind = taskKindOf(task);

    if (triggerKind !== taskKind) {
      const reason = `Trigger ${trigger.name} now starts on ${KIND_NAMES[triggerKind]}, not ${KIND_NAMES[taskKind]}`;

      return { kind: 'cancel', reason };
    }

    if (!this.triggerMatchService.appliesTo(trigger, task.projectPath)) {
      return { kind: 'cancel', reason: `The trigger no longer applies to project ${task.projectPath}` };
    }

    if (trigger.mergeRequest !== undefined) {
      return this.checkMergeRequest(trigger, task);
    }

    if (trigger.issue === undefined || task.projectId === null || task.issueIid === null) {
      return { kind: 'start' };
    }

    const newer = await this.taskService.findNewer(task);

    if (newer !== null) {
      return { kind: 'cancel', reason: `Task ${newer.id} was queued for a later change on the issue` };
    }

    let issue: IIssueState | null;

    try {
      issue = await this.issueSourceService.readIssue(
        trigger.source,
        task.projectId,
        task.issueIid,
        signal,
        CHECK_LIMITS
      );
    } catch (error) {
      signal.throwIfAborted();

      const message = error instanceof Error ? error.message : String(error);

      return { kind: 'defer', error: this.foundryConfigService.redactText(message) };
    }

    if (issue === null) {
      return { kind: 'cancel', reason: 'The issue no longer exists' };
    }

    if (!issue.open) {
      return { kind: 'cancel', reason: 'The issue is closed' };
    }

    // A started task runs to the end, since its own steps may have moved the ticket off the match.
    if (task.step > 0 || (await this.taskService.countRuns(task.id)) > 0) {
      return { kind: 'start' };
    }

    const mismatch = this.triggerMatchService.mismatch(issue, trigger);

    return mismatch === null ? { kind: 'start' } : { kind: 'cancel', reason: mismatch };
  }

  /** Reads neither the merge request nor its issue: the event happened, and a trigger change is all that cancels it. */
  private checkMergeRequest(trigger: IMergeRequestTriggerConfig, task: Task): TaskCheck {
    const { event, targetBranch } = trigger.mergeRequest;

    if (event !== task.mergeRequestEvent) {
      const reason = `Trigger ${trigger.name} now starts on merge requests ${event}, not ${task.mergeRequestEvent ?? 'none'}`;

      return { kind: 'cancel', reason };
    }

    if (targetBranch !== undefined && targetBranch !== task.targetBranch) {
      return {
        kind: 'cancel',
        reason: `The trigger no longer applies to target branch ${task.targetBranch ?? 'none'}`,
      };
    }

    return { kind: 'start' };
  }
}
