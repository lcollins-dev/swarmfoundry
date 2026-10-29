import { NestExpressApplication } from '@nestjs/platform-express';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  assignBot,
  BOT_USERNAME,
  createIssueEvent,
  createTestTrigger,
  startTestEngine,
} from '../../factories/trigger-engine.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';

describe('Assignee triggers (integration)', () => {
  let app: NestExpressApplication;

  const tasksOf = (trigger: ITriggerConfig) =>
    dbQuery<{ issueIid: number; status: string; cancelReason: string | null }>(
      app,
      'SELECT "issueIid", status, "cancelReason" FROM task WHERE "triggerName" = $1 ORDER BY id',
      [trigger.name]
    );

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it('queues a new task when the bot is assigned again after a task for the same labels ran', async () => {
    const trigger = createTestTrigger({ anyAssignee: [BOT_USERNAME] });
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1, [10]));
    engine.runner.finish(1);
    await expect.poll(async () => (await tasksOf(trigger))[0]?.status).toBe('succeeded');

    // Unassigned and assigned again, as a poll sees it with both notes inside its window.
    const reassigned = assignBot(createIssueEvent(1, [10]), 500);
    await engine.emit(reassigned);
    await engine.emit(reassigned);
    engine.runner.finish(1);

    await expect
      .poll(() => tasksOf(trigger))
      .toEqual([
        { issueIid: 1, status: 'succeeded', cancelReason: null },
        { issueIid: 1, status: 'succeeded', cancelReason: null },
      ]);
    await engine.stop();

    expect(engine.runner.started).toEqual([1, 1]);
  });

  it('cancels a queued task once its issue is unassigned', async () => {
    const trigger = createTestTrigger({ anyAssignee: [BOT_USERNAME] });
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    await engine.emit(createIssueEvent(2));
    engine.tracker.setAssignees(2, ['ada']);
    engine.runner.finish(1);

    await expect
      .poll(() => tasksOf(trigger))
      .toEqual([
        { issueIid: 1, status: 'succeeded', cancelReason: null },
        { issueIid: 2, status: 'cancelled', cancelReason: `The issue is not assigned to ${BOT_USERNAME}` },
      ]);
    await engine.stop();

    expect(engine.runner.started).toEqual([1]);
  });
});
