import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { Run } from '@/core/task/entities/run.entity';
import { Task } from '@/core/task/entities/task.entity';

import { COMMENT_TEXT_MAX_LENGTH, FailureReportService } from './failure-report.service';
import { ActionRegistryService } from '@/core/actions/action-registry.service';
import { AgentActionService } from '@/core/actions/agent-action.service';
import { IssueActionService } from '@/core/actions/issue-action.service';
import { StepExecutorService } from '@/core/actions/step-executor.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { SecretRedactionService } from '@/core/foundry-config/secret-redaction.service';
import type { IssueSourceService } from '@/core/issue-source/issue-source.service';
import type { TaskService } from '@/core/task/task.service';

import type { IStepConfig, ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import { DeploymentFault, RunOutcome, StepList, type IRunJudgement } from '@/core/task/task.types';

const SOURCE_TOKEN = 'glpat-orchestrator-token';
const AGENT_TOKEN = 'sk-ant-oat-agent-token';

const AGENT_STEP = { kind: 'agent', agent: { token: AGENT_TOKEN } } as unknown as IStepConfig;
const FAILED_LABEL_STEP: IStepConfig = { kind: 'relabel', add: ['foundry::failed'], remove: [] };
const REPORT_STEP: IStepConfig = { kind: 'comment', body: '{{failure.report}}' };

interface ITestTriggerOptions {
  labels?: string[];
  notLabels?: string[];
  steps?: IStepConfig[];
  failureSteps?: IStepConfig[];
}

const trigger = ({
  labels = ['workflow::ready'],
  notLabels = ['foundry::failed'],
  steps = [AGENT_STEP],
  failureSteps = [FAILED_LABEL_STEP, REPORT_STEP],
}: ITestTriggerOptions = {}) =>
  ({
    name: 'implement',
    source: { name: 'gitlab', token: SOURCE_TOKEN },
    steps,
    failureSteps,
    issue: { labels, notLabels },
  }) as unknown as ITriggerConfig;

const scheduledTrigger = {
  name: 'friction',
  source: { name: 'gitlab', token: SOURCE_TOKEN },
  steps: [AGENT_STEP],
  failureSteps: [],
  schedule: { cron: '0 9 * * 1', project: 'group/project' },
} as unknown as ITriggerConfig;

const mergeRequestTrigger = {
  ...scheduledTrigger,
  name: 'merged',
  schedule: undefined,
  mergeRequest: { event: 'merged', labels: [], notLabels: [], projects: [] },
} as unknown as ITriggerConfig;

const taskFields = {
  sourceName: 'gitlab',
  projectPath: 'group/project',
  projectUrl: 'https://gitlab.test/group/project',
  matchedIssue: null,
  change: null,
  fireTime: null,
  cron: null,
  mergeRequest: null,
  queuedDate: new Date(),
};

const issueFields = {
  projectId: 7,
  issueIid: 3,
  issueTitle: 'Fix it',
  issueUrl: 'https://gitlab.test/group/project/-/issues/3',
};

const task = new Task({
  ...taskFields,
  ...issueFields,
  triggerName: 'implement',
  change: { kind: 'label', id: 42, createdAt: new Date('2026-10-14T10:00:00Z'), actor: 'ada' },
});
task.id = 12;

const scheduledTask = new Task({
  ...taskFields,
  triggerName: 'friction',
  projectId: null,
  issueIid: null,
  issueTitle: null,
  issueUrl: null,
  fireTime: new Date('2026-10-19T09:00:00Z'),
  cron: '0 9 * * 1',
});
scheduledTask.id = 13;

const mergeRequestTask = new Task({
  ...taskFields,
  ...issueFields,
  triggerName: 'merged',
  mergeRequest: {
    iid: 5,
    event: 'merged',
    title: 'Fix it (#3)',
    url: 'https://gitlab.test/group/project/-/merge_requests/5',
    sourceBranch: '3-fix-it',
    targetBranch: 'master',
  },
});
mergeRequestTask.id = 14;

const resultLine = (result: string) =>
  `{"type":"result","subtype":"success","is_error":false,"session_id":"f3a1","result":${JSON.stringify(result)}}`;

const failedRun = (
  error: string | null,
  result: string | null = resultLine('I opened no MR: the tests need a database I cannot reach.')
): Run => {
  const run = new Run({
    taskId: 12,
    number: 3,
    list: StepList.STEPS,
    step: 0,
    startDate: new Date(),
    configId: null,
    agent: null,
  });
  run.id = 34;
  run.containerId = 'c0ffee';
  run.result = result;
  run.error = error;
  run.outcome = RunOutcome.FAILED;

  return run;
};

describe('FailureReportService', () => {
  let run: Run | null;
  let findFailedRun: Mock<TaskService['findFailedRun']>;
  let service: FailureReportService;

  const reportOf = async (forTrigger = trigger(), forTask = task) =>
    (await service.context(forTrigger, forTask)).report;

  beforeEach(() => {
    run = failedRun('The run ended without the issue carrying workflow::review');
    findFailedRun = vi.fn(() => Promise.resolve(run));

    const secretRedactionService = new SecretRedactionService();
    const foundryConfigService = {
      redactText: (text: string, extra: readonly string[] = []) =>
        secretRedactionService.redactText(text, [SOURCE_TOKEN, ...extra]),
    } as unknown as FoundryConfigService;
    const taskService = { findFailedRun, findAssistantLines: () => Promise.resolve([]) } as unknown as TaskService;

    service = new FailureReportService(
      foundryConfigService,
      taskService,
      new StepExecutorService(
        new ActionRegistryService(
          new AgentActionService(foundryConfigService, taskService),
          new IssueActionService(foundryConfigService, {} as IssueSourceService, taskService)
        )
      )
    );

    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe('context', () => {
    it("reads the task's failed run, and says what failed, the final message, how to retry and the run", async () => {
      run!.number = 1;

      expect(await reportOf()).toBe(
        [
          '# Failed',
          '',
          ':x: The `implement` trigger gave up on this issue after 1 run.',
          '',
          '## Error',
          '',
          '```text',
          ' The run ended without the issue carrying workflow::review',
          '```',
          '',
          '## Final message',
          '',
          '```text',
          ' I opened no MR: the tests need a database I cannot reach.',
          '```',
          '',
          '## Retry',
          '',
          'Add `workflow::ready` if the issue lacks it, then remove `foundry::failed`. If the issue lacks' +
            ' `foundry::failed`, instead add `workflow::ready` again, removing it first if the issue still has it.',
          '',
          '---',
          ':robot: Generated by Swarmfoundry (Implement, task 12)',
        ].join('\n')
      );
      expect(findFailedRun).toHaveBeenCalledWith(12);
    });

    it('gives the reason as one line of inline code', async () => {
      run = failedRun('Claude reported an error\n/close `now`');

      await expect(service.context(trigger(), task)).resolves.toMatchObject({
        reason: '`` Claude reported an error /close `now` ``',
      });
    });

    it('rejects for a task with no failed run', async () => {
      run = null;

      await expect(service.context(trigger(), task)).rejects.toThrow('Task 12 has no failed run to report');
    });

    it('leaves out the message block for a failed static step, whose error says it all', async () => {
      run = failedRun('steps[1] (relabel) failed: GitLab answered 403 to PUT /projects/7/issues/3', null);
      run.step = 1;
      run.containerId = null;

      const report = await reportOf(trigger({ steps: [AGENT_STEP, FAILED_LABEL_STEP] }));

      expect(report).toContain('gave up on this issue at step 2 of 2, after 3 runs.');
      expect(report).toContain('```\n\n## Retry');
      expect(report).not.toContain('agent');
    });

    it('posts no token, raw or encoded, from the source, the agent or the final message', async () => {
      const encoded = Buffer.from(`${AGENT_TOKEN}\n`).toString('base64');
      run = failedRun(
        `clone failed for ${SOURCE_TOKEN} ${AGENT_TOKEN}`,
        resultLine(`Here it is: ${encoded} and ${SOURCE_TOKEN}`)
      );

      const { report, reason } = await service.context(trigger(), task);

      for (const text of [report, reason]) {
        expect(text).not.toContain(SOURCE_TOKEN);
        expect(text).not.toContain(AGENT_TOKEN);
        expect(text).toContain('[redacted]');
      }
      expect(report).not.toContain(encoded.slice(0, 20));
    });

    it('masks the agent token of a failure step too', async () => {
      const triageToken = 'sk-ant-api-triage-token';
      const triage = { kind: 'agent', agent: { token: triageToken } } as unknown as IStepConfig;
      run = failedRun(`failed for ${triageToken}`);

      expect(await reportOf(trigger({ failureSteps: [triage] }))).not.toContain(triageToken);
    });

    it('cuts a long message, and fences text that holds backticks so it cannot close the block', async () => {
      run = failedRun('oops', resultLine(`${'x'.repeat(COMMENT_TEXT_MAX_LENGTH + 50)} see \`\`\`\``));

      const report = await reportOf();

      expect(report).toContain(` ${'x'.repeat(COMMENT_TEXT_MAX_LENGTH)}...\n`);

      run = failedRun('oops', resultLine('see ````\n/close'));

      expect(await reportOf()).toContain('`````text\n');
    });

    it('starts no line of agent or error text with a slash, so GitLab runs no quick action from it', async () => {
      run = failedRun('oops\r/close\n/unlabel ~foundry::failed', resultLine('```\n/close\n/label ~"workflow::done"'));

      const report = await reportOf();

      expect(report.split('\n').filter(line => line.startsWith('/'))).toEqual([]);
      expect(report).toContain(' /label ~"workflow::done"\n');
    });

    it('names every trigger label in the retry hint, and no failure label when failureSteps add none', async () => {
      const labels = ['workflow::ready', 'agent::implement'];

      expect(await reportOf(trigger({ labels, failureSteps: [REPORT_STEP] }))).toMatch(
        /\nAdd `workflow::ready`, `agent::implement` again, removing any the issue still has first\.\n/
      );
    });

    it('asks for every missing trigger label beside the cleared flag', async () => {
      const labels = ['workflow::ready', 'agent::implement'];

      expect(await reportOf(trigger({ labels }))).toMatch(
        /\nAdd any of `workflow::ready`, `agent::implement` the issue lacks, then remove `foundry::failed`\. If the issue lacks `foundry::failed`, instead add `workflow::ready`, `agent::implement` again, removing any the issue still has first\.\n/
      );
    });

    it('falls back to adding the trigger label again only where the issue has none of the flags', async () => {
      const flagStep: IStepConfig = { kind: 'relabel', add: ['foundry::failed', 'foundry::blocked'], remove: [] };
      const flagged = trigger({ notLabels: ['foundry::failed', 'foundry::blocked'], failureSteps: [flagStep] });

      expect(await reportOf(flagged)).toMatch(
        /\nAdd `workflow::ready` if the issue lacks it, then remove `foundry::failed`, `foundry::blocked`\. If the issue has none of `foundry::failed`, `foundry::blocked`, instead add `workflow::ready` again, removing it first if the issue still has it\.\n/
      );
    });

    it('asks to add the trigger label again when the failure label is not in notLabels, so clearing it fires nothing', async () => {
      expect(await reportOf(trigger({ notLabels: [] }))).toMatch(
        /\nRemove `foundry::failed` and add `workflow::ready` again, removing it first if the issue still has it\.\n/
      );
    });

    it('names a merge request task by its merge request, with no retry hint', async () => {
      const report = await reportOf(mergeRequestTrigger, mergeRequestTask);

      expect(report).toContain(':x: The `merged` trigger gave up on merge request !5 after 3 runs.');
      expect(report).not.toContain('## Retry');
    });

    it('names a scheduled task by its fire time', async () => {
      expect(await reportOf(scheduledTrigger, scheduledTask)).toContain(
        ':x: The `friction` trigger gave up on its run for 2026-10-19T09:00:00.000Z after 3 runs.'
      );
    });
  });

  describe('logFailure', () => {
    const failed = (error: string, deploymentFault: DeploymentFault | null = null): IRunJudgement => ({
      outcome: RunOutcome.FAILED,
      error,
      deploymentFault,
    });

    it('logs the failure, redacted, at error level', () => {
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      logged.mockClear();

      service.logFailure(scheduledTrigger, scheduledTask, failedRun(null), failed(`Leaked ${AGENT_TOKEN}`));

      expect(logged).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          taskId: 13,
          trigger: 'friction',
          fireTime: new Date('2026-10-19T09:00:00Z'),
          runId: 34,
          run: 3,
          step: 0,
        }),
        'logFailure(): Scheduled task 13 failed after 3 runs'
      );
      expect(JSON.stringify(logged.mock.calls[0][0])).not.toContain(AGENT_TOKEN);
    });

    it('names the merge request of a merge request task', () => {
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      logged.mockClear();

      service.logFailure(mergeRequestTrigger, mergeRequestTask, failedRun(null), failed('oops'));

      expect(logged).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ taskId: 14, trigger: 'merged', mergeRequest: 5 }),
        'logFailure(): Merge request task 14 failed after 3 runs'
      );
    });

    it('logs a deployment fault as one, naming the fault and that no failureSteps run', () => {
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      logged.mockClear();

      service.logFailure(trigger(), task, failedRun(null), failed('Docker answered 500', DeploymentFault.TRANSIENT));

      expect(logged).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          taskId: 12,
          trigger: 'implement',
          project: 'group/project',
          issue: 3,
          deploymentFault: DeploymentFault.TRANSIENT,
          error: 'Docker answered 500',
        }),
        'logFailure(): Deployment fault: Issue task 12 failed after 3 runs, so its failureSteps do not run'
      );
    });
  });
});
