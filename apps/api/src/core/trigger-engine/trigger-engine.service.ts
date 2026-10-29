import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { TaskQueueService } from './task-queue.service';
import { TaskRecoveryService } from './task-recovery.service';
import { TriggerMatchService } from './trigger-match.service';
import { TriggerScheduleService } from './trigger-schedule.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { IssueSourceService } from '@/core/issue-source/issue-source.service';
import { TaskService } from '@/core/task/task.service';

import type { IIssueEvent, IMergeRequestEvent, ISourceEvent } from '@/core/issue-source/issue-source.types';

@Injectable()
export class TriggerEngineService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(TriggerEngineService.name);

  private stopSource: (() => Promise<void>) | null = null;
  private stopFollowingSwaps: (() => void) | null = null;

  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly issueSourceService: IssueSourceService,
    private readonly triggerMatchService: TriggerMatchService,
    private readonly taskService: TaskService,
    private readonly taskQueueService: TaskQueueService,
    private readonly taskRecoveryService: TaskRecoveryService,
    private readonly triggerScheduleService: TriggerScheduleService
  ) {}

  /**
   * Recovers the tasks a restart left running, then starts those it left queued, since no new event may prompt it. The
   * pass is not awaited, so its issue reads never hold up the app's startup.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.taskRecoveryService.recover();
    void this.taskQueueService.requestDispatch();

    this.stopSource = this.issueSourceService.start(event => this.handleEvent(event));
    void this.triggerScheduleService.requestTick();

    // A swap can free slots or add triggers, and no new event may come to prompt a pass.
    this.stopFollowingSwaps = this.foundryConfigService.onSwap(() => {
      void this.taskQueueService.requestDispatch();
      void this.triggerScheduleService.requestTick();
    });
  }

  /** Stops the source and the schedule first, so nothing enqueues into a stopped queue. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopFollowingSwaps?.();
    await this.triggerScheduleService.stop();
    await this.stopSource?.();
    await this.taskQueueService.stop();
  }

  /** Never waits for a task to run. */
  async handleEvent(event: ISourceEvent): Promise<void> {
    if ('mergeRequest' in event) {
      await this.handleMergeRequestEvent(event);
    } else {
      await this.handleIssueEvent(event);
    }
  }

  private async handleIssueEvent(event: IIssueEvent): Promise<void> {
    const matches = this.triggerMatchService.match(event, this.foundryConfigService.triggers);

    for (const { trigger, change } of matches) {
      const task = await this.taskService.enqueue(trigger.name, event, change);

      if (task === null) {
        continue;
      }

      this.logger.log(
        {
          taskId: task.id,
          trigger: trigger.name,
          project: event.project.path,
          issue: event.issue.iid,
          change: change.kind,
          changeId: change.id,
          actor: change.actor,
        },
        `handleIssueEvent(): Queued task ${task.id}`
      );
    }

    // Also when every task already existed, so a dispatch lost to a failure or a restart is retried.
    if (matches.length > 0) {
      void this.taskQueueService.requestDispatch();
    }
  }

  private async handleMergeRequestEvent(event: IMergeRequestEvent): Promise<void> {
    const triggers = this.triggerMatchService.matchMergeRequest(event, this.foundryConfigService.triggers);

    for (const trigger of triggers) {
      const task = await this.taskService.enqueueMergeRequest(trigger.name, event);

      if (task === null) {
        continue;
      }

      this.logger.log(
        {
          taskId: task.id,
          trigger: trigger.name,
          project: event.project.path,
          mergeRequest: event.mergeRequest.iid,
          event: event.event,
          issue: event.relatedIssue?.iid ?? null,
        },
        `handleMergeRequestEvent(): Queued task ${task.id}`
      );
    }

    if (triggers.length > 0) {
      void this.taskQueueService.requestDispatch();
    }
  }
}
