import { Injectable } from '@nestjs/common';

import type { Task } from '@/core/task/entities/task.entity';

import { StepExecutorService } from '@/core/actions/step-executor.service';
import { TaskService } from '@/core/task/task.service';

import type { IActionAgent } from '@/core/actions/types/actions.types';
import type { ITriggerConfig } from '@/core/foundry-config/types/foundry-config.types';
import { StepList } from '@/core/task/types/task.types';
import { stepsIn } from '@/core/task/utils/step-list.util';

/** The steps of one list of a trigger in the running config that resolve to one agent, or to none. */
export interface ILane {
  trigger: ITriggerConfig;
  list: StepList;
  steps: number[];
  agent: IActionAgent | null;
}

/** The order a dispatch pass starts queued tasks in. */
export function byArrival(left: Task, right: Task): number {
  const byDate = left.queuedDate.getTime() - right.queuedDate.getTime();

  return byDate === 0 ? left.id - right.id : byDate;
}

/** The cap that holds a lane back: its trigger's `concurrency` or its agent's. */
export interface ISlotLimit {
  on: 'trigger' | 'agent';
  name: string;
  inUse: number;
  limit: number;
}

/**
 * The free slots of every trigger and agent of the running config at one moment, which a dispatch pass takes from as
 * it picks tasks.
 */
export class QueueSlots {
  constructor(
    readonly lanes: readonly ILane[],
    private readonly triggerFree: Map<string, number>,
    private readonly agentFree: Map<string, number>
  ) {}

  /** The lane of the running config that holds the task's list and step, if any. */
  laneOf(task: Task): ILane | undefined {
    return this.lanes.find(
      lane => lane.trigger.name === task.triggerName && lane.list === task.list && lane.steps.includes(task.step)
    );
  }

  free(lane: ILane): number {
    return Math.min(this.triggerFreeOf(lane), this.agentFreeOf(lane));
  }

  take(lane: ILane): void {
    this.triggerFree.set(lane.trigger.name, this.triggerFreeOf(lane) - 1);

    if (lane.agent !== null) {
      this.agentFree.set(lane.agent.name, this.agentFreeOf(lane) - 1);
    }
  }

  /** The full cap that holds the lane back, the trigger's before the agent's. Null while both have a slot. */
  limitOf(lane: ILane): ISlotLimit | null {
    const { trigger, agent } = lane;

    if (this.triggerFreeOf(lane) <= 0) {
      const limit = trigger.concurrency;

      return { on: 'trigger', name: trigger.name, inUse: limit - this.triggerFreeOf(lane), limit };
    }

    if (agent?.concurrency !== undefined && this.agentFreeOf(lane) <= 0) {
      const limit = agent.concurrency;

      return { on: 'agent', name: agent.name, inUse: limit - this.agentFreeOf(lane), limit };
    }

    return null;
  }

  private triggerFreeOf({ trigger }: ILane): number {
    return this.triggerFree.get(trigger.name) ?? 0;
  }

  private agentFreeOf({ agent }: ILane): number {
    return agent === null ? Infinity : (this.agentFree.get(agent.name) ?? 0);
  }
}

/**
 * Counts the slots a dispatch pass may fill: each trigger's `concurrency` and each agent's, less the tasks running at
 * the steps that hold them. Shared with the queue's read side, so both apply the same rules.
 */
@Injectable()
export class QueueSlotsService {
  constructor(
    private readonly taskService: TaskService,
    private readonly stepExecutorService: StepExecutorService
  ) {}

  async read(triggers: readonly ITriggerConfig[]): Promise<QueueSlots> {
    const lanes = this.lanesOf(triggers);
    const [triggerRunning, laneRunning] = await Promise.all([
      Promise.all(triggers.map(trigger => this.taskService.countRunning(trigger.name))),
      Promise.all(lanes.map(lane => this.taskService.countRunning(lane.trigger.name, lane))),
    ]);

    const triggerFree = new Map(
      triggers.map((trigger, index) => [trigger.name, trigger.concurrency - triggerRunning[index]])
    );
    const agentFree = new Map<string, number>();

    for (const [index, { agent }] of lanes.entries()) {
      if (agent !== null) {
        agentFree.set(agent.name, (agentFree.get(agent.name) ?? agent.concurrency ?? Infinity) - laneRunning[index]);
      }
    }

    return new QueueSlots(lanes, triggerFree, agentFree);
  }

  private lanesOf(triggers: readonly ITriggerConfig[]): ILane[] {
    return triggers.flatMap(trigger =>
      [StepList.STEPS, StepList.FAILURE_STEPS].flatMap(list => {
        const byAgent = new Map<string | null, ILane>();

        for (const [index, step] of stepsIn(trigger, list).entries()) {
          const agent = this.stepExecutorService.agentOf(step);
          const lane = byAgent.get(agent?.name ?? null);

          if (lane === undefined) {
            byAgent.set(agent?.name ?? null, { trigger, list, steps: [index], agent });
          } else {
            lane.steps.push(index);
          }
        }

        return [...byAgent.values()];
      })
    );
  }
}
