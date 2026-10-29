import { Injectable } from '@nestjs/common';

import type { Run } from '@/core/task/entities/run.entity';

import { ActionRegistryService } from './action-registry.service';

import type { IActionAgent, IFailureMessage, IStepRequest } from './actions.types';
import type { IStepConfig } from '@/core/foundry-config/foundry-config.types';
import { RunEndReason, RunOutcome, type IRunJudgement, type IRunReport } from '@/core/task/task.types';

export type StepAfter = { kind: 'next'; index: number } | { kind: 'end'; judgement: IRunJudgement };

/**
 * Runs any list of steps for a task, such as a trigger's `steps`, one run per step in order. Reaches each step through
 * the handler its kind registered, so a new kind changes nothing that calls this.
 */
@Injectable()
export class StepExecutorService {
  constructor(private readonly actionRegistryService: ActionRegistryService) {}

  /** False while any handler cannot run its steps. Nothing then starts or recovers. */
  isReady(): boolean {
    return this.actionRegistryService.all().every(handler => handler.isReady());
  }

  agentOf(step: IStepConfig): IActionAgent | null {
    return this.actionRegistryService.handlerOf(step).agentOf(step);
  }

  run(request: IStepRequest): Promise<IRunReport> {
    return this.actionRegistryService.handlerOf(request.step).run(request);
  }

  resume(request: IStepRequest): Promise<IRunReport> {
    return this.actionRegistryService.handlerOf(request.step).resume(request);
  }

  /** What follows step `index` of `steps` once its run is judged: the next step, or the end of the list. */
  after(steps: readonly IStepConfig[], index: number, report: IRunReport): StepAfter {
    const step = steps.at(index);
    const judgement: IRunJudgement =
      step === undefined
        ? {
            outcome: RunOutcome.FAILED,
            error: `Step ${index} is no longer in the config`,
            deploymentFault: null,
            endReason: RunEndReason.RUNNER_ERROR,
          }
        : this.actionRegistryService.handlerOf(step).judge(step, report);

    return judgement.outcome === RunOutcome.SUCCEEDED && index + 1 < steps.length
      ? { kind: 'next', index: index + 1 }
      : { kind: 'end', judgement };
  }

  secretsOf(steps: readonly IStepConfig[]): string[] {
    return steps.flatMap(step => this.actionRegistryService.handlerOf(step).secretsOf(step));
  }

  failureMessage(step: IStepConfig, run: Run): Promise<IFailureMessage | null> {
    return this.actionRegistryService.handlerOf(step).failureMessage(step, run);
  }

  async removeLeftoversExcept(runIds: ReadonlySet<number>): Promise<void> {
    await Promise.all(this.actionRegistryService.all().map(handler => handler.removeLeftoversExcept(runIds)));
  }
}
