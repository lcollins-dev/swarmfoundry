import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Run } from '@/core/task/entities/run.entity';

import { AgentActionService, ASSISTANT_LINES_READ } from './agent-action.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import type { TaskService } from '@/core/task/task.service';

import type { IAgentRunner, IAgentRunRequest } from './actions.types';
import type { IAgentStepConfig } from '@/core/foundry-config/foundry-config.types';
import { DeploymentFault, RunOutcome, StepList, type IRunReport } from '@/core/task/task.types';

const result = ({ subtype = 'success', isError = false, text = 'Done' } = {}) =>
  `{"type":"result","subtype":"${subtype}","is_error":${isError},"result":"${text}"}`;

const CLEAN: IRunReport = { exitCode: 0, result: result(), error: null };

const step = {
  kind: 'agent',
  agent: { name: 'claude', model: 'claude-opus-5-5', auth: 'oauth', concurrency: 3 },
} as unknown as IAgentStepConfig;

const apiError = (status: number | null, text: string) =>
  `{"type":"result","subtype":"success","is_error":true,"api_error_status":${status},"result":"${text}"}`;

const runner = () => ({
  run: vi.fn<IAgentRunner['run']>().mockResolvedValue(CLEAN),
  resume: vi.fn<IAgentRunner['resume']>().mockResolvedValue(CLEAN),
  removeSandboxesExcept: vi.fn<IAgentRunner['removeSandboxesExcept']>().mockResolvedValue(undefined),
});

const foundryConfigService = { redactText: (text: string) => text } as unknown as FoundryConfigService;

const agentAction = (
  agentRunner?: IAgentRunner,
  findAssistantLines: TaskService['findAssistantLines'] = () => Promise.resolve([])
) => new AgentActionService(foundryConfigService, { findAssistantLines } as unknown as TaskService, agentRunner);

