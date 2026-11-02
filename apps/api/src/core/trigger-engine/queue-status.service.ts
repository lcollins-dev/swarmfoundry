import { Injectable } from '@nestjs/common';

import type { Task } from '@/core/task/entities/task.entity';

import { QueueSlotsService, type ISlotLimit, type QueueSlots } from './queue-slots.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { TaskReadService, type ITaskSummary } from '@/core/task/task-read.service';

/** Why a queued task has not started. */
export type QueueWait =
  | ({ reason: 'noFreeSlot' } & ISlotLimit)
  | { reason: 'heldBack'; until: Date }

  /** The next dispatch pass starts it. */
  | { reason: 'ready' }

  /** Its trigger, or the step it waits at, is not in the running config, so no pass picks it. */
  | { reason: 'notInConfig' };

export interface IQueuedTask {
  summary: ITaskSummary;
  wait: QueueWait;
}

/** Explains the queue by the rules a dispatch pass picks by, so the two cannot disagree. */
@Injectable()
export class QueueStatusService {
  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly taskReadService: TaskReadService,
    private readonly queueSlotsService: QueueSlotsService
  ) {}

  /** Every queued task in arrival order. A task ahead that is ready takes its slot from those behind it. */
  async findQueued(now = new Date()): Promise<IQueuedTask[]> {
    const [summaries, slots] = await Promise.all([
      this.taskReadService.findQueued(),
      this.queueSlotsService.read(this.foundryConfigService.triggers),
    ]);

    return summaries.map(summary => ({ summary, wait: this.waitOf(summary.task, slots, now) }));
  }

  private waitOf(task: Task, slots: QueueSlots, now: Date): QueueWait {
    const lane = slots.laneOf(task);

    if (lane === undefined) {
      return { reason: 'notInConfig' };
    }

    if (task.notBeforeDate !== null && task.notBeforeDate > now) {
      return { reason: 'heldBack', until: task.notBeforeDate };
    }

    const limit = slots.limitOf(lane);

    if (limit !== null) {
      return { reason: 'noFreeSlot', ...limit };
    }

    slots.take(lane);

    return { reason: 'ready' };
  }
}
