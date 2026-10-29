import type { Run } from '@/core/task/entities/run.entity';
import type { Task } from '@/core/task/entities/task.entity';

import type {
  IAgentStepConfig,
  IFailureContext,
  IStepConfig,
  ITriggerConfig,
} from '@/core/foundry-config/foundry-config.types';
import type { IRunAgent, IRunJudgement, IRunReport } from '@/core/task/task.types';

export interface IStepRequest<TStep extends IStepConfig = IStepConfig> {
  trigger: ITriggerConfig;
  step: TStep;
  task: Task;
  run: Run;

  /** Set for a step of `failureSteps` alone. */
  failure?: IFailureContext;

  /**
   * Aborts on shutdown, and may already be aborted on arrival: check `signal.aborted` as well as listening for `abort`.
   * Then stop following the sandbox and settle promptly. The engine records nothing after it.
   */
  signal: AbortSignal;
}

export type IAgentRunRequest = IStepRequest<IAgentStepConfig>;

/** What the failure report says a failed run left: a message it quotes under a `heading` section, or a plain note. */
export type IFailureMessage = { heading: string; text: string } | { note: string };

export interface IActionAgent extends IRunAgent {
  concurrency?: number;
}

/** One action kind. The queue, retries, recovery and the caps reach a step only through its handler. */
export interface IActionHandler<TStep extends IStepConfig> {
  /** False while the step cannot run, such as with no agent runner bound. Nothing then starts or recovers. */
  isReady(): boolean;

  /** Null for a step that runs no agent. */
  agentOf(step: TStep): IActionAgent | null;

  /** Settles once the run has ended, resolving for a failed run too. A rejection is an infrastructure failure. */
  run(request: IStepRequest<TStep>): Promise<IRunReport>;

  /** Picks up a run a restart cut off. Settles as `run` does. */
  resume(request: IStepRequest<TStep>): Promise<IRunReport>;

  judge(step: TStep, report: IRunReport): IRunJudgement;

  /** Masked in what reaches an issue, beside the secrets the config holds. */
  secretsOf(step: TStep): string[];

  /** Unredacted. Null when the run's error says all there is. Never rejects. */
  failureMessage(step: TStep, run: Run): Promise<IFailureMessage | null>;

  /** Removes whatever runs left behind that are not in `runIds`, before recovery resumes those. Never rejects. */
  removeLeftoversExcept(runIds: ReadonlySet<number>): Promise<void>;
}

export interface IAgentRunner {
  /** Settles once the run has ended, resolving for a failed run too. A rejection is an infrastructure failure. */
  run(request: IAgentRunRequest): Promise<IRunReport>;

  /**
   * Picks up a run a restart cut off, by its sandbox's labels: reports a vanished agent as failed, and follows a live
   * one to its end within what remains of its timeout. Settles as `run` does.
   */
  resume(request: IAgentRunRequest): Promise<IRunReport>;

  /** Removes every sandbox of the namespace whose run is not in `runIds`. Never rejects. */
  removeSandboxesExcept(runIds: ReadonlySet<number>): Promise<void>;
}

/** Optional: with nothing bound, the queue starts no task. */
export const AGENT_RUNNER = Symbol('AGENT_RUNNER');
