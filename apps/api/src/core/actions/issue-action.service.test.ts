import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ZodError } from 'zod';

import { Run } from '@/core/task/entities/run.entity';
import { Task } from '@/core/task/entities/task.entity';

import { IssueActionService } from './issue-action.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { PromptTemplateService } from '@/core/foundry-config/prompt-template.service';
import type { IssueSourceService } from '@/core/issue-source/issue-source.service';
import type { TaskService } from '@/core/task/task.service';

import type { IStepRequest } from './actions.types';
import type {
  ICommentStepConfig,
  IPromptContext,
  IStaticStepConfig,
  ITriggerConfig,
} from '@/core/foundry-config/foundry-config.types';
import { GitLabApiError, GitLabUnknownUserError } from '@/core/issue-source/gitlab-api.error';
import { DeploymentFault, RunOutcome, StepList } from '@/core/task/task.types';

const SOURCE_TOKEN = 'glpat-orchestrator-token';

const source = { name: 'gitlab', token: SOURCE_TOKEN };
const trigger = { name: 'merged', source } as unknown as ITriggerConfig;

const RELABEL: IStaticStepConfig = { kind: 'relabel', add: ['workflow::test'], remove: ['workflow::review'] };
const ASSIGN: IStaticStepConfig = { kind: 'assign', usernames: ['ada', 'swarmfoundry-bot'] };

const mergeRequest = {
  iid: 5,
  event: 'merged' as const,
  title: '/close (#3)',
  url: 'https://gitlab.test/group/project/-/merge_requests/5',
  sourceBranch: '3-fix-it',
  targetBranch: 'master',
};

const taskWith = (issueIid: number | null) => {
  const task = new Task({
    triggerName: 'merged',
    sourceName: 'gitlab',
    projectId: 7,
    projectPath: 'group/project',
    projectUrl: 'https://gitlab.test/group/project',
    issueIid,
    issueTitle: issueIid === null ? null : 'Fix it',
    issueUrl: issueIid === null ? null : 'https://gitlab.test/group/project/-/issues/3',
    matchedIssue: null,
    change: null,
    fireTime: null,
    cron: null,
    mergeRequest,
    queuedDate: new Date(),
  });
  task.id = 12;

  return task;
};

const run = new Run({
  taskId: 12,
  number: 1,
  list: StepList.STEPS,
  step: 1,
  startDate: new Date(),
  configId: null,
  agent: null,
});
run.id = 34;

const context: IPromptContext = {
  mergeRequest,
  issue: { iid: 3, title: 'Fix it', url: 'https://gitlab.test/group/project/-/issues/3' },
  project: { path: 'group/project', url: 'https://gitlab.test/group/project' },
  trigger: { name: 'merged' },
  task: { id: 12 },
  run: { id: 34 },
};

