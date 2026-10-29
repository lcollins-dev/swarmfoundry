import { NestExpressApplication } from '@nestjs/platform-express';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  createIssueEvent,
  createMergeRequestEvent,
  createMergeRequestTrigger,
  createTestTrigger,
  FAILED_LABEL,
  INFRASTRUCTURE_FAILURE,
  SOURCE_TOKEN,
  startTestEngine,
} from '../../factories/trigger-engine.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';
import type { IStepConfig, ITriggerConfig } from '@/core/foundry-config/foundry-config.types';

interface IRunRow {
  list: string;
  step: number;
  number: number;
  outcome: string | null;
  result: string | null;
  error: string | null;
}

const MERGED_STEPS: IStepConfig[] = [
  { kind: 'relabel', add: ['workflow::test'], remove: ['workflow::review'] },
  { kind: 'comment', body: 'Merged in !{{mergeRequest.iid}}, ready for test.' },
];

describe('Static steps and failureSteps (integration)', () => {
  let app: NestExpressApplication;

  const statusOf = async (trigger: ITriggerConfig) =>
    (await dbQuery<{ status: string }>(app, 'SELECT status FROM task WHERE "triggerName" = $1', [trigger.name]))[0]
      ?.status;

  const runsOf = (trigger: ITriggerConfig) =>
    dbQuery<IRunRow>(
      app,
      `SELECT r.list, r.step, r.number, r.outcome, r.result, r.error
       FROM run r JOIN task t ON t.id = r."taskId" WHERE t."triggerName" = $1 ORDER BY r.id`,
      [trigger.name]
    );

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it("acts on a merge request's related issue with the source's token, and records each step", async () => {
    const trigger = { ...createMergeRequestTrigger(), steps: MERGED_STEPS };
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createMergeRequestEvent(5, 3));
    await expect.poll(() => statusOf(trigger)).toBe('succeeded');
    await engine.stop();

    expect(engine.runner.started).toEqual([]);
    expect(engine.tracker.labelsAdded).toEqual([{ issueIid: 3, label: 'workflow::test', token: SOURCE_TOKEN }]);
    expect(engine.tracker.labelsRemoved).toEqual([{ issueIid: 3, label: 'workflow::review', token: SOURCE_TOKEN }]);
    expect(engine.tracker.comments).toEqual([
      { issueIid: 3, body: 'Merged in !5, ready for test.', token: SOURCE_TOKEN },
    ]);
    expect(await runsOf(trigger)).toEqual([
      {
        list: 'steps',
        step: 0,
        number: 1,
        outcome: 'succeeded',
        result: 'Relabelled issue 3: added workflow::test; removed workflow::review',
        error: null,
      },
      { list: 'steps', step: 1, number: 1, outcome: 'succeeded', result: 'Commented on issue 3', error: null },
    ]);
  });

  it('runs failureSteps once a task fails for good, recording each under its own list', async () => {
    const trigger = createTestTrigger();
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    engine.runner.finish(1, { exitCode: 1, result: null, error: 'The agent exited with code 1' });
    await expect.poll(() => statusOf(trigger)).toBe('failed');
    await engine.stop();

    expect(engine.tracker.labelsAdded).toEqual([{ issueIid: 1, label: FAILED_LABEL, token: SOURCE_TOKEN }]);
    expect(engine.tracker.comments).toHaveLength(1);
    expect((await runsOf(trigger)).map(run => [run.list, run.step, run.number, run.outcome])).toEqual([
      ['steps', 0, 1, 'failed'],
      ['failureSteps', 0, 1, 'succeeded'],
      ['failureSteps', 1, 1, 'succeeded'],
    ]);
  });

  it('resumes the run of the failure step a restart cut off, not the run of the step that failed', async () => {
    const base = createTestTrigger();
    const trigger = { ...base, failureSteps: base.steps };

    const before = await startTestEngine(app, [trigger]);
    await before.emit(createIssueEvent(1));

    // A second try of steps[0] outnumbers the failure step's first run, so only the list tells the two apart.
    before.runner.finish(1, INFRASTRUCTURE_FAILURE);
    await expect.poll(() => statusOf(trigger)).toBe('queued');
    await dbQuery(app, `UPDATE task SET "notBeforeDate" = now() WHERE "triggerName" = $1`, [trigger.name]);
    await before.queue.requestDispatch();

    before.runner.finish(1, { exitCode: 1, result: null, error: 'The agent exited with code 1' });
    await expect.poll(() => before.runner.started).toEqual([1, 1, 1]);
    await before.stop();

    const after = await startTestEngine(app, [trigger]);
    await expect.poll(() => statusOf(trigger)).toBe('failed');
    await after.stop();

    const runs = await dbQuery<{ id: number; list: string }>(
      app,
      'SELECT r.id, r.list FROM run r JOIN task t ON t.id = r."taskId" WHERE t."triggerName" = $1 ORDER BY r.id',
      [trigger.name]
    );
    expect(runs.map(run => run.list)).toEqual(['steps', 'steps', 'failureSteps']);
    expect(after.runner.resumed).toEqual([runs[2].id]);
  });

  it("ends a task queued past the end of its trigger's failureSteps", async () => {
    const trigger = { ...createTestTrigger(), failureSteps: [] };
    const engine = await startTestEngine(app, [trigger]);

    await engine.emit(createIssueEvent(1));
    await dbQuery(
      app,
      `UPDATE task SET status = 'queued', list = 'failureSteps', step = 0 WHERE "triggerName" = $1 AND "issueIid" = 1`,
      [trigger.name]
    );
    await engine.queue.requestDispatch();
    await engine.stop();

    expect(
      await dbQuery<{ issueIid: number; status: string; endDate: Date | null }>(
        app,
        'SELECT "issueIid", status, "endDate" FROM task WHERE "triggerName" = $1 ORDER BY "issueIid"',
        [trigger.name]
      )
    ).toMatchObject([{ issueIid: 1, status: 'failed', endDate: expect.any(Date) }]);
  });
});
