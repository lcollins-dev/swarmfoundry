// The task domain types its columns in these, as the batch job domain does `BatchJobRunResult`.

export enum TaskStatus {
  QUEUED = 'queued',

  /** Holds one of its trigger's `concurrency` slots. */
  RUNNING = 'running',

  SUCCEEDED = 'succeeded',
  FAILED = 'failed',

  /** Ended without a run, since the issue no longer matched the trigger. */
  CANCELLED = 'cancelled',
}

/** The trigger's list a task's `step` and a run's index. */
export enum StepList {
  STEPS = 'steps',

  /** Run once the task has failed for good. */
  FAILURE_STEPS = 'failureSteps',
}

export enum RunOutcome {
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

/** How a run ended, stored when it is judged, so nothing reads it back from its error. */
export enum RunEndReason {
  SUCCESS = 'success',

  /** The step failed at its own work, such as the agent exiting non-zero or a missed `expect`. */
  ERROR = 'error',

  TIMEOUT = 'timeout',

  /** The run failed around the step, such as a deployment fault or a plugin that failed to load. */
  RUNNER_ERROR = 'runnerError',
}
