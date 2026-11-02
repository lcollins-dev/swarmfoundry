import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { RunOutcome, TaskStatus, UserRoleId } from '@libs/dto';

import { TaskService } from '@/core/task/task.service';

import {
  createApiKey,
  getApiKeyList,
  getUserApiKeyList,
  issueApiKey,
  revokeApiKey,
} from '../../clients/api-key.client';
import { login, logout } from '../../clients/user.client';
import { createIssueEvent } from '../../factories/trigger-engine.factory';
import { createTestUser, ITestUser } from '../../factories/user.factory';
import { bootstrapApp } from '../../setup';
import { authHeaders } from '../../utils/auth';
import { dbQuery } from '../../utils/db';

// `:taskId` and `:runId` stand for a task and run the suite seeds.
const READ_ENDPOINTS = [
  '/api/v1/admin/task/list?page=1',
  '/api/v1/admin/task/:taskId',
  '/api/v1/admin/run/:runId',
  '/api/v1/admin/run/:runId/transcript',
  '/api/v1/admin/trigger/list',
  '/api/v1/admin/source/list',
  '/api/v1/admin/queue',
  '/api/v1/admin/config',
];

const readTasks = (app: NestExpressApplication, key: string) =>
  request(app.getHttpServer()).get('/api/v1/admin/task/list?page=1').set(authHeaders(key));

