import { NestExpressApplication } from '@nestjs/platform-express';
import { beforeAll, describe, expect, it } from 'vitest';

import { createIssueEvent, createTestTrigger, startTestEngine } from '../../factories/trigger-engine.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';

describe('Task queue (integration)', () => {
  let app: NestExpressApplication;

  const statusesOf = async (trigger: ITriggerConfig): Promise<Record<number, string>> => {
    const tasks = await dbQuery<{ issueIid: number; status: string }>(
      app,
      'SELECT "issueIid", status FROM task WHERE "triggerName" = $1',
      [trigger.name]
    );

    return Object.fromEntries(tasks.map(task => [task.issueIid, task.status]));
  };

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it('runs no more tasks than concurrency at once, and starts the rest in arrival order', async () => {
    const trigger = createTestTrigger(2);
    const engine = await startTestEngine(app, [trigger]);

    for (const issueIid of [1, 2, 3, 4]) {
      await engine.emit(createIssueEvent(issueIid));
    }

    expect(engine.runner.started).toEqual([1, 2]);
    expect(await statusesOf(trigger)).toEqual({ 1: 'running', 2: 'running', 3: 'queued', 4: 'queued' });

    engine.runner.finish(2);
    await expect.poll(() => engine.runner.started).toEqual([1, 2, 3]);

    engine.runner.finish(1);
    await expect.poll(() => engine.runner.started).toEqual([1, 2, 3, 4]);

    await engine.stop();

    expect(await statusesOf(trigger)).toMatchObject({ 1: 'succeeded', 2: 'succeeded' });
  });

  it('keeps the queue across a restart, where recovery frees the slot of a run whose agent is gone', async () => {
    const trigger = createTestTrigger(1);

    const before = await startTestEngine(app, [trigger]);

    for (const issueIid of [1, 2, 3]) {
      await before.emit(createIssueEvent(issueIid));
    }

    await before.stop();

    expect(await statusesOf(trigger)).toEqual({ 1: 'running', 2: 'queued', 3: 'queued' });

    const after = await startTestEngine(app, [trigger]);

    // The gone agent failed for infrastructure, so its task waits for a retry and holds no slot.
    await expect.poll(() => statusesOf(trigger)).toEqual({ 1: 'queued', 2: 'running', 3: 'queued' });
    expect(after.runner.resumed).toHaveLength(1);
    expect(after.runner.started).toEqual([2]);

    after.runner.finish(2);
    await expect.poll(() => after.runner.started).toEqual([2, 3]);

    await after.stop();
  });

  it('starts tasks a restart left queued without waiting for a new event', async () => {
    const trigger = createTestTrigger(1);

    const before = await startTestEngine(app, [trigger]);
    await before.emit(createIssueEvent(1));
    await before.emit(createIssueEvent(2));

    before.runner.finish(1);
    await expect.poll(() => before.runner.started).toEqual([1, 2]);

    await before.stop();

    await dbQuery(app, `UPDATE task SET status = 'queued' WHERE "triggerName" = $1 AND "issueIid" = 2`, [trigger.name]);

    const after = await startTestEngine(app, [trigger]);

    await expect.poll(() => after.runner.started).toEqual([2]);

    await after.stop();
  });

  it('records a finished run against its task', async () => {
    const trigger = createTestTrigger(1);
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    engine.runner.finish(1);
    await expect.poll(() => statusesOf(trigger)).toEqual({ 1: 'succeeded' });
    await engine.stop();

    const runs = await dbQuery<{ number: number; exitCode: number; outcome: string }>(
      app,
      `SELECT r.number, r."exitCode", r.outcome FROM run r JOIN task t ON t.id = r."taskId"
       WHERE t."triggerName" = $1`,
      [trigger.name]
    );

    expect(runs).toEqual([{ number: 1, exitCode: 0, outcome: 'succeeded' }]);
  });
});
