import { Injectable, Logger } from '@nestjs/common';

import { TaskQueueService } from './task-queue.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { TaskService } from '@/core/task/task.service';

import { fireTimeAfter, fireTimeAtOrBefore } from '@/core/foundry-config/cron-schedule';
import type { IScheduleTriggerConfig } from '@/core/foundry-config/foundry-config.types';
import { TaskStatus } from '@/core/task/task.types';

/** The longest a fire time skipped for a busy trigger waits once the trigger's last task ends. */
export const SCHEDULE_TICK_MS = 30_000;

const UNFINISHED: readonly TaskStatus[] = [TaskStatus.QUEUED, TaskStatus.RUNNING];

/**
 * Queues one task per fire time of each scheduled trigger. Holds no schedule in memory beyond when it first saw each
 * trigger's cron: what has fired is read from Postgres on every tick, so a restart rebuilds it by reading.
 */
@Injectable()
export class TriggerScheduleService {
  private readonly logger = new Logger(TriggerScheduleService.name);

  private readonly controller = new AbortController();

  /**
   * By trigger name and cron. A fire time before this was never missed, so a trigger new to this process, or whose cron
   * changed, waits for its next one unless its latest task fired on this cron.
   */
  private readonly firstSeen = new Map<string, number>();

  private ticking: Promise<void> | null = null;
  private tickRequests = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly taskService: TaskService,
    private readonly taskQueueService: TaskQueueService
  ) {}

  /** Never rejects. A call during a tick makes that tick run once more. */
  requestTick(): Promise<void> {
    this.tickRequests++;

    if (this.ticking !== null) {
      return this.ticking;
    }

    this.ticking = this.tickUntilSettled().finally(() => {
      this.ticking = null;
    });

    return this.ticking;
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.clearTimer();

    await this.ticking;
  }

  private async tickUntilSettled(): Promise<void> {
    let handledRequests = 0;

    while (handledRequests !== this.tickRequests && !this.isStopping()) {
      handledRequests = this.tickRequests;

      try {
        await this.tick();
      } catch (error) {
        this.logger.error({ error }, 'tickUntilSettled(): Failed to run the schedule, trying again later');
        this.wakeIn(SCHEDULE_TICK_MS);
      }
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const triggers = this.foundryConfigService.triggers.filter(trigger => trigger.schedule !== undefined);

    this.forgetRemoved(triggers);

    let queued = false;

    for (const trigger of triggers) {
      if (this.isStopping()) {
        return;
      }

      try {
        queued = (await this.queueDue(trigger, now)) || queued;
      } catch (error) {
        this.logger.error({ trigger: trigger.name, error }, 'tick(): Failed to queue the scheduled trigger');
      }
    }

    if (queued) {
      void this.taskQueueService.requestDispatch();
    }

    this.scheduleNextTick(triggers, now);
  }

  /** After downtime only the latest fire time missed queues, and none while the trigger's last task is unfinished. */
  private async queueDue(trigger: IScheduleTriggerConfig, now: Date): Promise<boolean> {
    const { cron, project } = trigger.schedule;
    const key = this.keyOf(trigger.name, cron);
    const firstSeen = this.firstSeen.get(key) ?? now.getTime();
    this.firstSeen.set(key, firstSeen);

    const fireTime = fireTimeAtOrBefore(cron, now);
    const latest = await this.taskService.findLatestScheduled(trigger.name);
    const latestFireTime = latest?.fireTime ?? null;

    if (latest !== null && (UNFINISHED.includes(latest.status) || (latestFireTime ?? 0) >= fireTime)) {
      return false;
    }

    // A latest task queued by this same cron means the gap since is downtime, whose latest fire time was missed.
    const caughtUp = latest?.cron === cron;

    if (!caughtUp && fireTime.getTime() < firstSeen) {
      return false;
    }

    const task = await this.taskService.enqueueScheduled({
      triggerName: trigger.name,
      sourceName: trigger.source.name,
      projectPath: project,
      projectUrl: `${trigger.source.url.replace(/\/+$/, '')}/${project}`,
      fireTime,
      cron,
    });

    if (task === null) {
      return false;
    }

    this.logger.log(
      { taskId: task.id, trigger: trigger.name, project, fireTime },
      `queueDue(): Queued task ${task.id} for ${fireTime.toISOString()}`
    );

    return true;
  }

  private forgetRemoved(triggers: readonly IScheduleTriggerConfig[]): void {
    const keys = new Set(triggers.map(trigger => this.keyOf(trigger.name, trigger.schedule.cron)));

    for (const key of this.firstSeen.keys()) {
      if (!keys.has(key)) {
        this.firstSeen.delete(key);
      }
    }
  }

  private keyOf(triggerName: string, cron: string): string {
    return `${triggerName}\n${cron}`;
  }

  private scheduleNextTick(triggers: readonly IScheduleTriggerConfig[], now: Date): void {
    if (triggers.length === 0) {
      this.clearTimer();

      return;
    }

    let nextFireTime = Infinity;

    for (const { schedule } of triggers) {
      nextFireTime = Math.min(nextFireTime, fireTimeAfter(schedule.cron, now).getTime());
    }

    this.wakeIn(Math.min(SCHEDULE_TICK_MS, Math.max(0, nextFireTime - Date.now())));
  }

  private wakeIn(delayMs: number): void {
    this.clearTimer();

    if (this.isStopping()) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.requestTick();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private isStopping(): boolean {
    return this.controller.signal.aborted;
  }
}
