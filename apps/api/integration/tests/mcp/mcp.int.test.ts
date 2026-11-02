import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { RunOutcome, TaskStatus, UserRoleId } from '@libs/dto';

import { RunTranscriptLine } from '@/core/task/entities/run-transcript-line.entity';
import type { Task } from '@/core/task/entities/task.entity';

import { TaskService } from '@/core/task/task.service';

import { createApiKey, issueApiKey, revokeApiKey } from '../../clients/api-key.client';
import { callTool, postMcp } from '../../clients/mcp.client';
import { login } from '../../clients/user.client';
import { createIssueEvent } from '../../factories/trigger-engine.factory';
import { createTestUser } from '../../factories/user.factory';
import { bootstrapApp } from '../../setup';
import { authHeaders } from '../../utils/auth';
import { dbQuery } from '../../utils/db';

const text = (value: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: value }] } });

const bash = (command: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `toolu_${randomUUID()}`, name: 'Bash', input: { command } }] },
  });

const toolResult = (content: string) =>
  `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_long","content":${JSON.stringify(content)}}]}}`;

describe('MCP server (integration)', () => {
  let app: NestExpressApplication;
  let taskService: TaskService;
  let jwt: string;
  let key: string;

  // No other suite writes it, so a date range search finds only this suite's lines.
  const marker = `mk${randomUUID().replaceAll('-', '')}`;
  const trigger = `int-${randomUUID()}`;

  const deepMarker = `deep${randomUUID().replaceAll('-', '')}`;
  const otherMarker = `other${randomUUID().replaceAll('-', '')}`;
  const otherTrigger = `int-${randomUUID()}`;
  const plainMarker = `plain${randomUUID().replaceAll('-', '')}`;

  let firstTask: Task;
  let firstRunId: number;
  let secondRunId: number;
  let longRunId: number;
  let earlierRunId: number;
  let laterRunId: number;
  let plainRunId: number;

  const enqueue = async (iid: number, triggerName = trigger): Promise<Task> => {
    const event = createIssueEvent(iid);
    const task = await taskService.enqueue(
      triggerName,
      { ...event, project: { ...event.project, path: `group/${randomUUID()}` } },
      { kind: 'label', id: iid, createdAt: new Date(), actor: 'ada' }
    );

    if (task === null) {
      throw new Error('The task was not created');
    }

    return task;
  };

  const runWith = async (task: Task, lines: string[]): Promise<number> => {
    const run = await taskService.startRun(task, null, null);

    if (run === null) {
      throw new Error('The run was not created');
    }

    await taskService.appendTranscriptLines(
      lines.map((line, index) => new RunTranscriptLine({ runId: run.id, lineNumber: index + 1, line }))
    );
    await taskService.finishRun(
      task,
      run,
      { outcome: RunOutcome.FAILED, error: 'Stopped', deploymentFault: null },
      { status: TaskStatus.FAILED }
    );

    return run.id;
  };

  beforeAll(async () => {
    app = await bootstrapApp();
    taskService = app.get(TaskService);

    const admin = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
    jwt = await login(app, admin.email);
    key = await issueApiKey(app, jwt);

    firstTask = await enqueue(1);
    firstRunId = await runWith(firstTask, [
      text(`Reading ${marker} first`),
      bash(`grep ${marker} "src"`),
      text(`Saved 50% on ${marker}`),
      text(`Saved 50 percent on ${marker}`),
    ]);

    secondRunId = await runWith(await enqueue(2), [text(`Second ${marker}`), text('Nothing here')]);

    longRunId = await runWith(await enqueue(3), [
      text('Before the long result'),
      toolResult(`${'x'.repeat(2500)}${deepMarker}${'y'.repeat(500)}`),
      text('After the long result'),
    ]);

    // Under another trigger, one started three hours ago, to scope by trigger and by a date range's end.
    earlierRunId = await runWith(await enqueue(4, otherTrigger), [text(`Earlier ${otherMarker}`)]);
    laterRunId = await runWith(await enqueue(5, otherTrigger), [text(`Later ${otherMarker}`)]);

    await dbQuery(app, `UPDATE "run" SET "startDate" = now() - interval '3 hours' WHERE id = $1`, [earlierRunId]);

    plainRunId = await runWith(await enqueue(6, otherTrigger), [`error: "${plainMarker}"`]);
  });

  describe('authenticating', () => {
    const initialize = (token: string | null) =>
      postMcp(app, token, {
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'int', version: '1' } },
      });

    it('initializes with a personal API key, and lists only read-only tools', async () => {
      const init = await initialize(key).expect(200);

      expect(init.body.result.serverInfo.name).toBe('swarmfoundry');

      const list = await postMcp(app, key, { method: 'tools/list' }).expect(200);
      const tools: { name: string; annotations: { readOnlyHint: boolean } }[] = list.body.result.tools;

      expect(tools.map(tool => tool.name).sort()).toEqual([
        'get_event',
        'get_run',
        'get_task',
        'get_transcript',
        'list_tasks',
        'search_transcripts',
      ]);
      expect(tools.every(tool => tool.annotations.readOnlyHint)).toBe(true);
    });

    it('refuses a missing, invalid or revoked key with 401', async () => {
      const created = await createApiKey(app, jwt, { name: 'Revoked' }).expect(201);
      await revokeApiKey(app, jwt, created.body.apiKey.id).expect(200);

      await initialize(null).expect(401);
      await initialize(`${key.slice(0, key.lastIndexOf('_') + 1)}${'A'.repeat(43)}`).expect(401);
      await initialize(created.body.token).expect(401);
    });

    it("refuses a key whose owner isn't a system admin with 403", async () => {
      const owner = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
      const ownerKey = await issueApiKey(app, await login(app, owner.email));

      await dbQuery(app, 'DELETE FROM "user_user_role" WHERE "userId" = $1', [owner.id]);

      await initialize(ownerKey).expect(403);
    });

    it('refuses a GET or DELETE, since the server is stateless', async () => {
      await request(app.getHttpServer()).get('/mcp').set(authHeaders(key)).expect(405);
      await request(app.getHttpServer()).delete('/mcp').set(authHeaders(key)).expect(405);
    });
  });

  describe('reading', () => {
    it('answers list_tasks and get_task as the read API does', async () => {
      const listed = await callTool(app, key, 'list_tasks', { trigger });
      const rest = await request(app.getHttpServer())
        .get(`/api/v1/admin/task/list?page=1&trigger=${trigger}`)
        .set(authHeaders(jwt))
        .expect(200);

      expect(listed.result).toEqual(rest.body);
      expect(listed.result.total).toBe(3);

      const task = await callTool(app, key, 'get_task', { taskId: firstTask.id });

      expect(task.result.runs.map((run: { id: number }) => run.id)).toEqual([firstRunId]);
      expect(await callTool(app, key, 'get_task', { taskId: 2147483647 })).toEqual({
        error: "This task doesn't exist.",
      });
    });

    it('filters list_tasks by project as the read API does', async () => {
      const listed = await callTool(app, key, 'list_tasks', { project: firstTask.projectPath.toUpperCase() });
      const rest = await request(app.getHttpServer())
        .get(`/api/v1/admin/task/list?page=1&project=${firstTask.projectPath}`)
        .set(authHeaders(jwt))
        .expect(200);

      expect(listed.result).toEqual(rest.body);
      expect(listed.result.taskList.map((task: { id: number }) => task.id)).toEqual([firstTask.id]);
    });

    it('cuts a long field on a page, and reads it on with get_event', async () => {
      const page = await callTool(app, key, 'get_transcript', { runId: longRunId, types: ['toolResult'] });
      const [event] = page.result.events;

      expect(event.content).toBe('x'.repeat(2000));
      expect(event.truncated).toEqual([
        { field: 'content', from: 0, to: 2000, length: 2500 + deepMarker.length + 500 },
      ]);

      const rest = await callTool(app, key, 'get_event', { runId: longRunId, lineNumber: 2, offset: 2500 });

      expect(rest.result.content).toBe(`${deepMarker}${'y'.repeat(500)}`);
      expect(rest.result.truncated).toEqual([
        { field: 'content', from: 2500, to: 2500 + deepMarker.length + 500, length: 2500 + deepMarker.length + 500 },
      ]);
      expect((await callTool(app, key, 'get_event', { runId: longRunId, lineNumber: 2, index: 1 })).error).toMatch(
        /doesn't exist/
      );
    });

    it('pages a transcript, filtered by type', async () => {
      const page = await callTool(app, key, 'get_transcript', { runId: firstRunId, limit: 2 });

      expect(page.result).toMatchObject({ firstLine: 1, nextLine: 3, hasMore: true });

      const calls = await callTool(app, key, 'get_transcript', { runId: firstRunId, types: ['toolCall'] });

      expect(calls.result.events).toEqual([expect.objectContaining({ type: 'toolCall', lineNumber: 2 })]);
    });
  });

  describe('search_transcripts', () => {
    const lineNumbers = (result: { runs: { run: { id: number }; events: { lineNumber: number }[] }[] }) =>
      result.runs.map(({ run, events }) => [run.id, events.map(event => event.lineNumber)]);

    it('refuses a search with no scope, or a date range alone over 30 days', async () => {
      expect((await callTool(app, key, 'search_transcripts', { query: marker })).error).toMatch(/task, a trigger/);
      expect(
        (await callTool(app, key, 'search_transcripts', { query: marker, since: '2026-01-01', until: '2026-03-01' }))
          .error
      ).toMatch(/30 days/);
    });

    it("finds the events whose own text matches in any case, newest run first, with the run's trigger", async () => {
      const { result } = await callTool(app, key, 'search_transcripts', { query: marker.toUpperCase(), trigger });

      expect(lineNumbers(result)).toEqual([
        [secondRunId, [1]],
        [firstRunId, [1, 2, 3, 4]],
      ]);
      expect(result.runs[0].triggerName).toBe(trigger);
      expect(result.cursor).toBeNull();
    });

    it('scopes to a task, and to runs started within a date range', async () => {
      const byTask = await callTool(app, key, 'search_transcripts', { query: marker, taskId: firstTask.id });

      expect(lineNumbers(byTask.result)).toEqual([[firstRunId, [1, 2, 3, 4]]]);

      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recent = await callTool(app, key, 'search_transcripts', { query: marker, since });

      expect(lineNumbers(recent.result)).toEqual([
        [secondRunId, [1]],
        [firstRunId, [1, 2, 3, 4]],
      ]);

      const future = await callTool(app, key, 'search_transcripts', {
        query: marker,
        since: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        until: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      });

      expect(future.result.runs).toEqual([]);
    });

    it("matches a wildcard literally, and never the line's JSON around an event", async () => {
      const percent = await callTool(app, key, 'search_transcripts', { query: `50% on ${marker}`, trigger });

      expect(lineNumbers(percent.result)).toEqual([[firstRunId, [3]]]);

      const quoted = await callTool(app, key, 'search_transcripts', { query: `${marker} "src"`, trigger });

      expect(lineNumbers(quoted.result)).toEqual([[firstRunId, [2]]]);

      const blockType = await callTool(app, key, 'search_transcripts', { query: 'tool_use', taskId: firstTask.id });

      expect(blockType.result.runs).toEqual([]);
    });

    it('scopes to a trigger, leaving out matching runs under another', async () => {
      const inTrigger = await callTool(app, key, 'search_transcripts', { query: otherMarker, trigger });
      const inOther = await callTool(app, key, 'search_transcripts', { query: otherMarker, trigger: otherTrigger });

      expect(inTrigger.result.runs).toEqual([]);
      expect(lineNumbers(inOther.result)).toEqual([
        [laterRunId, [1]],
        [earlierRunId, [1]],
      ]);
    });

    it('ends a date range before until', async () => {
      const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const { result } = await callTool(app, key, 'search_transcripts', {
        query: otherMarker,
        since: hoursAgo(4),
        until: hoursAgo(2),
      });

      expect(lineNumbers(result)).toEqual([[earlierRunId, [1]]]);
    });

    it('finds a quoted query in a line stored as plain text', async () => {
      const { result } = await callTool(app, key, 'search_transcripts', {
        query: `"${plainMarker}"`,
        runId: plainRunId,
      });

      expect(result.runs[0].events).toEqual([
        expect.objectContaining({ type: 'unknown', lineNumber: 1, raw: `error: "${plainMarker}"`, match: true }),
      ]);
    });

    it('scopes to a run', async () => {
      const { result } = await callTool(app, key, 'search_transcripts', { query: marker, runId: secondRunId });

      expect(lineNumbers(result)).toEqual([[secondRunId, [1]]]);
    });

    it('lists only the matching runs, with their match counts', async () => {
      const { result } = await callTool(app, key, 'search_transcripts', { query: marker, trigger, output: 'runs' });

      expect(
        result.runs.map((run: { run: { id: number }; matchCount: number }) => [run.run.id, run.matchCount])
      ).toEqual([
        [secondRunId, 1],
        [firstRunId, 4],
      ]);
    });

    it('adds the lines around a match, and cuts a long match around it', async () => {
      const { result } = await callTool(app, key, 'search_transcripts', {
        query: deepMarker,
        runId: longRunId,
        context: 1,
      });
      const events: { lineNumber: number; match: boolean; content?: string }[] = result.runs[0].events;

      expect(events.map(event => [event.lineNumber, event.match])).toEqual([
        [1, false],
        [2, true],
        [3, false],
      ]);
      expect(events[1].content?.startsWith(`${'x'.repeat(200)}${deepMarker}`)).toBe(true);
    });

    it('pages with the cursor until no match is left', async () => {
      const first = await callTool(app, key, 'search_transcripts', { query: marker, trigger, limit: 3 });

      expect(lineNumbers(first.result)).toEqual([
        [secondRunId, [1]],
        [firstRunId, [1, 2]],
      ]);

      const second = await callTool(app, key, 'search_transcripts', {
        query: marker,
        trigger,
        limit: 3,
        cursor: first.result.cursor,
      });

      expect(lineNumbers(second.result)).toEqual([[firstRunId, [3, 4]]]);
      expect(second.result.cursor).toBeNull();
    });
  });
});
