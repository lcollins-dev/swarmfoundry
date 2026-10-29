import { NestExpressApplication } from '@nestjs/platform-express';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  assignBot,
  BOT_USERNAME,
  clearFlag,
  createIssueEvent,
  createTestTrigger,
  startTestEngine,
} from '../../factories/trigger-engine.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';

describe('Trigger dedup (integration)', () => {
  let app: NestExpressApplication;

  const tasksOf = (trigger: ITriggerConfig) =>
    dbQuery<{ issueIid: number; changeKind: string; changeId: string; status: string }>(
      app,
      'SELECT "issueIid", "changeKind", "changeId", status FROM task WHERE "triggerName" = $1 ORDER BY id',
      [trigger.name]
    );

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it('queues exactly one task when two polls see the same label', async () => {
    const trigger = createTestTrigger();
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    await engine.emit(createIssueEvent(1));
    await engine.stop();

    expect(await tasksOf(trigger)).toHaveLength(1);
  });

  it('starts no duplicate task when a restart replays the events', async () => {
    const trigger = createTestTrigger();

    const before = await startTestEngine(app, [trigger]);
    await before.emit(createIssueEvent(1));
    await before.stop();

    const after = await startTestEngine(app, [trigger]);
    await after.emit(createIssueEvent(1));
    await after.stop();

    expect(await tasksOf(trigger)).toHaveLength(1);
    expect(after.runner.started).toEqual([]);
  });

  it('queues one task when two processes insert the same change at once', async () => {
    const trigger = createTestTrigger();
    const [first, second] = await Promise.all([startTestEngine(app, [trigger]), startTestEngine(app, [trigger])]);

    await Promise.all([first.emit(createIssueEvent(1)), second.emit(createIssueEvent(1))]);
    await Promise.all([first.stop(), second.stop()]);

    expect(await tasksOf(trigger)).toHaveLength(1);
  });

  it('queues a new task when the label is removed and added again', async () => {
    const trigger = createTestTrigger(2);
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1, [100]));
    await engine.emit(createIssueEvent(1, [100, 101]));
    await engine.stop();

    expect((await tasksOf(trigger)).map(task => Number(task.changeId))).toEqual([100, 101]);
  });

  it('queues one task when a notLabels flag is cleared, and none when a poll sees the removal again', async () => {
    const trigger = createTestTrigger(2);
    const engine = await startTestEngine(app, [trigger]);

    const cleared = clearFlag(createIssueEvent(1, [100]), 101, 102);

    await engine.emit(createIssueEvent(1, [100]));
    await engine.emit(cleared);
    await engine.emit(cleared);
    await engine.stop();

    expect((await tasksOf(trigger)).map(task => Number(task.changeId))).toEqual([100, 102]);
  });

  it('queues one task for a note id and a label event id that are the same number', async () => {
    const trigger = createTestTrigger({ anyAssignee: [BOT_USERNAME] });
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1, [100]));
    await engine.emit(assignBot(createIssueEvent(1, [100]), 100));
    await engine.emit(assignBot(createIssueEvent(1, [100]), 100));
    await engine.stop();

    expect((await tasksOf(trigger)).map(task => [task.changeKind, Number(task.changeId)])).toEqual([
      ['label', 100],
      ['assignment', 100],
    ]);
  });

  it('keeps each trigger its own task for the same change', async () => {
    const triggers = [createTestTrigger(), createTestTrigger()];
    const engine = await startTestEngine(app, triggers);

    await engine.emit(createIssueEvent(1));
    await engine.stop();

    expect(await tasksOf(triggers[0])).toHaveLength(1);
    expect(await tasksOf(triggers[1])).toHaveLength(1);
  });
});
