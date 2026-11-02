import { Injectable } from '@nestjs/common';

import type {
  QueueResponseDto,
  SourceDto,
  SourceListResponseDto,
  TriggerDto,
  TriggerListResponseDto,
  TriggerStepDto,
} from '@libs/dto';

import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { IssueSourceService } from '@/core/issue-source/issue-source.service';
import { NO_ACTIVITY, TaskReadService, type ITriggerActivity } from '@/core/task/task-read.service';
import { QueueStatusService } from '@/core/trigger-engine/queue-status.service';

import { toListTaskDto } from '../task/utils/list-task.util';
import type {
  IIssueBlock,
  IMergeRequestBlock,
  IStepConfig,
  ITriggerConfig,
} from '@/core/foundry-config/types/foundry-config.types';
import { triggerKindOf } from '@/core/foundry-config/utils/trigger-kind.util';
import type { ISourcePollStatus } from '@/core/issue-source/types/issue-source.types';

export const STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class TriggerAdminService {
  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly issueSourceService: IssueSourceService,
    private readonly taskReadService: TaskReadService,
    private readonly queueStatusService: QueueStatusService
  ) {}

  async getTriggerList(): Promise<TriggerListResponseDto> {
    // Read both before the await, so they come from one revision.
    const triggers = this.foundryConfigService.triggers;
    const configSha = this.foundryConfigService.revision;
    const activity = await this.taskReadService.findTriggerActivity(
      triggers.map(trigger => trigger.name),
      new Date(Date.now() - STATS_WINDOW_MS)
    );

    return {
      triggerList: triggers.map(trigger => this.toTrigger(trigger, activity.get(trigger.name) ?? NO_ACTIVITY)),
      configSha,
    };
  }

  async getQueue(): Promise<QueueResponseDto> {
    const queued = await this.queueStatusService.findQueued();

    return { queue: queued.map(({ summary, wait }) => ({ ...toListTaskDto(summary), wait })) };
  }

  getSourceList(): SourceListResponseDto {
    return { sourceList: this.issueSourceService.pollStatus().map(status => this.toSource(status)) };
  }

  private toTrigger(trigger: ITriggerConfig, activity: ITriggerActivity): TriggerDto {
    const { issue, schedule, mergeRequest } = trigger.written;

    return {
      name: trigger.name,
      kind: triggerKindOf(trigger),
      sourceName: trigger.source.name,
      issue: issue === undefined ? null : this.toIssue(issue),
      schedule:
        schedule === undefined ? null : { cron: this.mask(schedule.cron), project: this.mask(schedule.project) },
      mergeRequest: mergeRequest === undefined ? null : this.toMergeRequest(mergeRequest),
      steps: trigger.steps.map(step => this.toStep(step)),
      failureSteps: trigger.failureSteps.map(step => this.toStep(step)),
      concurrency: trigger.concurrency,
      runningCount: activity.runningCount,
      queuedCount: activity.queuedCount,
      lastFiredDate: activity.lastFiredDate,
      stats: activity.stats,
    };
  }

  private toIssue(issue: IIssueBlock): TriggerDto['issue'] {
    return {
      labels: this.maskList(issue.labels),
      notLabels: this.maskList(issue.notLabels),
      anyAssignee: this.maskList(issue.anyAssignee),
      projects: this.maskList(issue.projects),
      expect: { anyLabel: this.maskList(issue.expect.anyLabel) },
    };
  }

  private toMergeRequest(mergeRequest: IMergeRequestBlock): TriggerDto['mergeRequest'] {
    const { event, targetBranch } = mergeRequest;

    return {
      event,
      targetBranch: targetBranch === undefined ? null : this.mask(targetBranch),
      labels: this.maskList(mergeRequest.labels),
      notLabels: this.maskList(mergeRequest.notLabels),
      projects: this.maskList(mergeRequest.projects),
    };
  }

  private toStep(step: IStepConfig): TriggerStepDto {
    switch (step.kind) {
      case 'agent': {
        const { name, auth, concurrency } = step.agent;
        const { model, prompt, systemPrompt } = step.written;

        return {
          kind: 'agent',
          environment: step.environment.name,
          agent: { name, model: this.mask(model), auth, concurrency: concurrency ?? null },
          prompt: this.mask(prompt),
          systemPrompt: systemPrompt === undefined ? null : this.mask(systemPrompt),
          timeoutMs: step.timeout,
        };
      }

      case 'comment':
        return { kind: 'comment', body: this.mask(step.written.body) };

      case 'relabel':
        return { kind: 'relabel', add: this.maskList(step.written.add), remove: this.maskList(step.written.remove) };

      case 'assign':
        return { kind: 'assign', usernames: this.maskList(step.written.usernames) };
    }
  }

  private toSource({ source, lastPoll, nextPollDate }: ISourcePollStatus): SourceDto {
    return {
      name: source.name,
      type: source.type,
      url: this.mask(source.written.url),
      projects: this.maskList(source.projects),
      pollIntervalMs: source.pollInterval,
      lastPoll:
        lastPoll === null
          ? null
          : { ...lastPoll, succeeded: lastPoll.error === null && lastPoll.failedProjects.length === 0 },
      nextPollDate,
    };
  }

  /** Text as the config writes it can still hold a credential written inline, as in a comment or a URL. */
  private mask(text: string): string {
    return this.foundryConfigService.maskWritten(text);
  }

  private maskList(texts: readonly string[]): string[] {
    return texts.map(text => this.mask(text));
  }
}
