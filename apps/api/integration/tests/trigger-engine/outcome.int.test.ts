import { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { beforeAll, describe, expect, it } from 'vitest';

import { RunTranscriptLine } from '@/core/task/entities/run-transcript-line.entity';
import { Run } from '@/core/task/entities/run.entity';
import { Task } from '@/core/task/entities/task.entity';

import { ASSISTANT_LINES_READ } from '@/core/actions/agent-action.service';
import { TaskService } from '@/core/task/task.service';

import {
  BOT_USERNAME,
  CLEAN_EXIT,
  CLEAN_RESULT,
  createIssueEvent,
  createTestTrigger,
  DONE_LABEL,
  FAILED_LABEL,
  FakeIssueTracker,
  INFRASTRUCTURE_FAILURE,
  SOURCE_TOKEN,
  startTestEngine,
  TestAgentRunner,
  TRIGGER_LABEL,
} from '../../factories/trigger-engine.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import { RunEndReason, StepList } from '@/core/task/task.types';

interface ITaskRow {
  id: number;
  issueIid: number;
  status: string;
  queuedDate: Date;
  notBeforeDate: Date | null;
  endDate: Date | null;
  cancelReason: string | null;
}

interface IRunRow {
  id: number;
  taskId: number;
  issueIid: number;
  number: number;
  endDate: Date | null;
  exitCode: number | null;
  outcome: string | null;
  error: string | null;
  deploymentFault: string | null;
}

describe('Run outcomes, retries and recovery (integration)', () => {
  let app: NestExpressApplication;

  const tasksOf = (trigger: ITriggerConfig) =>
    dbQuery<ITaskRow>(
      app,
      `SELECT id, "issueIid", status, "queuedDate", "notBeforeDate", "endDate", "cancelReason"
       FROM task WHERE "triggerName" = $1 ORDER BY id`,
      [trigger.name]
    );

  const runsOf = (trigger: ITriggerConfig) =>
    dbQuery<IRunRow>(
      app,
      `SELECT r.id, r."taskId", t."issueIid", r.number, r."endDate", r."exitCode", r.outcome, r.error,
       r."deploymentFault" FROM run r JOIN task t ON t.id = r."taskId" WHERE t."triggerName" = $1 ORDER BY r.id`,
      [trigger.name]
    );

  const statusOf = async (trigger: ITriggerConfig, issueIid: number) =>
    (await tasksOf(trigger)).find(task => task.issueIid === issueIid)?.status;

  /** Moves a retry's backoff into the past, then wakes the queue. */
  const skipBackoff = async (trigger: ITriggerConfig, engine: { queue: { requestDispatch: () => Promise<void> } }) => {
    await dbQuery(app, `UPDATE task SET "notBeforeDate" = now() - interval '1 second' WHERE "triggerName" = $1`, [
      trigger.name,
    ]);
    await engine.queue.requestDispatch();
  };

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it('fails a run that exited 0 without moving the label at once, and reports it once', async () => {
    const trigger = createTestTrigger({ anyLabel: [DONE_LABEL] });
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    engine.runner.finish(1);
    await expect.poll(() => statusOf(trigger, 1)).toBe('failed');
    await engine.stop();

    expect(engine.runner.started).toEqual([1]);
    expect((await runsOf(trigger))[0]).toMatchObject({
      number: 1,
      exitCode: 0,
      outcome: 'failed',
      deploymentFault: null,
      error: `The run ended without the issue carrying ${DONE_LABEL}`,
    });

    expect(engine.tracker.labelsAdded).toEqual([{ issueIid: 1, label: FAILED_LABEL, token: SOURCE_TOKEN }]);
    expect(engine.tracker.comments).toHaveLength(1);
    expect(engine.tracker.comments[0].token).toBe(SOURCE_TOKEN);

    const [run] = await runsOf(trigger);
    expect(engine.tracker.comments[0].body).toContain('gave up on this issue after 1 run.');
    expect(engine.tracker.comments[0].body).toContain(`, task ${run.taskId})`);
  });

  it('records the issue as the trigger matched it, and the agent, usage and end reason of its run', async () => {
    const trigger = createTestTrigger();
    const engine = await startTestEngine(app, [trigger]);
    const usage = {
      turns: 12,
      inputTokens: 40,
      outputTokens: 3000,
      cacheReadTokens: 3_000_000_000,
      cacheWriteTokens: 25_000,
      costUsd: 1.234567,
    };

    await engine.emit(createIssueEvent(1, [10], [TRIGGER_LABEL, 'priority::high'], [BOT_USERNAME, 'ada']));
    engine.runner.finish(1, {
      exitCode: null,
      result: CLEAN_RESULT,
      error: 'Timed out after 1 minute, stopped with SIGINT',
      endReason: RunEndReason.TIMEOUT,
      usage,
    });
    await expect.poll(() => statusOf(trigger, 1)).toBe('failed');
    await engine.stop();

    const dataSource = app.get(DataSource);
    const task = await dataSource.getRepository(Task).findOneByOrFail({ triggerName: trigger.name });
    const run = await dataSource.getRepository(Run).findOneByOrFail({ taskId: task.id, list: StepList.STEPS });

    expect(task).toMatchObject({
      issueLabels: [TRIGGER_LABEL, 'priority::high'],
      issueAuthor: 'ada',
      issueAssignees: [BOT_USERNAME, 'ada'],
    });
    expect(run).toMatchObject({
      ...usage,
      agentName: 'claude',
      agentModel: 'claude-opus-5-5',
      agentAuth: 'oauth',
      endReason: RunEndReason.TIMEOUT,
    });
  });

  it('retries a run that failed for infrastructure after 5 minutes, keeping its place, as the next try', async () => {
    const trigger = createTestTrigger();
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    const [queued] = await tasksOf(trigger);

    engine.runner.finish(1, INFRASTRUCTURE_FAILURE);
    await expect.poll(() => statusOf(trigger, 1)).toBe('queued');

    const [retrying] = await tasksOf(trigger);
    expect(retrying.queuedDate).toEqual(queued.queuedDate);
    expect(retrying.notBeforeDate!.getTime()).toBeGreaterThan(Date.now() + 290_000);
    expect(retrying.notBeforeDate!.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);

    await skipBackoff(trigger, engine);
    expect(engine.runner.started).toEqual([1, 1]);

    engine.runner.finish(1, CLEAN_EXIT);
    await expect.poll(() => statusOf(trigger, 1)).toBe('succeeded');
    await engine.stop();

    expect(await runsOf(trigger)).toMatchObject([
      { number: 1, outcome: 'failed', deploymentFault: 'transient', error: 'Docker answered 500' },
      { number: 2, outcome: 'succeeded', deploymentFault: null },
    ]);
    expect(engine.tracker.comments).toEqual([]);
  });

  it('reports the try that failed the task for good, after a retry', async () => {
    const trigger = createTestTrigger();
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    engine.runner.finish(1, INFRASTRUCTURE_FAILURE);
    await expect.poll(() => statusOf(trigger, 1)).toBe('queued');
    await skipBackoff(trigger, engine);

    engine.runner.finish(1, { exitCode: 1, result: null, error: 'The agent exited with code 1' });
    await expect.poll(() => statusOf(trigger, 1)).toBe('failed');
    await engine.stop();

    const [, run] = await runsOf(trigger);
    expect(engine.tracker.comments).toHaveLength(1);
    expect(engine.tracker.comments[0].body).toContain('gave up on this issue after 2 runs.');
    expect(engine.tracker.comments[0].body).toContain(`, task ${run.taskId})`);
    expect(engine.tracker.comments[0].body).toContain('The agent exited with code 1');
    expect(engine.tracker.comments[0].body).not.toContain('Docker answered 500');
  });

  it("comments with the main agent's last text past any subagent's, and quotes no transcript line", async () => {
    const trigger = createTestTrigger();
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    const [run] = await runsOf(trigger);

    const quoted = JSON.stringify('{"type":"assistant","message":{"content":[{"type":"text","text":"Quoted."}]}}');
    const lines = [
      '{"type":"system","subtype":"init","session_id":"f3a1"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"The build needs a database."}]}}',
      `{"type":"user","message":{"content":[{"type":"tool_result","content":${quoted}}]}}`,
      ...Array.from(
        { length: ASSISTANT_LINES_READ + 5 },
        () =>
          '{"type":"assistant","message":{"content":[{"type":"text","text":"Subagent."}]},"parent_tool_use_id":"toolu_1"}'
      ),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]},"parent_tool_use_id":null}',
    ];

    await app
      .get(TaskService)
      .appendTranscriptLines(lines.map((line, i) => new RunTranscriptLine({ runId: run.id, lineNumber: i + 1, line })));

    engine.runner.finish(1, { exitCode: 1, result: null, error: 'The agent exited 1' });
    await expect.poll(() => statusOf(trigger, 1)).toBe('failed');
    await engine.stop();

    expect(engine.tracker.comments).toHaveLength(1);
    const [{ body }] = engine.tracker.comments;
    expect(body).toContain('## Final message\n\n```text\n The build needs a database.\n```');
    expect(body).not.toContain('Quoted.');
    expect(body).not.toContain('Subagent');
    expect(body).not.toContain('"type"');
  });

  it('succeeds once the issue gained the expected label', async () => {
    const trigger = createTestTrigger({ anyLabel: [DONE_LABEL] });
    const tracker = new FakeIssueTracker();
    const engine = await startTestEngine(app, [trigger], tracker);

    await engine.emit(createIssueEvent(1));
    tracker.setLabels(1, [DONE_LABEL]);
    engine.runner.finish(1, CLEAN_EXIT);

    await expect.poll(() => statusOf(trigger, 1)).toBe('succeeded');
    await engine.stop();

    expect(tracker.comments).toEqual([]);
  });

  it('retries a task of a trigger with anyAssignee once its agent has moved the label', async () => {
    const trigger = createTestTrigger({ anyAssignee: [BOT_USERNAME] });
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    engine.tracker.setLabels(1, ['workflow::todo']);
    engine.runner.finish(1, INFRASTRUCTURE_FAILURE);
    await expect.poll(() => statusOf(trigger, 1)).toBe('queued');
    await skipBackoff(trigger, engine);

    await expect.poll(() => engine.runner.started).toEqual([1, 1]);
    await engine.stop();

    expect(await runsOf(trigger)).toMatchObject([
      { number: 1, outcome: 'failed' },
      { number: 2, outcome: null },
    ]);
  });

  it('cancels a retry once the issue is closed', async () => {
    const trigger = createTestTrigger();
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    engine.tracker.issues.set(1, { open: false, labels: [TRIGGER_LABEL], assignees: [] });
    engine.runner.finish(1, INFRASTRUCTURE_FAILURE);
    await expect.poll(() => statusOf(trigger, 1)).toBe('queued');
    await skipBackoff(trigger, engine);

    await expect.poll(() => statusOf(trigger, 1)).toBe('cancelled');
    await engine.stop();

    expect(await tasksOf(trigger)).toMatchObject([{ cancelReason: 'The issue is closed' }]);
    expect(await runsOf(trigger)).toHaveLength(1);
    expect(engine.tracker.comments).toEqual([]);
  });

  it('cancels a queued task whose issue was closed before its first run', async () => {
    const trigger = createTestTrigger();
    const tracker = new FakeIssueTracker();
    tracker.issues.set(1, { open: false, labels: [TRIGGER_LABEL], assignees: [] });

    const engine = await startTestEngine(app, [trigger], tracker);
    await engine.emit(createIssueEvent(1));
    await engine.stop();

    expect(await tasksOf(trigger)).toMatchObject([{ status: 'cancelled', cancelReason: 'The issue is closed' }]);
    expect(await runsOf(trigger)).toEqual([]);
    expect(engine.runner.started).toEqual([]);
  });

  describe('restart recovery', () => {
    it('fails a run whose agent is gone for infrastructure, and retries its step', async () => {
      const trigger = createTestTrigger();

      const before = await startTestEngine(app, [trigger]);
      await before.emit(createIssueEvent(1));
      await before.stop();

      const after = await startTestEngine(app, [trigger]);

      await expect.poll(() => statusOf(trigger, 1)).toBe('queued');
      await skipBackoff(trigger, after);

      await expect.poll(() => after.runner.started).toEqual([1]);
      await after.stop();

      const [run1, run2] = await runsOf(trigger);
      expect(after.runner.resumed).toEqual([run1.id]);
      expect(after.runner.keptRunIds).toEqual([[run1.id]]);
      expect(run1).toMatchObject({
        outcome: 'failed',
        error: 'The agent container was gone',
        deploymentFault: 'transient',
      });
      expect(run2).toMatchObject({ number: 2, outcome: null });
      expect(await statusOf(trigger, 1)).toBe('running');
    });

    it('queues a task whose agent never started again, without spending a run', async () => {
      const trigger = createTestTrigger();

      const before = await startTestEngine(app, [trigger]);
      await before.emit(createIssueEvent(1));
      await before.stop();

      const [interrupted] = await runsOf(trigger);
      const runner = new TestAgentRunner();
      runner.resumeReport = { exitCode: null, result: null, error: 'gone', neverStarted: true };

      const after = await startTestEngine(app, [trigger], new FakeIssueTracker(), runner);

      await expect.poll(() => after.runner.started).toEqual([1]);
      await after.stop();

      expect(await statusOf(trigger, 1)).toBe('running');
      expect(await runsOf(trigger)).toMatchObject([{ number: 1, outcome: null }]);
      expect((await runsOf(trigger))[0].id).not.toBe(interrupted.id);
      expect(after.tracker.comments).toEqual([]);
    });

    it('fails the task for good when the resumed agent crashed', async () => {
      const trigger = createTestTrigger();

      const before = await startTestEngine(app, [trigger]);
      await before.emit(createIssueEvent(1));
      await before.stop();

      const runner = new TestAgentRunner();
      runner.resumeReport = { exitCode: 1, result: null, error: 'The agent exited with code 1' };

      const after = await startTestEngine(app, [trigger], new FakeIssueTracker(), runner);

      await expect.poll(() => statusOf(trigger, 1)).toBe('failed');
      await after.stop();

      expect(after.tracker.comments).toHaveLength(1);
      expect(after.tracker.comments[0].body).toContain('The agent exited with code 1');
      expect(after.tracker.comments[0].body).toContain('The agent left no final message.');
    });

    it('judges a run whose report was stored before the restart, without the runner', async () => {
      const trigger = createTestTrigger({ anyLabel: [DONE_LABEL] });

      const before = await startTestEngine(app, [trigger]);
      await before.emit(createIssueEvent(1));
      await before.stop();

      await dbQuery(
        app,
        `UPDATE run SET "endDate" = now(), "exitCode" = 0, result = $2
         WHERE "taskId" IN (SELECT id FROM task WHERE "triggerName" = $1)`,
        [trigger.name, CLEAN_EXIT.result]
      );

      const tracker = new FakeIssueTracker();
      tracker.setLabels(1, [DONE_LABEL]);

      const after = await startTestEngine(app, [trigger], tracker);

      await expect.poll(() => statusOf(trigger, 1)).toBe('succeeded');
      await after.stop();

      expect(after.runner.resumed).toEqual([]);
      expect(after.runner.keptRunIds).toEqual([[]]);
      expect(await runsOf(trigger)).toMatchObject([{ outcome: 'succeeded', exitCode: 0 }]);
    });

    it('keeps the task failed and records on its run why a failure step could not reach GitLab', async () => {
      const trigger = createTestTrigger();
      const engine = await startTestEngine(app, [trigger]);

      engine.tracker.comments.push = () => {
        throw new Error(`GitLab answered 500 for ${SOURCE_TOKEN}`);
      };

      await engine.emit(createIssueEvent(1));
      engine.runner.finish(1, { exitCode: 1, result: null, error: 'The agent exited with code 1' });

      await expect.poll(() => statusOf(trigger, 1)).toBe('failed');
      await engine.stop();

      expect(await runsOf(trigger)).toMatchObject([
        { outcome: 'failed', error: 'The agent exited with code 1' },
        {
          outcome: 'failed',
          error: expect.stringMatching(/^failureSteps\[0\] \(comment\) failed: GitLab answered 500/),
        },
      ]);
    });
  });
});
