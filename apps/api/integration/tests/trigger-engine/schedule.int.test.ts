import { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { beforeAll, describe, expect, it } from 'vitest';

import { Run } from '@/core/task/entities/run.entity';
import { Task } from '@/core/task/entities/task.entity';

import { TaskService } from '@/core/task/task.service';

import {
  createScheduledTrigger,
  startTestEngine,
  TEST_SOURCE,
  YEARLY_CRON,
} from '../../factories/trigger-engine.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';
import { fireTimeAtOrBefore } from '@/core/foundry-config/cron-schedule';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';

interface ITaskRow {
  id: number;
  fireTime: Date;
  status: string;
}

// The engine reads the real clock, so the yearly cron's latest fire time moves each 1 January.
const FIRED = fireTimeAtOrBefore(YEARLY_CRON, new Date()).toISOString();
const LAST_YEAR = fireTimeAtOrBefore(YEARLY_CRON, new Date(Date.parse(FIRED) - 1)).toISOString();

describe('Scheduled triggers (integration)', () => {
  let app: NestExpressApplication;

  const tasksOf = (trigger: ITriggerConfig) =>
    dbQuery<ITaskRow>(app, 'SELECT id, "fireTime", status FROM task WHERE "triggerName" = $1 ORDER BY "fireTime"', [
      trigger.name,
    ]);

  const fireTimesOf = async (trigger: ITriggerConfig) =>
    (await tasksOf(trigger)).map(task => task.fireTime.toISOString());

  const seedTask = async (triggerName: string, fireTime: string, status = 'succeeded'): Promise<number> => {
    const [row] = await dbQuery<{ id: number }>(
      app,
      `INSERT INTO task ("triggerName", "sourceName", "projectPath", "projectUrl", status, "queuedDate", "fireTime", cron)
       VALUES ($1, $2, 'group/project', 'https://gitlab.test/group/project', $3, $4, $4, $5) RETURNING id`,
      [triggerName, TEST_SOURCE, status, fireTime, YEARLY_CRON]
    );

    return row.id;
  };

  const seedRun = (taskId: number, number: number, startDate: string, endDate: string, outcome: string, step = 0) =>
    dbQuery(
      app,
      'INSERT INTO run ("taskId", number, step, "startDate", "endDate", outcome) VALUES ($1, $2, $3, $4, $5, $6)',
      [taskId, number, step, startDate, endDate, outcome]
    );

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it('keeps one task per trigger and fire time, whoever inserts it', async () => {
    const trigger = createScheduledTrigger();
    const fields = {
      triggerName: trigger.name,
      sourceName: TEST_SOURCE,
      projectPath: 'group/project',
      projectUrl: 'https://gitlab.test/group/project',
      fireTime: new Date(FIRED),
      cron: YEARLY_CRON,
    };

    const taskService = app.get(TaskService);
    const [first, second] = await Promise.all([
      taskService.enqueueScheduled(fields),
      taskService.enqueueScheduled(fields),
    ]);

    expect([first, second].filter(task => task !== null)).toHaveLength(1);
    expect(await fireTimesOf(trigger)).toEqual([FIRED]);
  });

  it("finds the trigger's scheduled task with the latest fire time, whatever the insert order", async () => {
    const trigger = createScheduledTrigger();

    await seedTask(trigger.name, '2024-01-01T00:00:00Z');
    const latest = await seedTask(trigger.name, '2025-01-01T00:00:00Z', 'failed');
    await seedTask(trigger.name, '2023-01-01T00:00:00Z');

    await dbQuery(
      app,
      `INSERT INTO task ("triggerName", "sourceName", "projectId", "projectPath", "projectUrl", "issueIid", "issueTitle",
         "issueUrl", "changeKind", "changeId", "changeDate", status, "queuedDate")
       VALUES ($1, $2, 7, 'group/project', 'https://gitlab.test/group/project', 1, 'Issue 1',
         'https://gitlab.test/group/project/-/issues/1', 'label', 10, now(), 'queued', now())`,
      [trigger.name, TEST_SOURCE]
    );

    expect(await app.get(TaskService).findLatestScheduled(trigger.name)).toMatchObject({
      id: latest,
      fireTime: new Date('2025-01-01T00:00:00Z'),
      status: 'failed',
    });
  });

  it('runs the task through the queue without an issue', async () => {
    const trigger = createScheduledTrigger();
    await seedTask(trigger.name, LAST_YEAR);

    const engine = await startTestEngine(app, [trigger]);
    await engine.tick();

    const [, task] = await tasksOf(trigger);
    expect(engine.runner.startedTasks).toEqual([task.id]);

    engine.runner.finishTask(task.id);
    await expect.poll(async () => (await tasksOf(trigger)).at(-1)?.status).toBe('succeeded');
    await engine.stop();
  });

  it("fills the last* times from the trigger's earlier tasks only", async () => {
    const trigger = createScheduledTrigger();

    const first = await seedTask(trigger.name, '2023-01-01T00:00:00Z', 'succeeded');
    await seedRun(first, 1, '2023-01-01T00:00:05Z', '2023-01-01T00:10:00Z', 'failed');
    await seedRun(first, 2, '2023-01-01T00:20:00Z', '2023-01-01T00:30:00Z', 'succeeded');

    const second = await seedTask(trigger.name, '2024-01-01T00:00:00Z', 'failed');
    await seedRun(second, 1, '2024-01-01T00:00:05Z', '2024-01-01T00:15:00Z', 'failed');

    const other = await seedTask(`${trigger.name}-other`, '2024-06-01T00:00:00Z', 'succeeded');
    await seedRun(other, 1, '2024-06-01T00:00:05Z', '2024-06-01T00:15:00Z', 'succeeded');

    const current = await seedTask(trigger.name, '2025-01-01T00:00:00Z', 'running');
    await seedRun(current, 1, '2025-01-01T00:00:05Z', '2025-01-01T00:10:00Z', 'failed');

    const dataSource = app.get(DataSource);
    const task = await dataSource.getRepository(Task).findOneByOrFail({ id: current });
    const run = await dataSource.getRepository(Run).findOneByOrFail({ taskId: current });

    const context = await app.get(TaskService).promptContext(trigger, task, run);

    expect(context.schedule).toMatchObject({
      lastRunStart: '2024-01-01T00:00:05.000Z',
      lastSuccessEnd: '2023-01-01T00:30:00.000Z',
      lastFailureEnd: '2024-01-01T00:15:00.000Z',
    });
  });

  it('fills the last* times from runs of the same step, its retries included', async () => {
    const trigger = createScheduledTrigger();

    const earlier = await seedTask(trigger.name, '2024-01-01T00:00:00Z', 'succeeded');
    await seedRun(earlier, 1, '2024-01-01T00:00:05Z', '2024-01-01T00:10:00Z', 'succeeded', 0);
    await seedRun(earlier, 1, '2024-01-01T00:10:05Z', '2024-01-01T00:20:00Z', 'failed', 1);
    await seedRun(earlier, 2, '2024-01-01T01:00:00Z', '2024-01-01T01:30:00Z', 'succeeded', 1);

    const current = await seedTask(trigger.name, '2025-01-01T00:00:00Z', 'running');
    await seedRun(current, 1, '2025-01-01T00:00:05Z', '2025-01-01T00:10:00Z', 'succeeded', 0);

    const dataSource = app.get(DataSource);
    const task = await dataSource.getRepository(Task).findOneByOrFail({ id: current });
    const firstStep = await dataSource.getRepository(Run).findOneByOrFail({ taskId: current });
    const secondStep = Object.assign(Object.create(firstStep) as Run, { step: 1 });

    expect((await app.get(TaskService).promptContext(trigger, task, firstStep)).schedule).toMatchObject({
      lastRunStart: '2024-01-01T00:00:05.000Z',
      lastSuccessEnd: '2024-01-01T00:10:00.000Z',
      lastFailureEnd: '',
    });
    expect((await app.get(TaskService).promptContext(trigger, task, secondStep)).schedule).toMatchObject({
      lastRunStart: '2024-01-01T01:00:00.000Z',
      lastSuccessEnd: '2024-01-01T01:30:00.000Z',
      lastFailureEnd: '2024-01-01T00:20:00.000Z',
    });
  });

  it('leaves the last* times empty on a trigger with no earlier run', async () => {
    const trigger = createScheduledTrigger();

    const earlier = await seedTask(trigger.name, '2024-01-01T00:00:00Z', 'failed');
    await seedRun(earlier, 1, '2024-01-01T00:00:05Z', '2024-01-01T00:15:00Z', 'failed');

    const first = await seedTask(trigger.name, '2023-01-01T00:00:00Z', 'running');
    await seedRun(first, 1, '2023-01-01T00:00:05Z', '2023-01-01T00:10:00Z', 'failed');

    const dataSource = app.get(DataSource);
    const task = await dataSource.getRepository(Task).findOneByOrFail({ id: first });
    const run = await dataSource.getRepository(Run).findOneByOrFail({ taskId: first });

    const context = await app.get(TaskService).promptContext(trigger, task, run);

    expect(context.schedule).toMatchObject({ lastRunStart: '', lastSuccessEnd: '', lastFailureEnd: '' });
  });

  it('refuses a task that is not wholly an issue task or wholly a scheduled one', async () => {
    const issue = {
      projectId: 7,
      issueIid: 1,
      issueTitle: 'Issue 1',
      issueUrl: 'https://gitlab.test/i/1',
      changeKind: 'label',
      changeId: 10,
      changeDate: '2025-01-01T00:00:00Z',
    };
    const noIssue = {
      projectId: null,
      issueIid: null,
      issueTitle: null,
      issueUrl: null,
      changeKind: null,
      changeId: null,
      changeDate: null,
    };
    const schedule = { fireTime: '2025-01-01T00:00:00Z', cron: YEARLY_CRON };
    const noSchedule = { fireTime: null, cron: null };

    const insert = (fields: Record<string, string | number | null>) =>
      dbQuery(
        app,
        `INSERT INTO task ("triggerName", "sourceName", "projectPath", "projectUrl", status, "queuedDate", "projectId",
           "issueIid", "issueTitle", "issueUrl", "changeKind", "changeId", "changeDate", "changeActor", "fireTime",
           cron)
         VALUES ('int-check', $1, 'group/project', 'https://gitlab.test/group/project', 'queued', now(), $2, $3, $4, $5,
           $6, $7, $8, $9, $10, $11)`,
        [
          TEST_SOURCE,
          fields.projectId,
          fields.issueIid,
          fields.issueTitle,
          fields.issueUrl,
          fields.changeKind,
          fields.changeId,
          fields.changeDate,
          fields.changeActor ?? null,
          fields.fireTime,
          fields.cron,
        ]
      );

    for (const fields of [
      { ...noIssue, ...noSchedule },
      { ...issue, ...schedule },
      { ...issue, ...noSchedule, projectId: null },
      { ...noIssue, ...schedule, cron: null },
      { ...noIssue, ...schedule, changeActor: 'ada' },
      { ...issue, ...noSchedule, changeDate: null },
    ]) {
      await expect(insert(fields)).rejects.toThrow(/CHK_task_kind/);
    }
  });
});