describe('AgentActionService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("holds a slot of its agent's cap, naming the model and auth its runs record", () => {
    expect(agentAction(runner()).agentOf(step)).toEqual({
      name: 'claude',
      model: 'claude-opus-5-5',
      auth: 'oauth',
      concurrency: 3,
    });
  });

  it('runs and resumes a step through the agent runner, and sweeps its sandboxes', async () => {
    const agentRunner = runner();
    const service = agentAction(agentRunner);
    const request = { step } as IAgentRunRequest;

    await service.run(request);
    await service.resume(request);
    await service.removeLeftoversExcept(new Set([9]));

    expect(agentRunner.run).toHaveBeenCalledExactlyOnceWith(request);
    expect(agentRunner.resume).toHaveBeenCalledExactlyOnceWith(request);
    expect(agentRunner.removeSandboxesExcept).toHaveBeenCalledExactlyOnceWith(new Set([9]));
  });

  it('is not ready with no agent runner bound, and rejects a run', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = agentAction();

    service.onModuleInit();

    expect(service.isReady()).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    await expect(service.run({ step } as IAgentRunRequest)).rejects.toThrow('No agent runner is installed');
    await expect(service.removeLeftoversExcept(new Set())).resolves.toBeUndefined();
  });

  it("masks the step agent's token", () => {
    expect(agentAction(runner()).secretsOf({ ...step, agent: { ...step.agent, token: 'sk-ant' } })).toEqual(['sk-ant']);
  });

  it('passes a run that exited 0 with a clean result', () => {
    expect(agentAction(runner()).judge(step, CLEAN)).toEqual({
      outcome: RunOutcome.SUCCEEDED,
      error: null,
      deploymentFault: null,
    });
  });

  it.each<[string, IRunReport, string]>([
    ['a timeout', { exitCode: null, result: null, error: 'Timed out after 1 hour' }, 'Timed out after 1 hour'],
    ['a non-zero exit', { exitCode: 2, result: result(), error: null }, 'The agent exited 2'],
    ['no exit code', { exitCode: null, result: null, error: null }, 'The agent did not exit on its own'],
    ['no result', { exitCode: 0, result: null, error: null }, 'Claude exited without a result'],
    [
      'an unreadable result',
      { exitCode: 0, result: '{"type":"result"', error: null },
      'Claude ended with a result line that could not be read',
    ],
    [
      'an error result',
      { exitCode: 0, result: result({ subtype: 'error_max_turns', text: '' }), error: null },
      'Claude reported an error result (error_max_turns)',
    ],
    [
      'Claude ending on a bad request',
      { exitCode: 1, result: apiError(400, 'API Error: Bad request'), error: 'The agent exited with code 1' },
      'Claude ended on an API error (status 400): API Error: Bad request',
    ],
    [
      'Claude ending on an API error with no status field',
      {
        exitCode: 1,
        result: '{"type":"result","subtype":"success","is_error":true,"result":"API Error: Unknown"}',
        error: 'The agent exited with code 1',
      },
      'Claude ended on an API error: API Error: Unknown',
    ],
    [
      'a stopped agent whose turn ended on the aborted request',
      {
        exitCode: null,
        result: result({ isError: true, text: 'API Error: Request was aborted.' }),
        error: 'Timed out after 1 hour, stopped with SIGINT',
      },
      'Timed out after 1 hour, stopped with SIGINT',
    ],
  ])('fails %s for the work, so it does not retry', (_case, report, error) => {
    expect(agentAction(runner()).judge(step, report)).toEqual({
      outcome: RunOutcome.FAILED,
      error,
      deploymentFault: null,
    });
  });

  it.each<[string, IRunReport, string]>([
    [
      'a failure the runner flagged',
      { exitCode: null, result: null, error: 'Docker answered 500', deploymentFault: DeploymentFault.TRANSIENT },
      'Docker answered 500',
    ],
    [
      'Claude ending on an overloaded API',
      { exitCode: 1, result: apiError(529, 'API Error: Overloaded'), error: 'The agent exited with code 1' },
      'Claude ended on an API error (status 529): API Error: Overloaded',
    ],
    [
      'Claude ending on a rate limit',
      { exitCode: 1, result: apiError(429, 'API Error: Rate limited'), error: 'The agent exited with code 1' },
      'Claude ended on an API error (status 429): API Error: Rate limited',
    ],
    [
      'Claude ending on a server error',
      { exitCode: 1, result: apiError(500, 'API Error: Internal'), error: 'The agent exited with code 1' },
      'Claude ended on an API error (status 500): API Error: Internal',
    ],
    [
      'Claude ending on an API error with no response',
      { exitCode: 1, result: apiError(null, 'API Error: ECONNREFUSED'), error: 'The agent exited with code 1' },
      'Claude ended on an API error: API Error: ECONNREFUSED',
    ],
  ])('fails %s on a transient deployment fault, so it retries', (_case, report, error) => {
    expect(agentAction(runner()).judge(step, report)).toEqual({
      outcome: RunOutcome.FAILED,
      error,
      deploymentFault: DeploymentFault.TRANSIENT,
    });
  });

  it.each<[string, IRunReport, string]>([
    [
      'Claude ending on a refused token',
      { exitCode: 1, result: apiError(401, 'API Error: Invalid token'), error: 'The agent exited with code 1' },
      'Claude ended on an API error (status 401): API Error: Invalid token',
    ],
    [
      'Claude ending on a forbidden request',
      { exitCode: 1, result: apiError(403, 'API Error: Forbidden'), error: 'The agent exited with code 1' },
      'Claude ended on an API error (status 403): API Error: Forbidden',
    ],
    [
      'a config fault the runner flagged',
      { exitCode: null, result: null, error: 'No GITLAB_TOKEN', deploymentFault: DeploymentFault.PERMANENT },
      'No GITLAB_TOKEN',
    ],
  ])('fails %s on a permanent deployment fault, so it does not retry', (_case, report, error) => {
    expect(agentAction(runner()).judge(step, report)).toEqual({
      outcome: RunOutcome.FAILED,
      error,
      deploymentFault: DeploymentFault.PERMANENT,
    });
  });

  describe('failureMessage', () => {
    const resultLine = (result?: string, subtype = 'success'): string => {
      const resultField = result === undefined ? '' : `,"result":${JSON.stringify(result)}`;

      return `{"type":"result","subtype":"${subtype}","is_error":${subtype !== 'success'}${resultField}}`;
    };

    const assistantLine = (content: unknown[], parentToolUseId: string | null = null): string =>
      `{"type":"assistant","message":{"role":"assistant","content":${JSON.stringify(content)}},` +
      `"parent_tool_use_id":${JSON.stringify(parentToolUseId)},"uuid":"6c1e0e57-5b2a-4d0e-9a51-2f0c3c1d8e11"}`;

    const runWith = (result: string | null, containerId: string | null = 'c0ffee'): Run => {
      const run = new Run({
        taskId: 12,
        number: 1,
        list: StepList.STEPS,
        step: 0,
        startDate: new Date(),
        configId: null,
        agent: null,
      });
      run.id = 34;
      run.containerId = containerId;
      run.result = result;

      return run;
    };

    it('quotes the result text, reading no transcript', async () => {
      const findAssistantLines = vi.fn(() => Promise.resolve([]));

      await expect(
        agentAction(runner(), findAssistantLines).failureMessage(step, runWith(resultLine(' I opened no MR. ')))
      ).resolves.toEqual({ heading: 'Final message', text: 'I opened no MR.' });
      expect(findAssistantLines).not.toHaveBeenCalled();
    });

    it("falls back to the main agent's last text, skipping subagents, tool calls and thinking", async () => {
      const lines = [
        assistantLine([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }]),
        assistantLine([{ type: 'text', text: 'Subagent: found nothing.' }], 'toolu_0'),
        assistantLine([
          { type: 'thinking', thinking: 'Hmm.', signature: 'EqQBCkgIBxABGAIqQL' },
          { type: 'text', text: '  The build fails on a missing env var.  ' },
        ]),
        assistantLine([{ type: 'text', text: 'Starting.' }]),
      ];
      const findAssistantLines = vi.fn(() => Promise.resolve(lines));

      await expect(
        agentAction(runner(), findAssistantLines).failureMessage(
          step,
          runWith(resultLine(undefined, 'error_max_turns'))
        )
      ).resolves.toEqual({ heading: 'Final message', text: 'The build fails on a missing env var.' });
      expect(findAssistantLines).toHaveBeenCalledWith(34, ASSISTANT_LINES_READ);
    });

    it.each([
      [
        'no result and no assistant text',
        null,
        () => Promise.resolve([assistantLine([{ type: 'tool_use' }]), '{oops']),
      ],
      ['an unreadable transcript', 'not json', () => Promise.reject(new Error('connection lost'))],
    ])('notes no final message with %s', async (_case, result, lines) => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(agentAction(runner(), lines).failureMessage(step, runWith(result))).resolves.toEqual({
        note: 'The agent left no final message.',
      });
    });

    it('notes the agent never started for a run refused before its container existed', async () => {
      const findAssistantLines = vi.fn(() => Promise.resolve([]));

      await expect(
        agentAction(runner(), findAssistantLines).failureMessage(step, runWith(null, null))
      ).resolves.toEqual({ note: 'The agent never started.' });
      expect(findAssistantLines).not.toHaveBeenCalled();
    });
  });
});
