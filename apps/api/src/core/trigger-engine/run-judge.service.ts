import { Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleepFor } from 'node:timers/promises';

import type { Task } from '@/core/task/entities/task.entity';

import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { IssueSourceService } from '@/core/issue-source/issue-source.service';

import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import { RunEndReason, RunOutcome, type IRunJudgement } from '@/core/task/task.types';

/** The waits between reads of the issue's labels, so a short GitLab outage cannot fail a finished run. */
export const LABEL_READ_DELAYS_MS: readonly number[] = [10_000, 60_000];

const SUCCEEDED: IRunJudgement = { outcome: RunOutcome.SUCCEEDED, error: null, deploymentFault: null };

@Injectable()
export class RunJudgeService {
  private readonly logger = new Logger(RunJudgeService.name);

  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly issueSourceService: IssueSourceService
  ) {}

  /**
   * Judges the task by the issue its last step leaves, against `issue.expect`. A trigger with no `expect` passes. An
   * issue that cannot be read fails the task as a miss does, since a retry would run the last step again. Rejects only
   * when `signal` aborts.
   */
  async judgeExpect(trigger: ITriggerConfig, task: Task, signal: AbortSignal): Promise<IRunJudgement> {
    const expected = trigger.issue?.expect.anyLabel ?? [];

    if (expected.length === 0) {
      return SUCCEEDED;
    }

    const labels = await this.readLabels(trigger, task, signal);

    if (typeof labels === 'string') {
      return { ...this.failure(labels), endReason: RunEndReason.RUNNER_ERROR };
    }

    return expected.some(label => labels.includes(label))
      ? SUCCEEDED
      : this.failure(`The run ended without the issue carrying ${expected.join(' or ')}`);
  }

  private failure(error: string): IRunJudgement {
    return { outcome: RunOutcome.FAILED, error, deploymentFault: null };
  }

  /** The issue's labels, or why they could not be read. */
  private async readLabels(trigger: ITriggerConfig, task: Task, signal: AbortSignal): Promise<string[] | string> {
    const { projectId, issueIid } = task;

    if (projectId === null || issueIid === null) {
      return 'The task has no issue, so the run could not be judged by its labels';
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const issue = await this.issueSourceService.readIssue(trigger.source, projectId, issueIid, signal);

        return issue === null ? 'The issue no longer exists, so the run could not be judged' : issue.labels;
      } catch (error) {
        signal.throwIfAborted();

        const message = this.foundryConfigService.redactText(error instanceof Error ? error.message : String(error));

        if (attempt >= LABEL_READ_DELAYS_MS.length) {
          return `Failed to read the issue's labels to judge the run: ${message}`;
        }

        this.logger.warn(
          { taskId: task.id, attempt: attempt + 1, error: message },
          "readLabels(): Failed to read the issue's labels, trying again"
        );

        await this.sleep(LABEL_READ_DELAYS_MS[attempt], signal);
      }
    }
  }

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return sleepFor(milliseconds, undefined, { signal });
  }
}
