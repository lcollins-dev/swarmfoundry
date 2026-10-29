import { StepList } from './task.types';
import type { IStepConfig, ITriggerConfig } from '@/core/foundry-config/foundry-config.types';

export function stepsIn(trigger: ITriggerConfig, list: StepList): readonly IStepConfig[] {
  return list === StepList.STEPS ? trigger.steps : trigger.failureSteps;
}