describe('IssueActionService', () => {
  let relabel: Mock<IssueSourceService['relabel']>;
  let assign: Mock<IssueSourceService['assign']>;
  let comment: Mock<IssueSourceService['comment']>;
  let service: IssueActionService;
  const signal = new AbortController().signal;

  const request = (step: IStaticStepConfig, task = taskWith(3), extra: Partial<IStepRequest> = {}) =>
    ({ trigger, step, task, run, signal, ...extra }) as IStepRequest<IStaticStepConfig>;

  beforeEach(() => {
    relabel = vi.fn<IssueSourceService['relabel']>().mockResolvedValue(undefined);
    assign = vi.fn<IssueSourceService['assign']>().mockResolvedValue(undefined);
    comment = vi.fn<IssueSourceService['comment']>().mockResolvedValue(undefined);

    const promptTemplateService = new PromptTemplateService();
    const foundryConfigService = {
      renderComment: (step: ICommentStepConfig, rendered: IPromptContext) =>
        promptTemplateService.renderComment(step.body, rendered),
      redactText: (text: string) => text.replaceAll(SOURCE_TOKEN, '[redacted]'),
    } as unknown as FoundryConfigService;

    service = new IssueActionService(
      foundryConfigService,
      { relabel, assign, comment } as unknown as IssueSourceService,
      { promptContext: () => Promise.resolve(context) } as unknown as TaskService
    );
  });

  it('runs no agent, needs nothing to start, and leaves nothing behind', async () => {
    expect(service.isReady()).toBe(true);
    expect(service.agentOf()).toBeNull();
    expect(service.secretsOf()).toEqual([]);
    await expect(service.failureMessage()).resolves.toBeNull();
    await expect(service.removeLeftoversExcept()).resolves.toBeUndefined();
  });

  it("relabels the task's issue with the source, and records what it did", async () => {
    await expect(service.run(request(RELABEL))).resolves.toEqual({
      exitCode: null,
      result: 'Relabelled issue 3: added workflow::test; removed workflow::review',
      error: null,
    });

    expect(relabel).toHaveBeenCalledExactlyOnceWith(source, 7, 3, ['workflow::test'], ['workflow::review'], signal);
  });

  it("assigns the task's issue to the listed users", async () => {
    await expect(service.run(request(ASSIGN))).resolves.toMatchObject({
      result: 'Assigned issue 3 to ada, swarmfoundry-bot',
      error: null,
    });

    expect(assign).toHaveBeenCalledExactlyOnceWith(source, 7, 3, ['ada', 'swarmfoundry-bot'], signal);
  });

  it('comments the rendered body, with the failure variables, escaping a value that would run a quick action', async () => {
    const step: IStaticStepConfig = {
      kind: 'comment',
      body: '{{mergeRequest.title}}\nMerged in !{{mergeRequest.iid}} for #{{issue.iid}}. {{failure.reason}}',
    };
    const failure = { report: 'It failed.', reason: '` exit 1 `' };

    await expect(service.run(request(step, taskWith(3), { failure }))).resolves.toMatchObject({
      result: 'Commented on issue 3',
      error: null,
    });

    expect(comment).toHaveBeenCalledExactlyOnceWith(
      source,
      7,
      3,
      '\\/close (#3)\nMerged in !5 for #3. ` exit 1 `',
      signal
    );
  });

  it('redacts the rendered comment', async () => {
    await service.run(request({ kind: 'comment', body: `Token ${SOURCE_TOKEN}` }));

    expect(comment.mock.calls[0][3]).toBe('Token [redacted]');
  });

  it('completes with nothing to do for a merge request task with no related issue, saying why', async () => {
    await expect(service.run(request(RELABEL, taskWith(null)))).resolves.toEqual({
      exitCode: null,
      result: 'Merge request !5 relates to no issue, so the relabel step had nothing to act on',
      error: null,
    });

    expect(relabel).not.toHaveBeenCalled();
  });

  it.each<[string, Error, DeploymentFault | undefined]>([
    ['a 401', new GitLabApiError(401, 'PUT', '/projects/7/issues/3'), DeploymentFault.PERMANENT],
    ['a 403', new GitLabApiError(403, 'PUT', '/projects/7/issues/3'), undefined],
    ['an unknown user', new GitLabUnknownUserError('nobody'), undefined],
    ['a 429', new GitLabApiError(429, 'PUT', '/projects/7/issues/3'), DeploymentFault.TRANSIENT],
    ['a 502', new GitLabApiError(502, 'PUT', '/projects/7/issues/3'), DeploymentFault.TRANSIENT],
    [
      'a network error',
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
      }),
      DeploymentFault.TRANSIENT,
    ],
    ['a refused redirect', new TypeError('fetch failed', { cause: new Error('unexpected redirect') }), undefined],
    ['a response that is not JSON', new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON'), undefined],
    ['a response of the wrong shape', new ZodError([]), undefined],
    ['a programming error', new TypeError('step.add.join is not a function'), undefined],
    ['a timeout', new DOMException('The operation timed out', 'TimeoutError'), DeploymentFault.TRANSIENT],
    ['an abort', new DOMException('The operation was aborted', 'AbortError'), DeploymentFault.TRANSIENT],
  ])('fails on %s, naming the step and the error and any deployment fault', async (_case, error, deploymentFault) => {
    relabel.mockRejectedValue(error);

    await expect(service.run(request(RELABEL))).resolves.toEqual({
      exitCode: null,
      result: null,
      error: `steps[1] (relabel) failed: ${error.message}`,
      deploymentFault,
    });
  });

  it("acts on an issue trigger's own issue", async () => {
    const task = new Task({
      triggerName: 'in-progress',
      sourceName: 'gitlab',
      projectId: 7,
      projectPath: 'group/project',
      projectUrl: 'https://gitlab.test/group/project',
      issueIid: 9,
      issueTitle: 'Do it',
      issueUrl: 'https://gitlab.test/group/project/-/issues/9',
      matchedIssue: null,
      change: { kind: 'label', id: 42, createdAt: new Date('2026-10-14T10:00:00Z'), actor: 'ada' },
      fireTime: null,
      cron: null,
      mergeRequest: null,
      queuedDate: new Date(),
    });

    await expect(service.run(request(RELABEL, task))).resolves.toMatchObject({
      result: 'Relabelled issue 9: added workflow::test; removed workflow::review',
    });

    expect(relabel).toHaveBeenCalledExactlyOnceWith(source, 7, 9, ['workflow::test'], ['workflow::review'], signal);
  });

  it('fails a comment that renders the failure when the failure could not be read, posting nothing', async () => {
    await expect(service.run(request({ kind: 'comment', body: '{{failure.report}}' }))).resolves.toEqual({
      exitCode: null,
      result: null,
      error:
        "steps[1] (comment) failed: render(): The task's failure could not be read, so {{failure.report}} cannot render",
    });

    expect(comment).not.toHaveBeenCalled();
  });

  it('redacts the error of a failed step', async () => {
    assign.mockRejectedValue(new Error(`connect failed for ${SOURCE_TOKEN}`));

    await expect(service.run(request(ASSIGN))).resolves.toMatchObject({
      error: 'steps[1] (assign) failed: connect failed for [redacted]',
    });
  });

  it('acts again from the start on resume', async () => {
    await service.resume(request(RELABEL));

    expect(relabel).toHaveBeenCalledOnce();
  });

  it('passes a run with no error, and fails one with its error and deployment fault', () => {
    expect(service.judge(RELABEL, { exitCode: null, result: 'Relabelled', error: null })).toEqual({
      outcome: RunOutcome.SUCCEEDED,
      error: null,
      deploymentFault: null,
    });
    expect(
      service.judge(RELABEL, {
        exitCode: null,
        result: null,
        error: 'GitLab answered 502',
        deploymentFault: DeploymentFault.TRANSIENT,
      })
    ).toEqual({ outcome: RunOutcome.FAILED, error: 'GitLab answered 502', deploymentFault: DeploymentFault.TRANSIENT });
  });
});
