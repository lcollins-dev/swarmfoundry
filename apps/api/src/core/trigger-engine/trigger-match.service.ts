import { Injectable, Logger } from '@nestjs/common';

import type { ITriggerMatch } from './trigger-engine.types';
import type {
  IIssueBlock,
  IIssueTriggerConfig,
  IMergeRequestBlock,
  IMergeRequestTriggerConfig,
  ITriggerConfig,
} from '@/core/foundry-config/foundry-config.types';
import type {
  IIssueChange,
  IIssueEvent,
  IIssueState,
  IMergeRequestEvent,
} from '@/core/issue-source/issue-source.types';

type IssueFields = Pick<IIssueState, 'labels' | 'assignees'>;

@Injectable()
export class TriggerMatchService {
  private readonly logger = new Logger(TriggerMatchService.name);

  match(event: IIssueEvent, triggers: readonly ITriggerConfig[]): ITriggerMatch[] {
    const matches: ITriggerMatch[] = [];

    for (const trigger of triggers) {
      if (
        trigger.issue === undefined ||
        trigger.source.name !== event.source ||
        !this.appliesTo(trigger, event.project.path) ||
        this.mismatch(event.issue, trigger) !== null
      ) {
        continue;
      }

      const change = this.dedupChange(event, trigger.issue);

      // As when the issue matched before the window and changed in another way since.
      if (change === null) {
        this.logger.debug(
          { trigger: trigger.name, project: event.project.path, issue: event.issue.iid },
          'match(): The issue matches but no change inside the window made it match, so no task is queued'
        );

        continue;
      }

      matches.push({ trigger, change });
    }

    return matches;
  }

  matchMergeRequest(event: IMergeRequestEvent, triggers: readonly ITriggerConfig[]): IMergeRequestTriggerConfig[] {
    return triggers.filter(
      (trigger): trigger is IMergeRequestTriggerConfig =>
        trigger.mergeRequest !== undefined &&
        trigger.source.name === event.source &&
        this.appliesTo(trigger, event.project.path) &&
        this.matchesMergeRequest(event, trigger.mergeRequest)
    );
  }

  /** Compares paths regardless of case, as GitLab does. */
  appliesTo(trigger: ITriggerConfig, projectPath: string): boolean {
    const path = projectPath.toLowerCase();

    if (trigger.schedule !== undefined) {
      return trigger.schedule.project.toLowerCase() === path;
    }

    const projects = trigger.issue?.projects ?? trigger.mergeRequest?.projects ?? [];

    return projects.length === 0 || projects.some(project => project.toLowerCase() === path);
  }

  /** Null when the issue matches. Compares usernames regardless of case, as GitLab does. */
  mismatch(issue: IssueFields, trigger: IIssueTriggerConfig): string | null {
    const { labels, notLabels, anyAssignee } = trigger.issue;

    const { missing, blocking } = this.labelMismatch(issue.labels, labels, notLabels);

    const assigned = new Set(issue.assignees.map(username => username.toLowerCase()));
    const isAssigned = anyAssignee.length === 0 || anyAssignee.some(username => assigned.has(username.toLowerCase()));

    const reasons = [
      ...(missing.length > 0 ? [`lacks ${missing.join(', ')}`] : []),
      ...(blocking.length > 0 ? [`carries ${blocking.join(', ')}`] : []),
      ...(isAssigned ? [] : [`is not assigned to ${anyAssignee.join(' or ')}`]),
    ];

    return reasons.length === 0 ? null : `The issue ${reasons.join(' and ')}`;
  }

  private matchesMergeRequest(event: IMergeRequestEvent, block: IMergeRequestBlock): boolean {
    const { missing, blocking } = this.labelMismatch(event.mergeRequest.labels, block.labels, block.notLabels);
    const { targetBranch } = event.mergeRequest;

    return (
      block.event === event.event &&
      (block.targetBranch === undefined || block.targetBranch === targetBranch) &&
      missing.length === 0 &&
      blocking.length === 0
    );
  }

  /** The `labels` not carried, and the `notLabels` carried. */
  private labelMismatch(carriedLabels: readonly string[], labels: readonly string[], notLabels: readonly string[]) {
    const carried = new Set(carriedLabels);

    return {
      missing: labels.filter(label => !carried.has(label)),
      blocking: notLabels.filter(label => carried.has(label)),
    };
  }

  /**
   * The latest add among `labels`, remove among `notLabels` or assignment of an `anyAssignee` user, so whichever made
   * the issue match keys the task. Compares usernames regardless of case.
   */
  private dedupChange(
    event: IIssueEvent,
    { labels, notLabels, anyAssignee }: Pick<IIssueBlock, 'labels' | 'notLabels' | 'anyAssignee'>
  ): IIssueChange | null {
    const assignees = new Set(anyAssignee.map(username => username.toLowerCase()));

    const changes: IIssueChange[] = [
      ...event.labelEvents
        .filter(({ action, label }) => (action === 'add' ? labels.includes(label) : notLabels.includes(label)))
        .map(({ id, createdAt, actor }): IIssueChange => ({ kind: 'label', id, createdAt, actor })),
      ...event.assignments
        .filter(({ usernames }) => usernames.some(username => assignees.has(username.toLowerCase())))
        .map(({ id, createdAt, actor }): IIssueChange => ({ kind: 'assignment', id, createdAt, actor })),
    ];

    let latest: IIssueChange | null = null;

    for (const change of changes) {
      if (latest === null || this.isLater(change, latest)) {
        latest = change;
      }
    }

    return latest;
  }

  /**
   * By time, then kind, then id, as `TaskService.findNewer` orders them. GitLab can stamp two changes in one request
   * with the same time, and numbers label events and notes apart.
   */
  private isLater(candidate: IIssueChange, current: IIssueChange): boolean {
    const difference = candidate.createdAt.getTime() - current.createdAt.getTime();

    if (difference !== 0) {
      return difference > 0;
    }

    return candidate.kind === current.kind ? candidate.id > current.id : candidate.kind > current.kind;
  }
}
