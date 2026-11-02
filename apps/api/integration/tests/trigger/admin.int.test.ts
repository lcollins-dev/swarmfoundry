import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { RunOutcome, StepList, TaskStatus, UserRoleId } from '@libs/dto';

import type { Task } from '@/core/task/entities/task.entity';

import { ConfigRevisionService } from '@/core/foundry-config/config-revision.service';
import { TaskReadService } from '@/core/task/task-read.service';
import { TaskService } from '@/core/task/task.service';

import { login } from '../../clients/user.client';
import { createIssueEvent } from '../../factories/trigger-engine.factory';
import { createTestUser } from '../../factories/user.factory';
import { bootstrapApp } from '../../setup';
import { authHeaders } from '../../utils/auth';
import { dbQuery } from '../../utils/db';

const ROUTES = [
  '/api/v1/admin/trigger/list',
  '/api/v1/admin/queue',
  '/api/v1/admin/source/list',
  '/api/v1/admin/config',
];

const AGENT = { name: 'claude', model: 'claude-opus-5-5', auth: 'oauth' as const };

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Trigger, queue, source and config read routes (integration)', () => {
  let app: NestExpressApplication;
  let taskService: TaskService;
  let token: string;
  let nextIid = 1;

  const enqueue = async (trigger: string): Promise<Task> => {
    const iid = nextIid++;
    const task = await taskService.enqueue(trigger, createIssueEvent(iid), {
      kind: 'label',
      id: iid,
      createdAt: new Date(),
      actor: null,
    });

    if (task === null) {
      throw new Error('The task was not queued');
    }

    return task;
  };

  /** Runs the task's one step to its end, `minutes` long, costing `costUsd`, and ends it `daysAgo`. */
  const finish = async (
    task: Task,
    status: TaskStatus.SUCCEEDED | TaskStatus.FAILED,
    minutes: number,
    costUsd: number,
    daysAgo = 0
  ) => {
    const run = await taskService.startRun(task, null, AGENT);

    if (run === null) {
      throw new Error('The run did not start');
    }

    await taskService.recordReport(run, {
      exitCode: 0,
      result: null,
      error: null,
      usage: { turns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd },
    });
    await taskService.finishRun(
      task,
      run,
      {
        outcome: status === TaskStatus.SUCCEEDED ? RunOutcome.SUCCEEDED : RunOutcome.FAILED,
        error: null,
        deploymentFault: null,
      },
      { status }
    );

    const endDate = new Date(Date.now() - daysAgo * DAY_MS);

    await dbQuery(app, 'UPDATE run SET "startDate" = $2 WHERE id = $1', [
      run.id,
      new Date(endDate.getTime() - minutes * 60_000),
    ]);
    await dbQuery(app, 'UPDATE task SET "endDate" = $2 WHERE id = $1', [task.id, endDate]);
  };

  beforeAll(async () => {
    app = await bootstrapApp();
    taskService = app.get(TaskService);

    const admin = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
    token = await login(app, admin.email);
  });

  describe('access', () => {
    it.each(ROUTES)('refuses a signed-out request to %s', async route => {
      await request(app.getHttpServer()).get(route).expect(401);
    });

    it.each(ROUTES)('refuses a signed-in user without the system admin role at %s', async route => {
      const userAdmin = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });
      const userToken = await login(app, userAdmin.email);

      await request(app.getHttpServer()).get(route).set(authHeaders(userToken)).expect(403);
    });

    it.each(
      ROUTES.flatMap(route => (['post', 'patch', 'put', 'delete'] as const).map(method => [method, route] as const))
    )('serves no %s on %s', async (method, route) => {
      await request(app.getHttpServer())[method](route).set(authHeaders(token)).expect(404);
    });
  });

  it('answers each read for a system admin', async () => {
    const [triggers, queue, sources, config] = await Promise.all(
      ROUTES.map(route => request(app.getHttpServer()).get(route).set(authHeaders(token)))
    );

    // The suite's app runs with no config file, so it has no trigger or source, and no config to serve.
    expect(triggers.status).toBe(200);
    expect(triggers.body).toEqual({ triggerList: [], configSha: null });
    expect(queue.status).toBe(200);
    expect(sources.body).toEqual({ sourceList: [] });
    expect(config.status).toBe(404);
  });

  it('refuses a malformed sha', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/config')
      .query({ sha: 'main' })
      .set(authHeaders(token))
      .expect(400);
  });

  it('lists the queue in arrival order, each task with why it waits', async () => {
    const trigger = `int-${randomUUID()}`;
    const first = await enqueue(trigger);
    const second = await enqueue(trigger);

    const response = await request(app.getHttpServer()).get('/api/v1/admin/queue').set(authHeaders(token)).expect(200);
    const ours = (response.body as { queue: { id: number; wait: unknown }[] }).queue.filter(task =>
      [first.id, second.id].includes(task.id)
    );

    // No config holds the trigger, so no pass would start either.
    expect(ours).toEqual([
      expect.objectContaining({ id: first.id, wait: { reason: 'notInConfig' } }),
      expect.objectContaining({ id: second.id, wait: { reason: 'notInConfig' } }),
    ]);
  });

  it('finds a config revision used only once a task has run on it', async () => {
    const recordLoad = () => app.get(ConfigRevisionService).recordLoad(randomBytes(20).toString('hex'), []);
    const [used, unused] = await Promise.all([recordLoad(), recordLoad()]);

    await taskService.startRun(await enqueue(`int-${randomUUID()}`), used, AGENT);

    await expect(app.get(TaskReadService).isConfigUsed(used)).resolves.toBe(true);
    await expect(app.get(TaskReadService).isConfigUsed(unused)).resolves.toBe(false);
  });

  describe('trigger activity', () => {
    it('counts the tasks now, and sums the finished ones of the window, leaving out a cancelled task', async () => {
      const trigger = `int-${randomUUID()}`;
      const idle = `int-${randomUUID()}`;

      await finish(await enqueue(trigger), TaskStatus.SUCCEEDED, 10, 1.25);
      await finish(await enqueue(trigger), TaskStatus.SUCCEEDED, 20, 0.75);
      await finish(await enqueue(trigger), TaskStatus.FAILED, 40, 0.5);
      await finish(await enqueue(trigger), TaskStatus.SUCCEEDED, 5, 100, 8);
      await taskService.cancel(await enqueue(trigger), 'The issue is closed');

      const running = await enqueue(trigger);
      await taskService.startRun(running, null, AGENT);
      await enqueue(trigger);
      const latest = await enqueue(trigger);

      const activity = await app
        .get(TaskReadService)
        .findTriggerActivity([trigger, idle], new Date(Date.now() - 7 * DAY_MS));

      expect(activity.get(trigger)).toEqual({
        runningCount: 1,
        queuedCount: 2,
        lastFiredDate: latest.queuedDate,
        stats: {
          finishedCount: 3,
          succeededCount: 2,
          successRate: 2 / 3,
          medianDurationMs: 20 * 60_000,
          p90DurationMs: 36 * 60_000,
          succeededCostUsd: 2,
          failedCostUsd: 0.5,
        },
      });
      expect(activity.get(idle)).toMatchObject({ runningCount: 0, queuedCount: 0, lastFiredDate: null });
      expect(running.list).toBe(StepList.STEPS);
    });
  });
});
