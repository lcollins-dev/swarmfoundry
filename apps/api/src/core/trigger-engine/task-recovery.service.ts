import { Injectable, Logger } from '@nestjs/common';

import { TaskQueueService } from './task-queue.service';
import { StepExecutorService } from '@/core/actions/step-executor.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { TaskService } from '@/core/task/task.service';

import { stepsIn } from '@/core/task/step-list';

@Injectable()
export class TaskRecoveryService {
  private readonly logger = new Logger(TaskRecoveryService.name);

  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly taskService: TaskService,
    private readonly taskQueueService: TaskQueueService,
    private readonly stepExecutorService: StepExecutorService
  ) {}

  /**
   * Call before the first dispatch pass. Loads every revision an unfinished task is pinned to, removes every sandbox no
   * running task owns, then hands the run of each running task's current step to the queue to resume or judge, without
   * waiting for it. Never rejects.
   */
  async recover(): Promise<void> {
    // An orchestrator started without its config must not fail every running task and remove every sandbox.
    if (!this.stepExecutorService.isReady() || this.foundryConfigService.triggers.length === 0) {
      return;
    }

    try {
      await this.loadPinnedRevisions();

      const running = await this.taskService.findRunning();

      // A run whose report was stored has had its sandbox removed, and one whose step is gone is failed unfollowed.
      const followed = new Set(
        running.flatMap(({ task, run }) => {
          const trigger = this.foundryConfigService.triggerAt(task.configId, task.triggerName);

          return run !== null &&
            run.endDate === null &&
            trigger !== undefined &&
            stepsIn(trigger, run.list).at(run.step) !== undefined
            ? [run.id]
            : [];
        })
      );

      await this.stepExecutorService.removeLeftoversExcept(followed);

      for (const { task, run } of running) {
        if (run === null) {
          await this.taskService.release(task);

          this.logger.warn(
            { taskId: task.id },
            `recover(): Task ${task.id} was running without a run, so it is queued`
          );

          continue;
        }

        this.taskQueueService.resumeRun(task, run);
      }

      if (running.length > 0) {
        this.logger.log({ tasks: running.map(({ task }) => task.id) }, 'recover(): Picked up the tasks left running');
      }
    } catch (error) {
      this.logger.error({ error }, 'recover(): Failed to recover the tasks left running');
    }
  }

  private async loadPinnedRevisions(): Promise<void> {
    for (const configId of await this.taskService.findPinnedConfigIds()) {
      if (!(await this.foundryConfigService.loadRevision(configId))) {
        this.logger.warn({ configId }, `loadPinnedRevisions(): Pinned config revision ${configId} does not load`);
      }
    }
  }
}
