import { RunEndReason, RunOutcome, type IRunJudgement } from './task.types';

/**
 * A failure is the runner's when it said so or the judgement found a deployment fault, and otherwise the step's own.
 * `reported` is the runner's view, stored with the report.
 */
export function runEndReasonOf(judgement: IRunJudgement, reported: RunEndReason | null): RunEndReason {
  if (judgement.outcome === RunOutcome.SUCCEEDED) {
    return RunEndReason.SUCCESS;
  }

  if (reported !== null) {
    return reported;
  }

  if (judgement.endReason !== undefined) {
    return judgement.endReason;
  }

  return judgement.deploymentFault === null ? RunEndReason.ERROR : RunEndReason.RUNNER_ERROR;
}
