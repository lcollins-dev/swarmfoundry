import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { ConfigRevisionService } from '@/core/foundry-config/config-revision.service';

import {
  createIssueEvent,
  createTestTrigger,
  FakeFoundryConfig,
  FakeIssueTracker,
  INFRASTRUCTURE_FAILURE,
  startTestEngine,
  TestAgentRunner,
} from '../../factories/trigger-engine.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';

describe('Config revision pinning (integration)', () => {
  let app: NestExpressApplication;

  const taskOf = async (trigger: ITriggerConfig) => {
    const [task] = await dbQuery<{ status: string; configId: number | null }>(
      app,
      'SELECT status, "configId" FROM task WHERE "triggerName" = $1',
      [trigger.name]
    );

    return task;
  };

  const runsOf = (trigger: ITriggerConfig) =>
    dbQuery<{ number: number; configId: number | null; error: string | null }>(
      app,
      `SELECT r.number, r."configId", r.error FROM run r JOIN task t ON t.id = r."taskId"
       WHERE t."triggerName" = $1 ORDER BY r.number`,
      [trigger.name]
    );

  /** A `config_revision` row, which a task's and a run's `configId` must reference. */
  const newRevision = (): Promise<number> =>
    app.get(ConfigRevisionService).recordLoad(randomBytes(20).toString('hex'), []);

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it('runs every retry on the revision its first run started on, and stores that revision on each run', async () => {
    const first = createTestTrigger();
    const second = { ...first };
    const [configA, configB] = [await newRevision(), await newRevision()];

    const config = new FakeFoundryConfig([first]);
    config.swap(configA, [first]);

    const engine = await startTestEngine(app, [first], new FakeIssueTracker(), new TestAgentRunner(), config);
    await engine.emit(createIssueEvent(1));

    config.swap(configB, [second]);
    engine.runner.finish(1, INFRASTRUCTURE_FAILURE);
    await expect.poll(async () => (await taskOf(first)).status).toBe('queued');
    await dbQuery(app, `UPDATE task SET "notBeforeDate" = now() - interval '1 second' WHERE "triggerName" = $1`, [
      first.name,
    ]);
    await engine.queue.requestDispatch();

    await expect.poll(() => engine.runner.started).toEqual([1, 1]);
    await engine.stop();

    expect(engine.runner.triggers[1]).toBe(first);
    expect(await taskOf(first)).toMatchObject({ configId: configA });
    expect(await runsOf(first)).toMatchObject([
      { number: 1, configId: configA },
      { number: 2, configId: configA },
    ]);
  });

  it('refuses to delete a revision a task or run references, and to reference a revision with no row', async () => {
    const trigger = createTestTrigger();
    const configId = await newRevision();

    const config = new FakeFoundryConfig([trigger]);
    config.swap(configId, [trigger]);

    const engine = await startTestEngine(app, [trigger], new FakeIssueTracker(), new TestAgentRunner(), config);
    await engine.emit(createIssueEvent(1));
    engine.runner.finish(1);
    await expect.poll(async () => (await taskOf(trigger)).status).toBe('succeeded');
    await engine.stop();

    await expect(dbQuery(app, 'DELETE FROM config_revision WHERE id = $1', [configId])).rejects.toThrow(
      /FK_task_config_revision|FK_run_config_revision/
    );
    await expect(dbQuery(app, 'UPDATE run SET "configId" = -1 WHERE "configId" = $1', [configId])).rejects.toThrow(
      /FK_run_config_revision/
    );
  });

  it('loads the revision a running task is pinned to after a restart, and resumes the task on it', async () => {
    const first = createTestTrigger();
    const second = { ...first };
    const [configA, configB] = [await newRevision(), await newRevision()];

    const before = new FakeFoundryConfig([first]);
    before.swap(configA, [first]);

    const engine = await startTestEngine(app, [first], new FakeIssueTracker(), new TestAgentRunner(), before);
    await engine.emit(createIssueEvent(1));
    await engine.stop();

    const after = new FakeFoundryConfig([second]);
    after.swap(configB, [second]);
    after.clone.set(configA, [first]);

    const restarted = await startTestEngine(app, [second], new FakeIssueTracker(), new TestAgentRunner(), after);

    await expect.poll(() => restarted.runner.resumed).toHaveLength(1);
    await restarted.stop();

    expect(restarted.runner.triggers).toHaveLength(1);
    expect(restarted.runner.triggers[0]).toBe(first);
  });

  it('fails the run of a pinned revision that no longer loads after a restart, running no failureSteps', async () => {
    const first = createTestTrigger();
    const [configA, configB] = [await newRevision(), await newRevision()];

    const before = new FakeFoundryConfig([first]);
    before.swap(configA, [first]);

    const engine = await startTestEngine(app, [first], new FakeIssueTracker(), new TestAgentRunner(), before);
    await engine.emit(createIssueEvent(1));
    await engine.stop();

    const after = new FakeFoundryConfig([{ ...first }]);
    after.swap(configB, after.triggers);

    const tracker = new FakeIssueTracker();
    const restarted = await startTestEngine(app, after.triggers, tracker, new TestAgentRunner(), after);

    await expect.poll(async () => (await taskOf(first)).status).toBe('failed');
    await restarted.stop();

    expect(restarted.runner.resumed).toEqual([]);
    expect(await runsOf(first)).toEqual([
      {
        number: 1,
        configId: configA,
        error: `The config revision the task is pinned to, config_revision ${configA}, does not load`,
      },
    ]);
    expect(tracker.labelsAdded).toEqual([]);
  });
});
