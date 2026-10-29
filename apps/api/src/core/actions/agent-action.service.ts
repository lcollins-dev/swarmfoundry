import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';

import type { Run } from '@/core/task/entities/run.entity';

import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { TaskService } from '@/core/task/task.service';

import {
  AGENT_RUNNER,
  type IActionAgent,
  type IActionHandler,
  type IAgentRunner,
  type IAgentRunRequest,
  type IFailureMessage,
} from './actions.types';
import { assistantMessageSchema } from './schema/assistant-message';
import { parseJsonLine } from './schema/json-line';
import { runResultSchema } from './schema/run-result';
import type { IAgentStepConfig } from '@/core/foundry-config/foundry-config.types';
import { DeploymentFault, RunOutcome, type IRunJudgement, type IRunReport } from '@/core/task/task.types';

const RESULT_DETAIL_MAX_LENGTH = 500;

/** The final message is looked for only this far back among the run's assistant lines. */
export const ASSISTANT_LINES_READ = 20;

const NO_RUNNER_ERROR = 'No agent runner is installed';

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;

interface IApiError {
  error: string;
  deploymentFault: DeploymentFault | null;
}

@Injectable()
export class AgentActionService implements IActionHandler<IAgentStepConfig>, OnModuleInit {
  private readonly logger = new Logger(AgentActionService.name);

  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly taskService: TaskService,
    @Optional() @Inject(AGENT_RUNNER) private readonly runner?: IAgentRunner
  ) {}

  onModuleInit(): void {
    if (this.runner === undefined) {
      this.logger.warn('onModuleInit(): No agent runner is installed, so queued tasks stay queued');
    }
  }

  isReady(): boolean {
    return this.runner !== undefined;
  }

  agentOf(step: IAgentStepConfig): IActionAgent {
    const { name, model, auth, concurrency } = step.agent;

    return { name, model, auth, concurrency };
  }

  run(request: IAgentRunRequest): Promise<IRunReport> {
    return this.runner?.run(request) ?? Promise.reject(new Error(NO_RUNNER_ERROR));
  }

  resume(request: IAgentRunRequest): Promise<IRunReport> {
    return this.runner?.resume(request) ?? Promise.reject(new Error(NO_RUNNER_ERROR));
  }

  /**
   * Passes a run whose agent exited 0 with a `result` line reading success. A failure the runner flagged, or Claude
   * ending on a 429, a 5xx or no response at all, is a transient deployment fault, and on a 401 or 403 a permanent one.
   */
  judge(_step: IAgentStepConfig, report: IRunReport): IRunJudgement {
    // A stopped agent, such as one that timed out, may end its turn on the aborted request.
    const apiError = report.exitCode === null ? null : this.apiError(report.result);

    if (apiError !== null) {
      return { outcome: RunOutcome.FAILED, error: apiError.error, deploymentFault: apiError.deploymentFault };
    }

    const failure = this.reportFailure(report);

    return failure === null
      ? { outcome: RunOutcome.SUCCEEDED, error: null, deploymentFault: null }
      : { outcome: RunOutcome.FAILED, error: failure, deploymentFault: report.deploymentFault ?? null };
  }

  secretsOf(step: IAgentStepConfig): string[] {
    return [step.agent.token];
  }

  removeLeftoversExcept(runIds: ReadonlySet<number>): Promise<void> {
    return this.runner?.removeSandboxesExcept(runIds) ?? Promise.resolve();
  }

  /** A run with no container was refused before its agent existed, so it has no message to look for. */
  async failureMessage(_step: IAgentStepConfig, run: Run): Promise<IFailureMessage> {
    if (run.containerId === null) {
      return { note: 'The agent never started.' };
    }

    const message = await this.finalMessage(run);

    return message === null
      ? { note: 'The agent left no final message.' }
      : { heading: 'Final message', text: message };
  }

  /** The `result` text, else the main agent's last text. Null when there is neither or the lines could not be read. */
  private async finalMessage(run: Run): Promise<string | null> {
    const result = runResultSchema.safeParse(parseJsonLine(run.result));
    const resultText = result.success ? result.data.result?.trim() : undefined;

    if (resultText !== undefined && resultText !== '') {
      return resultText;
    }

    let lines: string[];

    try {
      lines = await this.taskService.findAssistantLines(run.id, ASSISTANT_LINES_READ);
    } catch (readError) {
      const message = readError instanceof Error ? readError.message : String(readError);

      this.logger.error(
        { taskId: run.taskId, runId: run.id, error: this.foundryConfigService.redactText(message) },
        "finalMessage(): Failed to read the agent's last messages, so the failure report goes without one"
      );

      return null;
    }

    for (const line of lines) {
      const text = this.assistantText(line);

      if (text !== '') {
        return text;
      }
    }

    return null;
  }

  /** Empty for a subagent's message, or one with no text, such as a tool call or thinking. */
  private assistantText(line: string): string {
    const parsed = assistantMessageSchema.safeParse(parseJsonLine(line));

    if (!parsed.success || (parsed.data.parent_tool_use_id ?? null) !== null) {
      return '';
    }

    return parsed.data.message.content
      .flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text.trim()] : []))
      .filter(text => text !== '')
      .join('\n\n');
  }

  /**
   * Claude reads a turn that ended on an API error as a `success` result with `is_error` set, and a null status when no
   * response came. Overloaded is 529.
   */
  private apiError(result: string | null): IApiError | null {
    const parsed = runResultSchema.safeParse(parseJsonLine(result));

    if (!parsed.success || parsed.data.subtype !== 'success' || !parsed.data.is_error) {
      return null;
    }

    const status = parsed.data.api_error_status;
    const detail = parsed.data.result ?? '';
    const error =
      `Claude ended on an API error${typeof status === 'number' ? ` (status ${status})` : ''}` +
      (detail === '' ? '' : `: ${detail.slice(0, RESULT_DETAIL_MAX_LENGTH)}`);

    return { error, deploymentFault: this.apiFault(status) };
  }

  /** Claude reports a refused connection as null. An absent status names no fault, so it fails for good. */
  private apiFault(status: number | null | undefined): DeploymentFault | null {
    if (status === null || status === TOO_MANY_REQUESTS || (status !== undefined && status >= SERVER_ERROR)) {
      return DeploymentFault.TRANSIENT;
    }

    return status === UNAUTHORIZED || status === FORBIDDEN ? DeploymentFault.PERMANENT : null;
  }

  private reportFailure(report: IRunReport): string | null {
    if (report.error !== null) {
      return report.error;
    }

    if (report.exitCode !== 0) {
      return report.exitCode === null ? 'The agent did not exit on its own' : `The agent exited ${report.exitCode}`;
    }

    if (report.result === null) {
      return 'Claude exited without a result';
    }

    const parsed = runResultSchema.safeParse(parseJsonLine(report.result));

    if (!parsed.success) {
      return 'Claude ended with a result line that could not be read';
    }

    const { subtype, is_error: isError, result } = parsed.data;

    if (subtype === 'success' && !isError) {
      return null;
    }

    const detail = result === undefined || result === '' ? '' : `: ${result.slice(0, RESULT_DETAIL_MAX_LENGTH)}`;

    return `Claude reported an error result (${subtype})${detail}`;
  }
}
