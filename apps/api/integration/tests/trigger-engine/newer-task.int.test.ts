import { NestExpressApplication } from '@nestjs/platform-express';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  assignBot,
  BOT_USERNAME,
  clearFlag,
  createIssueEvent,
  createTestTrigger,
  INFRASTRUCTURE_FAILURE,
  startTestEngine,
} from '../../factories/trigger-engine.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';

interface ITaskRow {
  id: number;
  issueIid: number;
  changeKind: string;
  changeId: string;
  status: string;
  cancelReason: string | null;
  runs: number;
}

describe('Tasks superseded by a newer task for the same issue (integration)', () => {
  let app: NestExpressApplication;

  const tasksOf = (trigger: ITriggerConfig) =>
    dbQuery<ITaskRow>(
      app,
      `SELECT t.id, t."issueIid", t."changeKind", t."changeId", t.status, t."cancelReason",
         (SELECT count(*)::int FROM run r WHERE r."taskId" = t.id) AS runs
       FROM task t WHERE t."triggerName" = $1 ORDER BY t.id`,
      [trigger.name]
    );

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it('cancels a pending retry once the label is added again, and runs only the new task', async () => {
    const trigger = createTestTrigger({ concurrency: 2, anyAssignee: [BOT_USERNAME] });
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1, [10]));
    engine.runner.finish(1, INFRASTRUCTURE_FAILURE);
    await expect.poll(async () => (await tasksOf(trigger))[0].status).toBe('queued');

    // The label is removed and added again within the retry's backoff.
    await engine.emit(createIssueEvent(1, [10, 20]));
    expect(engine.runner.started).toEqual([1, 1]);

    await dbQuery(app, `UPDATE task SET "notBeforeDate" = now() - interval '1 second' WHERE "triggerName" = $1`, [
      trigger.name,
    ]);
    await engine.queue.requestDispatch();

    const [stale, fresh] = await tasksOf(trigger);

    expect(stale).toMatchObject({
      changeId: '10',
      status: 'cancelled',
      cancelReason: `Task ${fresh.id} was queued for a later change on the issue`,
      runs: 1,
    });
    expect(fresh).toMatchObject({ changeId: '20', status: 'running', cancelReason: null, runs: 1 });
    expect(engine.runner.started).toEqual([1, 1]);

    engine.runner.finish(1);
    await expect.poll(async () => (await tasksOf(trigger))[1].status).toBe('succeeded');
    await engine.stop();

    expect(engine.tracker.comments).toEqual([]);
    expect(engine.tracker.labelsAdded).toEqual([]);
  });

  it('cancels a queued first run once a newer task for the same issue is queued behind it', async () => {
    const trigger = createTestTrigger(1);
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(2));
    await engine.emit(createIssueEvent(1, [10]));
    await engine.emit(createIssueEvent(1, [10, 20]));

    engine.runner.finish(2);
    await expect.poll(() => engine.runner.started).toEqual([2, 1]);
    await engine.stop();

    const [, older, newer] = await tasksOf(trigger);

    expect(older).toMatchObject({
      status: 'cancelled',
      cancelReason: `Task ${newer.id} was queued for a later change on the issue`,
      runs: 0,
    });
    expect(newer).toMatchObject({ changeId: '20', runs: 1 });
  });

  it('cancels a queued first run once a notLabels flag is cleared on the issue', async () => {
    const trigger = createTestTrigger(1);
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(2));
    await engine.emit(createIssueEvent(1, [10]));
    await engine.emit(clearFlag(createIssueEvent(1, [10]), 15, 20));

    engine.runner.finish(2);
    await expect.poll(() => engine.runner.started).toEqual([2, 1]);
    await engine.stop();

    const [, older, newer] = await tasksOf(trigger);

    expect(older).toMatchObject({
      status: 'cancelled',
      cancelReason: `Task ${newer.id} was queued for a later change on the issue`,
      runs: 0,
    });
    expect(newer).toMatchObject({ changeId: '20', runs: 1 });
  });

  it('orders tasks by the time of their change across kinds, not by id', async () => {
    const trigger = createTestTrigger({ anyAssignee: [BOT_USERNAME] });
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(2));
    await engine.emit(createIssueEvent(1, [10]));
    // GitLab numbers notes apart from label events, so a later assignment can carry a lower id.
    await engine.emit(assignBot(createIssueEvent(1, [10]), 5));

    engine.runner.finish(2);
    await expect.poll(() => engine.runner.started).toEqual([2, 1]);
    await engine.stop();

    const [, older, newer] = await tasksOf(trigger);

    expect(older).toMatchObject({
      changeKind: 'label',
      changeId: '10',
      status: 'cancelled',
      cancelReason: `Task ${newer.id} was queued for a later change on the issue`,
    });
    expect(newer).toMatchObject({ changeKind: 'assignment', changeId: '5', runs: 1 });
  });

  it('breaks a tie on time between kinds as the match does, so the label task the match chose runs', async () => {
    const trigger = createTestTrigger({ anyAssignee: [BOT_USERNAME] });
    const engine = await startTestEngine(app, [trigger]);
    const sameTime = new Date(Date.UTC(2026, 9, 14, 10));

    await engine.emit(createIssueEvent(2));
    // The poll that saw the assignment had yet to see the label event GitLab wrote at the same time.
    await engine.emit(assignBot(createIssueEvent(1, []), 5, sameTime));
    await engine.emit(assignBot(createIssueEvent(1, [10]), 5, sameTime));

    engine.runner.finish(2);
    await expect.poll(() => engine.runner.started).toEqual([2, 1]);
    await engine.stop();

    const [, assignment, label] = await tasksOf(trigger);

    expect(assignment).toMatchObject({
      changeKind: 'assignment',
      status: 'cancelled',
      cancelReason: `Task ${label.id} was queued for a later change on the issue`,
    });
    expect(label).toMatchObject({ changeKind: 'label', changeId: '10', runs: 1 });
  });
});
