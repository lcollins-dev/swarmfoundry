import { describe, expect, it, vi } from 'vitest';

import { ActionRegistryService } from './action-registry.service';
import type { AgentActionService } from './agent-action.service';
import type { IssueActionService } from './issue-action.service';
import { StepExecutorService } from './step-executor.service';

import type { IStepConfig } from '@/core/foundry-config/foundry-config.types';
import { RunEndReason, RunOutcome, type IRunReport } from '@/core/task/task.types';

const CLEAN: IRunReport = { exitCode: 0, result: null, error: null };
const FAILED: IRunReport = { exitCode: 1, result: null, error: null };

const steps = [
  { kind: 'agent', token: 'first' },
  { kind: 'agent', token: 'second' },
] as unknown as IStepConfig[];

const executor = (ready = true) =>
  new StepExecutorService(
    new ActionRegistryService(
      {
        isReady: () => ready,
        secretsOf: (step: { token: string }) => [step.token],
        judge: vi.fn((_step: IStepConfig, report: IRunReport) =>
          report.exitCode === 0
            ? { outcome: RunOutcome.SUCCEEDED, error: null, deploymentFault: null }
            : { outcome: RunOutcome.FAILED, error: `The agent exited ${report.exitCode}`, deploymentFault: null }
        ),
      } as unknown as AgentActionService,
      { isReady: () => true } as IssueActionService
    )
  );

describe('StepExecutorService', () => {
  it('moves on to the next step of the list once a step succeeds', () => {
    expect(executor().after(steps, 0, CLEAN)).toEqual({ kind: 'next', index: 1 });
  });

  it('ends the list with the last step, with its judgement', () => {
    expect(executor().after(steps, 1, CLEAN)).toEqual({
      kind: 'end',
      judgement: { outcome: RunOutcome.SUCCEEDED, error: null, deploymentFault: null },
    });
  });

  it('ends the list at a failed step, whatever follows it', () => {
    expect(executor().after(steps, 0, FAILED)).toEqual({
      kind: 'end',
      judgement: { outcome: RunOutcome.FAILED, error: 'The agent exited 1', deploymentFault: null },
    });
  });

  it('fails a step the list does not hold', () => {
    expect(executor().after(steps, 2, CLEAN)).toEqual({
      kind: 'end',
      judgement: {
        outcome: RunOutcome.FAILED,
        error: 'Step 2 is no longer in the config',
        deploymentFault: null,
        endReason: RunEndReason.RUNNER_ERROR,
      },
    });
  });

  it("collects every step's secrets from its handler", () => {
    expect(executor().secretsOf(steps)).toEqual(['first', 'second']);
  });

  it('is ready only while every handler is', () => {
    expect(executor().isReady()).toBe(true);
    expect(executor(false).isReady()).toBe(false);
  });
});
