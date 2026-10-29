import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { RunEndReason, RunOutcome, StepList, TaskStatus, TranscriptEventType, UserRoleId } from '@libs/dto';

import { RunTranscriptLine } from '@/core/task/entities/run-transcript-line.entity';
import type { Task } from '@/core/task/entities/task.entity';

import { TaskService } from '@/core/task/task.service';

import { getRun, getTask, getTaskList, getTranscript } from '../../clients/task.client';
import { login } from '../../clients/user.client';
import { createIssueEvent, createMergeRequestEvent, YEARLY_CRON } from '../../factories/trigger-engine.factory';
import { createTestUser } from '../../factories/user.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';

const AGENT = { name: 'claude', model: 'claude-opus-5-5', auth: 'oauth' as const };

const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done',
  num_turns: 3,
});

const TRANSCRIPT = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5', tools: ['Bash'] }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Running the tests.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1 failed', is_error: true }] },
  }),
  'not json',
  RESULT_LINE,
];

describe('Task and run read routes (integration)', () => {
  let app: NestExpressApplication;
  let taskService: TaskService;
  let token: string;
  let configId: number;
  let sha: string;

  /** A distinct trigger and project per spec, since every spec shares the database. */
  const scope = () => ({ trigger: `int-${randomUUID()}`, project: `group/${randomUUID()}` });

  const enqueueIssue = async (trigger: string, project: string, issueIid: number): Promise<Task> => {
    const event = createIssueEvent(issueIid);
    const task = await taskService.enqueue(
      trigger,
      { ...event, project: { ...event.project, path: project } },
      {
        kind: 'label',
        id: issueIid * 10,
        createdAt: new Date(),
        actor: 'ada',
      }
    );

    if (task === null) {
      throw new Error('The task was not queued');
    }

    return task;
  };

  /** Runs `task`'s current step to `outcome`, with `usage` for an agent step. */
  const runStep = async (task: Task, agent: typeof AGENT | null, outcome: RunOutcome) => {
    const run = await taskService.startRun(task, configId, agent);

    if (run === null) {
      throw new Error('The run did not start');
    }

    await taskService.recordReport(run, {
      exitCode: agent === null ? null : 0,
      result: agent === null ? 'Added workflow::review' : RESULT_LINE,
      error: null,
      ...(agent === null
        ? {}
        : {
            usage: {
              turns: 3,
              inputTokens: 10,
              outputTokens: 200,
              cacheReadTokens: 3000,
              cacheWriteTokens: 40,
              costUsd: 0.5,
            },
          }),
    });

    const next =
      outcome === RunOutcome.SUCCEEDED
        ? { status: TaskStatus.QUEUED as const, list: StepList.STEPS, step: task.step + 1, notBeforeDate: null }
        : { status: TaskStatus.FAILED as const };

    await taskService.finishRun(
      task,
      run,
      { outcome, error: outcome === RunOutcome.FAILED ? 'The agent exited with code 1' : null, deploymentFault: null },
      next
    );

    return run;
  };

  beforeAll(async () => {
    app = await bootstrapApp();
    taskService = app.get(TaskService);

    const admin = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
    token = await login(app, admin.email);

    sha = randomUUID().replaceAll('-', '');
    const [revision] = await dbQuery<{ id: number }>(
      app,
      `INSERT INTO config_revision (sha, status, errors, "seenDate") VALUES ($1, 'loaded', '[]', now()) RETURNING id`,
      [sha]
    );
    configId = revision.id;
  });

  describe('access', () => {
    const routes = [
      '/api/v1/admin/task/list?page=1',
      '/api/v1/admin/task/1',
      '/api/v1/admin/run/1',
      '/api/v1/admin/run/1/transcript',
    ];

    it.each(routes)('refuses a signed-out request to %s', async route => {
      await request(app.getHttpServer()).get(route).expect(401);
    });

    it.each(routes)('refuses a signed-in user without the system admin role at %s', async route => {
      const userAdmin = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });
      const userToken = await login(app, userAdmin.email);

      await request(app.getHttpServer())
        .get(route)
        .set({ Authorization: `Bearer ${userToken}` })
        .expect(403);
    });

    it.each(['post', 'patch', 'put', 'delete'] as const)('serves no %s on a task or a run', async method => {
      await request(app.getHttpServer())
        [method]('/api/v1/admin/task/1')
        .set({ Authorization: `Bearer ${token}` })
        .expect(404);
      await request(app.getHttpServer())
        [method]('/api/v1/admin/run/1')
        .set({ Authorization: `Bearer ${token}` })
        .expect(404);
    });
  });

  describe('task list', () => {
    it('lists every kind of task, newest first, with its run totals', async () => {
      const { trigger, project } = scope();

      const issueTask = await enqueueIssue(trigger, project, 1);
      await runStep(issueTask, null, RunOutcome.SUCCEEDED);
      await runStep(issueTask, AGENT, RunOutcome.FAILED);

      const scheduled = await taskService.enqueueScheduled({
        triggerName: trigger,
        sourceName: 'gitlab-int',
        projectPath: project,
        projectUrl: 'https://gitlab.test/group/project',
        fireTime: new Date(Date.UTC(2026, 0, 1)),
        cron: YEARLY_CRON,
      });
      const mergeRequest = await taskService.enqueueMergeRequest(trigger, createMergeRequestEvent(118, null));

      const response = await getTaskList(app, token, { trigger }).expect(200);

      expect(response.body).toMatchObject({ total: 3, pages: 1 });
      expect(response.body.taskList.map((task: { id: number }) => task.id)).toEqual([
        mergeRequest?.id,
        scheduled?.id,
        issueTask.id,
      ]);

      const [mergeRequestRow, scheduledRow, issueRow] = response.body.taskList;

      expect(mergeRequestRow).toMatchObject({
        kind: 'mergeRequest',
        issue: null,
        mergeRequest: { iid: 118 },
        runCount: 0,
      });
      expect(scheduledRow).toMatchObject({ kind: 'schedule', issue: null, mergeRequest: null, totalTokens: null });
      expect(issueRow).toMatchObject({
        kind: 'issue',
        status: TaskStatus.FAILED,
        issue: { iid: 1 },
        runCount: 2,
        totalTokens: 3250,
        costUsd: 0.5,
        configSha: sha,
      });
      expect(issueRow.startDate).not.toBeNull();
    });

    it('filters by status and by project', async () => {
      const { trigger, project } = scope();
      const other = scope();

      const failed = await enqueueIssue(trigger, project, 1);
      await runStep(failed, AGENT, RunOutcome.FAILED);
      const queued = await enqueueIssue(trigger, project, 2);
      await enqueueIssue(trigger, other.project, 3);

      const byStatus = await getTaskList(app, token, { trigger, status: TaskStatus.FAILED }).expect(200);
      const byProject = await getTaskList(app, token, { project }).expect(200);

      expect(byStatus.body.taskList.map((task: { id: number }) => task.id)).toEqual([failed.id]);
      expect(byProject.body.taskList.map((task: { id: number }) => task.id)).toEqual([queued.id, failed.id]);
    });

    it('pages at the configured page size', async () => {
      const { trigger, project } = scope();

      for (let issueIid = 1; issueIid <= 21; issueIid++) {
        await enqueueIssue(trigger, project, issueIid);
      }

      const first = await getTaskList(app, token, { trigger }).expect(200);
      const second = await getTaskList(app, token, { trigger, page: 2 }).expect(200);

      expect(first.body).toMatchObject({ total: 21, pages: 2 });
      expect(first.body.taskList).toHaveLength(20);
      expect(second.body.taskList.map((task: { issue: { iid: number } }) => task.issue.iid)).toEqual([1]);
    });

    it('refuses a status it does not know', async () => {
      await getTaskList(app, token, { status: 'paused' }).expect(400);
    });
  });

  describe('a task', () => {
    it('returns its runs in order and the issue as it matched', async () => {
      const { trigger, project } = scope();
      const task = await enqueueIssue(trigger, project, 1);
      const relabel = await runStep(task, null, RunOutcome.SUCCEEDED);
      const agent = await runStep(task, AGENT, RunOutcome.FAILED);

      const response = await getTask(app, token, task.id).expect(200);

      expect(response.body).toMatchObject({
        matchedIssue: { labels: ['workflow::in-progress'], author: 'ada', assignees: ['swarmfoundry-bot'] },
        change: { kind: 'label', actor: 'ada' },
      });
      expect(response.body.runs).toMatchObject([
        { id: relabel.id, step: 0, number: 1, agent: null, turns: null, endReason: RunEndReason.SUCCESS },
        {
          id: agent.id,
          step: 1,
          number: 1,
          outcome: RunOutcome.FAILED,
          endReason: RunEndReason.ERROR,
          exitCode: 0,
          configSha: sha,
          error: 'The agent exited with code 1',
          agent: AGENT,
          turns: 3,
          inputTokens: 10,
          outputTokens: 200,
          cacheReadTokens: 3000,
          cacheWriteTokens: 40,
          costUsd: 0.5,
        },
      ]);
    });

    it('refuses a task that does not exist', async () => {
      await getTask(app, token, 2147483647).expect(400);
    });
  });

  describe('a run and its transcript', () => {
    let runId: number;

    beforeAll(async () => {
      const { trigger, project } = scope();
      const task = await enqueueIssue(trigger, project, 1);
      const run = await runStep(task, AGENT, RunOutcome.FAILED);
      runId = run.id;

      await taskService.appendTranscriptLines(
        TRANSCRIPT.map((line, index) => new RunTranscriptLine({ runId, lineNumber: index + 1, line }))
      );
    });

    it('returns the run', async () => {
      const response = await getRun(app, token, runId).expect(200);

      expect(response.body).toMatchObject({ id: runId, agent: AGENT, endReason: RunEndReason.ERROR });
    });

    it('returns every stored line as typed events', async () => {
      const response = await getTranscript(app, token, runId).expect(200);

      expect(
        response.body.events.map((event: { type: string; lineNumber: number }) => [event.lineNumber, event.type])
      ).toEqual([
        [1, TranscriptEventType.SYSTEM_INIT],
        [2, TranscriptEventType.ASSISTANT_TEXT],
        [2, TranscriptEventType.TOOL_CALL],
        [3, TranscriptEventType.TOOL_RESULT],
        [4, TranscriptEventType.UNKNOWN],
        [5, TranscriptEventType.RESULT],
      ]);
      expect(response.body.events[3]).toMatchObject({ isError: true, parentToolUseId: null });
      expect(Date.parse(response.body.events[0].storedDate)).not.toBeNaN();
      expect(response.body).toMatchObject({ nextLine: 6, hasMore: false });
    });

    it('filters by type from a known line', async () => {
      const response = await getTranscript(app, token, runId, { fromLine: 3, types: 'toolCall,toolResult' }).expect(
        200
      );

      expect(response.body.events.map((event: { lineNumber: number }) => event.lineNumber)).toEqual([3]);
    });

    it("returns a static step's run with an empty transcript", async () => {
      const { trigger, project } = scope();
      const task = await enqueueIssue(trigger, project, 1);
      const relabel = await runStep(task, null, RunOutcome.SUCCEEDED);

      await getRun(app, token, relabel.id).expect(200);
      const response = await getTranscript(app, token, relabel.id).expect(200);

      expect(response.body).toEqual({ events: [], nextLine: 1, hasMore: false });
    });

    it('refuses a type it does not know and a run that does not exist', async () => {
      await getTranscript(app, token, runId, { types: 'thinking' }).expect(400);
      await getTranscript(app, token, 2147483647).expect(400);
    });
  });
});
