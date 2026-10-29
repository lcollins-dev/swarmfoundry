import { RunEndReason, RunOutcome, StepList, TaskStatus } from '@libs/dto';

import type { Run } from './entities/run.entity';
import type { Task } from './entities/task.entity';

import type { IResolvedAgent, MergeRequestEventKind } from '@/core/foundry-config/foundry-config.types';

/** Defined in `@libs/dto`, which the read API answers in. */
export { RunEndReason, RunOutcome, StepList, TaskStatus };

/** A failure of the deployment rather than of the agent's work, which ends the task without its `failureSteps`. */
export enum DeploymentFault {
  /** Retries its step, such as a Docker error or a Claude API 429 or 5xx. */
  TRANSIENT = 'transient',

  /** No retry fixes it, such as a missing variable or a refused token. */
  PERMANENT = 'permanent',
}

/** The agent a run ran, as its step resolved it when the run started. */
export interface IRunAgent {
  name: string;
  model: string;
  auth: IResolvedAgent['auth'];
}

/** Copied from an agent's `result` line. A field the line lacks is null. */
export interface IRunUsage {
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

export interface IRunReport {
  /** Null when the agent never exited on its own, such as a timeout. */
  exitCode: number | null;

  /** An agent step's stream-json `result` line as written, or what a static step did. */
  result: string | null;

  /** A failure outside the agent, such as Docker's. */
  error: string | null;

  deploymentFault?: DeploymentFault;

  /** Set by a runner that knows a failed run ended on a timeout or on its own error. The judgement decides otherwise. */
  endReason?: RunEndReason.TIMEOUT | RunEndReason.RUNNER_ERROR;

  /** An agent step's, from its `result` line. */
  usage?: IRunUsage;

  /** The agent never started, as when a restart came first, so the run does not count as one. */
  neverStarted?: boolean;
}

export interface IRunJudgement {
  outcome: RunOutcome;
  error: string | null;

  /** Null for a success or a failure of the agent's work. */
  deploymentFault: DeploymentFault | null;

  /** Set where the engine failed the run, not its step, such as when the issue could not be read to judge it. */
  endReason?: RunEndReason.RUNNER_ERROR;
}

/** A queued task runs `step` of `list` next. */
export type TaskNext =
  | { status: TaskStatus.SUCCEEDED | TaskStatus.FAILED }
  | { status: TaskStatus.QUEUED; list: StepList; step: number; notBeforeDate: Date | null };

export interface IRunningTask {
  task: Task;

  /** The run of the task's current step. Null only when the claim lost its run, which `startRun` rules out. */
  run: Run | null;
}

export interface IScheduledTaskFields {
  triggerName: string;
  sourceName: string;
  projectPath: string;
  projectUrl: string;
  fireTime: Date;
  cron: string;
}

export interface ITaskMergeRequest {
  iid: number;
  event: MergeRequestEventKind;
  title: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
}
