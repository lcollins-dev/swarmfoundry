import { NestExpressApplication } from '@nestjs/platform-express';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLEAN_EXIT,
  createIssueEvent,
  createTestTrigger,
  FakeIssueTracker,
  INFRASTRUCTURE_FAILURE,
  startTestEngine,
  TestAgentRunner,
} from '../../factories/trigger-engine.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';
import type { IAgentStepConfig, ITriggerConfig } from '@/core/foundry-config/foundry-config.types';

interface ITaskRow {
  issueIid: number;
  status: string;
  step: number;
}

interface IRunRow {
  id: number;
  number: number;
  step: number;
  endDate: Date | null;
  outcome: string | null;
  deploymentFault: string | null;
}

describe('Trigger steps (integration)', () => {
  let app: NestExpressApplication;

  const tasksOf = (trigger: ITriggerConfig) =>
    dbQuery<ITaskRow>(app, 'SELECT "issueIid", status, step FROM task WHERE "triggerName" = $1 ORDER BY id', [
      trigger.name,
    ]);

  const runsOf = (trigger: ITriggerConfig) =>
    dbQuery<IRunRow>(
      app,
      `SELECT r.id, r.number, r.step, r."endDate", r.outcome, r."deploymentFault"
       FROM run r JOIN task t ON t.id = r."taskId" WHERE t."triggerName" = $1 ORDER BY r.step, r.number`,
      [trigger.name]
    );

  const skipBackoff = async (trigger: ITriggerConfig, engine: { queue: { requestDispatch: () => Promise<void> } }) => {
    await dbQuery(app, `UPDATE task SET "notBeforeDate" = now() - interval '1 second' WHERE "triggerName" = $1`, [
      trigger.name,
    ]);
    await engine.queue.requestDispatch();
  };

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it("counts a trigger's running tasks at every step, starting a task's next step ahead of a newer task", async () => {
    const trigger = createTestTrigger({ steps: 2 });
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    await engine.emit(createIssueEvent(2));
    expect(engine.runner.started).toEqual([1]);

    engine.runner.finish(1);
    await expect.poll(() => engine.runner.started).toEqual([1, 1]);
    await engine.queue.requestDispatch();
    await engine.stop();

    expect(engine.runner.started).toEqual([1, 1]);
    expect(await tasksOf(trigger)).toMatchObject([
      { issueIid: 1, status: 'running', step: 1 },
      { issueIid: 2, status: 'queued', step: 0 },
    ]);
  });

  it("counts an agent's cap by the steps that resolve to it, so a full agent holds back only its own steps", async () => {
    const base = createTestTrigger({ steps: 2, concurrency: 3 });
    const [first, second] = base.steps as IAgentStepConfig[];
    const trigger: ITriggerConfig = {
      ...base,
      steps: [first, { ...second, agent: { ...second.agent, name: 'api', concurrency: 1 } }],
    };
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    await engine.emit(createIssueEvent(2));
    engine.runner.finish(1);
    await expect.poll(() => engine.runner.started).toEqual([1, 2, 1]);

    engine.runner.finish(2);
    await expect.poll(async () => (await tasksOf(trigger))[1]?.status).toBe('queued');
    await engine.emit(createIssueEvent(3));
    await engine.stop();

    expect(engine.runner.started).toEqual([1, 2, 1, 3]);
    expect(await tasksOf(trigger)).toMatchObject([
      { issueIid: 1, status: 'running', step: 1 },
      { issueIid: 2, status: 'queued', step: 1 },
      { issueIid: 3, status: 'running', step: 0 },
    ]);
  });

  it('retries only a step that failed for infrastructure, as its next try, and records every step', async () => {
    const trigger = createTestTrigger({ steps: 3 });
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    engine.runner.finish(1);
    await expect.poll(() => engine.runner.started).toEqual([1, 1]);
    engine.runner.finish(1);
    await expect.poll(() => engine.runner.started).toEqual([1, 1, 1]);
    engine.runner.finish(1, INFRASTRUCTURE_FAILURE);
    await expect.poll(async () => (await tasksOf(trigger))[0]?.status).toBe('queued');

    await skipBackoff(trigger, engine);
    await expect.poll(() => engine.runner.started).toHaveLength(4);
    engine.runner.finish(1, CLEAN_EXIT);
    await expect.poll(async () => (await tasksOf(trigger))[0]?.status).toBe('succeeded');
    await engine.stop();

    expect(engine.runner.requests.at(-1)?.step).toBe(trigger.steps[2]);
    expect(await runsOf(trigger)).toEqual([
      expect.objectContaining({ step: 0, number: 1, outcome: 'succeeded', deploymentFault: null }),
      expect.objectContaining({ step: 1, number: 1, outcome: 'succeeded', deploymentFault: null }),
      expect.objectContaining({ step: 2, number: 1, outcome: 'failed', deploymentFault: 'transient' }),
      expect.objectContaining({ step: 2, number: 2, outcome: 'succeeded', deploymentFault: null }),
    ]);
  });

  it("retries a later step once an earlier step moved the ticket off the trigger's labels", async () => {
    const trigger = createTestTrigger({ steps: 2 });
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    engine.tracker.setLabels(1, ['workflow::review']);
    engine.runner.finish(1);
    await expect.poll(() => engine.runner.started).toEqual([1, 1]);

    engine.runner.finish(1, INFRASTRUCTURE_FAILURE);
    await expect.poll(async () => (await tasksOf(trigger))[0]?.status).toBe('queued');
    await skipBackoff(trigger, engine);

    await expect.poll(() => engine.runner.started).toEqual([1, 1, 1]);
    await engine.stop();

    expect(await tasksOf(trigger)).toMatchObject([{ status: 'running', step: 1 }]);
  });

  it("resumes a later step after a restart, not an earlier step's retried try", async () => {
    const trigger = createTestTrigger({ steps: 2 });

    const before = await startTestEngine(app, [trigger]);
    await before.emit(createIssueEvent(1));
    before.runner.finish(1, INFRASTRUCTURE_FAILURE);
    await expect.poll(async () => (await tasksOf(trigger))[0]?.status).toBe('queued');
    await skipBackoff(trigger, before);
    await expect.poll(() => before.runner.started).toEqual([1, 1]);
    before.runner.finish(1);
    await expect.poll(() => before.runner.started).toEqual([1, 1, 1]);
    await before.stop();

    const runs = await runsOf(trigger);
    expect(runs.map(run => [run.step, run.number])).toEqual([
      [0, 1],
      [0, 2],
      [1, 1],
    ]);

    const runner = new TestAgentRunner();
    runner.resumeReport = CLEAN_EXIT;

    const after = await startTestEngine(app, [trigger], new FakeIssueTracker(), runner);

    await expect.poll(async () => (await tasksOf(trigger))[0]?.status).toBe('succeeded');
    await after.stop();

    expect(after.runner.resumed).toEqual([runs[2].id]);
  });

  it('resumes the step in flight after a restart, running none of the steps before it again', async () => {
    const trigger = createTestTrigger({ steps: 2 });

    const before = await startTestEngine(app, [trigger]);
    await before.emit(createIssueEvent(1));
    before.runner.finish(1);
    await expect.poll(() => before.runner.started).toEqual([1, 1]);
    await before.stop();

    const [, inFlight] = await runsOf(trigger);
    const runner = new TestAgentRunner();
    runner.resumeReport = CLEAN_EXIT;

    const after = await startTestEngine(app, [trigger], new FakeIssueTracker(), runner);

    await expect.poll(async () => (await tasksOf(trigger))[0]?.status).toBe('succeeded');
    await after.stop();

    expect(after.runner.resumed).toEqual([inFlight.id]);
    expect(after.runner.keptRunIds).toEqual([[inFlight.id]]);
    expect(after.runner.requests[0].step).toBe(trigger.steps[1]);
    expect(after.runner.started).toEqual([]);
  });
});