describe('API keys (integration)', () => {
  let app: NestExpressApplication;
  let admin: ITestUser;
  let token: string;
  let taskId: number;
  let runId: number;

  beforeAll(async () => {
    app = await bootstrapApp();

    admin = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN, UserRoleId.USER_ADMIN] });
    token = await login(app, admin.email);

    // A finished task on its own project, so the trigger engine suites never pick it up.
    const taskService = app.get(TaskService);
    const event = createIssueEvent(1);
    const task = await taskService.enqueue(
      `int-${randomUUID()}`,
      { ...event, project: { ...event.project, path: `group/${randomUUID()}` } },
      { kind: 'label', id: 10, createdAt: new Date(), actor: 'ada' }
    );
    const run = task === null ? null : await taskService.startRun(task, null, null);

    if (task === null || run === null) {
      throw new Error('The task or its run was not created');
    }

    await taskService.finishRun(
      task,
      run,
      { outcome: RunOutcome.FAILED, error: 'Stopped', deploymentFault: null },
      { status: TaskStatus.FAILED }
    );

    taskId = task.id;
    runId = run.id;
  });

  describe('managing keys', () => {
    it('answers the full key once, and lists the key without it', async () => {
      const name = `Key ${Date.now()}`;
      const created = await createApiKey(app, token, { name }).expect(201);

      expect(created.body.token).toMatch(/^sfk_[0-9a-f]{24}_[\w-]+$/);
      expect(created.body.apiKey).toMatchObject({ name, lastUsedDate: null });

      const list = await getApiKeyList(app, token).expect(200);
      const listed = list.body.apiKeyList.find((apiKey: { id: number }) => apiKey.id === created.body.apiKey.id);

      expect(listed).toEqual({
        id: created.body.apiKey.id,
        name,
        lastUsedDate: null,
        createdDate: created.body.apiKey.createdDate,
      });
      expect(JSON.stringify(list.body)).not.toContain(created.body.token);
    });

    it('stores only a hash of the secret', async () => {
      const key = await issueApiKey(app, token);
      const secret = key.slice(key.lastIndexOf('_') + 1);

      const rows = await dbQuery(app, 'SELECT * FROM "api_key" WHERE "userId" = $1', [admin.id]);

      expect(JSON.stringify(rows)).not.toContain(secret);
    });

    it("lists another user's keys for an admin, and lets the admin revoke them", async () => {
      const other = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
      const otherToken = await login(app, other.email);
      const otherKey = await issueApiKey(app, otherToken, 'Their key');

      const list = await getUserApiKeyList(app, token, other.id).expect(200);

      expect(list.body.apiKeyList).toHaveLength(1);
      expect(list.body.apiKeyList[0].name).toBe('Their key');

      await revokeApiKey(app, token, list.body.apiKeyList[0].id).expect(200);
      await readTasks(app, otherKey).expect(401);
    });

    it('refuses a name that is empty or too long', async () => {
      await createApiKey(app, token, { name: '' }).expect(400);
      await createApiKey(app, token, { name: 'x'.repeat(129) }).expect(400);
    });

    it('refuses to revoke a key that does not exist', async () => {
      await revokeApiKey(app, token, 2147483647).expect(400);
    });

    it('refuses everything to a user who is not a system admin', async () => {
      const userAdmin = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });
      const userAdminToken = await login(app, userAdmin.email);

      await createApiKey(app, userAdminToken, { name: 'Mine' }).expect(403);
      await getApiKeyList(app, userAdminToken).expect(403);
      await getUserApiKeyList(app, userAdminToken, admin.id).expect(403);
      await revokeApiKey(app, userAdminToken, 1).expect(403);
    });
  });

  describe('authenticating with a key', () => {
    it.each(READ_ENDPOINTS)('reads %s as a session does', async template => {
      const path = template.replace(':taskId', String(taskId)).replace(':runId', String(runId));
      const key = await issueApiKey(app, token);

      const withSession = await request(app.getHttpServer()).get(path).set(authHeaders(token));
      const withKey = await request(app.getHttpServer()).get(path).set(authHeaders(key));

      expect([401, 403]).not.toContain(withKey.status);
      expect(withKey.status).toBe(withSession.status);
    });

    it.each([
      ['GET', '/api/v1/user/profile'],
      ['GET', '/api/v1/admin/api-key/list'],
      ['POST', '/api/v1/admin/api-key'],
      ['PATCH', '/api/v1/admin/user/list?page=1'],
      ['GET', '/api/v1/admin/batch-job/list'],
      ['GET', '/api/v1/admin/run/1/transcript/stream'],
    ])('refuses %s %s with 403', async (method, path) => {
      const key = await issueApiKey(app, token);
      const agent = request(app.getHttpServer());
      const call = method === 'GET' ? agent.get(path) : method === 'POST' ? agent.post(path) : agent.patch(path);

      await call.set(authHeaders(key)).send({}).expect(403);
    });

    it('stamps the last use', async () => {
      const created = await createApiKey(app, token, { name: 'Stamped' }).expect(201);

      await readTasks(app, created.body.token).expect(200);

      const list = await getApiKeyList(app, token).expect(200);
      const listed = list.body.apiKeyList.find((apiKey: { id: number }) => apiKey.id === created.body.apiKey.id);

      expect(listed.lastUsedDate).not.toBeNull();
    });

    it('refuses a revoked key with 401', async () => {
      const created = await createApiKey(app, token, { name: 'Revoked' }).expect(201);

      await revokeApiKey(app, token, created.body.apiKey.id).expect(200);
      await readTasks(app, created.body.token).expect(401);
    });

    it('refuses a key with a wrong secret with 401', async () => {
      const key = await issueApiKey(app, token);

      await readTasks(app, `${key.slice(0, key.lastIndexOf('_') + 1)}${'A'.repeat(43)}`).expect(401);
    });

    it('keeps working after its owner signs out and their session idles out', async () => {
      const owner = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
      const ownerToken = await login(app, owner.email);
      const key = await issueApiKey(app, ownerToken);

      await logout(app, ownerToken).expect(201);
      await dbQuery(app, `UPDATE "user" SET "lastAccess" = now() - interval '30 days' WHERE id = $1`, [owner.id]);

      await readTasks(app, key).expect(200);
    });

    it.each([
      ['disabled', `UPDATE "user" SET "enabled" = false WHERE id = $1`],
      ['held to first-time setup', `UPDATE "user" SET "mustChangePassword" = true WHERE id = $1`],
      ['deleted', `WITH roles AS (DELETE FROM "user_user_role" WHERE "userId" = $1) DELETE FROM "user" WHERE id = $1`],
    ])('stops working once its owner is %s', async (_description, sql) => {
      const owner = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
      const key = await issueApiKey(app, await login(app, owner.email));

      await readTasks(app, key).expect(200);
      await dbQuery(app, sql, [owner.id]);
      await readTasks(app, key).expect(401);
    });

    it('stops reading once its owner is no longer a system admin', async () => {
      const owner = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
      const key = await issueApiKey(app, await login(app, owner.email));

      await dbQuery(app, 'DELETE FROM "user_user_role" WHERE "userId" = $1', [owner.id]);

      await readTasks(app, key).expect(403);
    });
  });
});
