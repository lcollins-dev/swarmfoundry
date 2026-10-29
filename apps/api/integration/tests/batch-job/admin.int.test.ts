import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BatchJobId, BatchJobRunResult, BatchJobDto, BatchJobRunDto, UserRoleId } from '@libs/dto';

import {
  getBatchJob,
  getBatchJobList,
  getBatchJobRunList,
  runBatchJob,
  updateBatchJobState,
} from '../../clients/batch-job.client';
import { login } from '../../clients/user.client';
import { createTestUser } from '../../factories/user.factory';
import { bootstrapApp } from '../../setup';
import { authHeaders } from '../../utils/auth';
import { dbQuery } from '../../utils/db';

const BATCH_JOB_LIST_ROUTE = '/api/v1/admin/batch-job/list';
const UNREGISTERED_JOB_ID = 999;
const HISTORY_SIZE = 100;
const PAGE_SIZE = 20;
const AWAIT_RUN_OPTIONS = { timeout: 10_000, interval: 100 };

describe('Batch job admin routes (integration)', () => {
  let app: NestExpressApplication;
  let token: string;

  beforeAll(async () => {
    app = await bootstrapApp();

    const admin = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
    token = await login(app, admin.email);
  });

  afterAll(async () => {
    // This hook runs even when beforeAll failed before assigning app, so it resolves the
    // shared app itself rather than reading a variable that may never have been set.
    await dbQuery(await bootstrapApp(), 'UPDATE batch_job SET enabled = true WHERE id = $1', [BatchJobId.EXAMPLE]);
  });

  describe('access', () => {
    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer()).get(BATCH_JOB_LIST_ROUTE).expect(401);
    });

    it('rejects a user with no roles', async () => {
      const user = await createTestUser(app);
      const userToken = await login(app, user.email);

      await getBatchJobList(app, userToken).expect(403);
    });

    it('rejects a USER_ADMIN who is not a SYSTEM_ADMIN', async () => {
      const admin = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });
      const adminToken = await login(app, admin.email);

      await getBatchJobList(app, adminToken).expect(403);
    });

    it("rejects a USER_ADMIN reading a job's runs", async () => {
      const admin = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });
      const adminToken = await login(app, admin.email);

      await getBatchJobRunList(app, adminToken, BatchJobId.EXAMPLE).expect(403);
    });

    it('rejects a USER_ADMIN running a job', async () => {
      const admin = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });
      const adminToken = await login(app, admin.email);

      await runBatchJob(app, adminToken, BatchJobId.EXAMPLE).expect(403);
    });
  });

  describe('reading', () => {
    it('lists the seeded example job', async () => {
      const response = await getBatchJobList(app, token).expect(200);

      const ids = response.body.batchJobList.map((batchJob: BatchJobDto) => batchJob.id);

      expect(ids).toContain(BatchJobId.EXAMPLE);
    });

    it('returns a single job with its schedule and run history', async () => {
      const response = await getBatchJob(app, token, BatchJobId.EXAMPLE).expect(200);

      expect(response.body).toMatchObject({
        id: BatchJobId.EXAMPLE,
        enabled: expect.any(Boolean) as boolean,
      });
      expect(response.body).toHaveProperty('cronExpression');
      expect(response.body).toHaveProperty('lastStartDate');
      expect(response.body).toHaveProperty('lastSuccessDate');
      expect(response.body).toHaveProperty('lastFailDate');
    });

    it('rejects a job id that does not exist', async () => {
      await getBatchJob(app, token, 2147483647).expect(400);
    });

    it('rejects a job id that is not an integer', async () => {
      await getBatchJob(app, token, 'abc').expect(400);
    });
  });

  describe('updating state', () => {
    it('disables and re-enables the job', async () => {
      await updateBatchJobState(app, token, BatchJobId.EXAMPLE, { enabled: false }).expect(200);

      const disabled = await getBatchJob(app, token, BatchJobId.EXAMPLE).expect(200);
      expect(disabled.body.enabled).toBe(false);

      await updateBatchJobState(app, token, BatchJobId.EXAMPLE, { enabled: true }).expect(200);

      const enabled = await getBatchJob(app, token, BatchJobId.EXAMPLE).expect(200);
      expect(enabled.body.enabled).toBe(true);
    });

    it('rejects a non-boolean enabled flag', async () => {
      await updateBatchJobState(app, token, BatchJobId.EXAMPLE, { enabled: 'yes' }).expect(400);
    });

    it('rejects a missing enabled flag', async () => {
      await updateBatchJobState(app, token, BatchJobId.EXAMPLE, {}).expect(400);
    });

    it('rejects a job id that does not exist', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/admin/batch-job/2147483647/state')
        .set(authHeaders(token))
        .send({ enabled: false })
        .expect(400);
    });
  });

  describe('running now', () => {
    it('rejects a job that has no runner registered', async () => {
      await dbQuery(app, 'INSERT INTO batch_job (id, "name", "desc", enabled) VALUES ($1, $2, $3, true)', [
        UNREGISTERED_JOB_ID,
        'Unregistered',
        'A job with no runner behind it',
      ]);

      try {
        const response = await runBatchJob(app, token, UNREGISTERED_JOB_ID).expect(400);

        expect(response.body.message).toBe("This batch job isn't set up to run on this server.");
      } finally {
        await dbQuery(app, 'DELETE FROM batch_job WHERE id = $1', [UNREGISTERED_JOB_ID]);
      }
    });

    it('rejects a job id that does not exist', async () => {
      await runBatchJob(app, token, 2147483647).expect(400);
    });

    it('rejects a page below one', async () => {
      await getBatchJobRunList(app, token, BatchJobId.EXAMPLE, 0).expect(400);
    });
  });

  describe('run history', () => {
    const runCount = async (): Promise<number> => {
      const [row] = await dbQuery<{ count: number }>(
        app,
        'SELECT COUNT(*)::int AS count FROM batch_job_run WHERE "batchJobId" = $1',
        [BatchJobId.EXAMPLE]
      );

      return row.count;
    };

    const listRuns = async (page = 1): Promise<BatchJobRunDto[]> => {
      const response = await getBatchJobRunList(app, token, BatchJobId.EXAMPLE, page).expect(200);

      return response.body.batchJobRunList;
    };

    const runAndAwaitRun = async (): Promise<BatchJobRunDto> => {
      const response = await runBatchJob(app, token, BatchJobId.EXAMPLE).expect(202);
      const started: BatchJobRunDto = response.body;

      expect(started).toMatchObject({ endDate: null, result: BatchJobRunResult.RUNNING, error: null });

      return vi.waitFor(async () => {
        const [newest] = await listRuns();

        expect(newest.id).toBe(started.id);
        expect(newest.result).not.toBe(BatchJobRunResult.RUNNING);

        return newest;
      }, AWAIT_RUN_OPTIONS);
    };

    it('records each run with its start, end and result, newest first', async () => {
      const first = await runAndAwaitRun();
      const second = await runAndAwaitRun();

      expect(second).toEqual({
        id: expect.any(Number) as number,
        startDate: expect.any(String) as string,
        endDate: expect.any(String) as string,
        result: BatchJobRunResult.SUCCEEDED,
        error: null,
      });

      const runs = await listRuns();

      expect(runs.findIndex(run => run.id === first.id)).toBeGreaterThan(0);
      expect(new Date(second.endDate ?? 0).getTime()).toBeGreaterThanOrEqual(new Date(second.startDate).getTime());

      const job = await getBatchJob(app, token, BatchJobId.EXAMPLE).expect(200);
      expect(new Date(job.body.lastSuccessDate).getTime()).toBe(new Date(second.endDate ?? 0).getTime());
    });

    it('fails a run a stopped process left open before starting the next', async () => {
      const [interrupted] = await dbQuery<{ id: number }>(
        app,
        'INSERT INTO batch_job_run ("batchJobId", "startDate", "result") VALUES ($1, $2, $3) RETURNING id',
        [BatchJobId.EXAMPLE, new Date(Date.UTC(2020, 0, 1)), BatchJobRunResult.RUNNING]
      );

      await runAndAwaitRun();

      const [row] = await dbQuery<{ result: string; error: string | null; endDate: Date | null }>(
        app,
        'SELECT "result", "error", "endDate" FROM batch_job_run WHERE id = $1',
        [interrupted.id]
      );

      expect(row).toMatchObject({
        result: BatchJobRunResult.FAILED,
        error: 'Interrupted before its result was recorded',
      });
      expect(row.endDate).not.toBeNull();
    });

    it('prunes the oldest runs past the history size once a run finishes, and pages the rest', async () => {
      await dbQuery(app, 'DELETE FROM batch_job_run WHERE "batchJobId" = $1', [BatchJobId.EXAMPLE]);

      for (let minute = 0; minute < HISTORY_SIZE + 5; minute++) {
        const startDate = new Date(Date.UTC(2020, 0, 1, 0, minute));

        await dbQuery(
          app,
          'INSERT INTO batch_job_run ("batchJobId", "startDate", "endDate", "result") VALUES ($1, $2, $3, $4)',
          [BatchJobId.EXAMPLE, startDate, startDate, BatchJobRunResult.SUCCEEDED]
        );
      }

      await runAndAwaitRun();

      expect(await runCount()).toBe(HISTORY_SIZE);

      const response = await getBatchJobRunList(app, token, BatchJobId.EXAMPLE, HISTORY_SIZE / PAGE_SIZE).expect(200);
      const lastPage: BatchJobRunDto[] = response.body.batchJobRunList;

      expect(response.body.pages).toBe(HISTORY_SIZE / PAGE_SIZE);
      expect(lastPage).toHaveLength(PAGE_SIZE);

      // 105 seeded plus the new run, so the six oldest go.
      expect(new Date(lastPage[PAGE_SIZE - 1].startDate).toISOString()).toBe(
        new Date(Date.UTC(2020, 0, 1, 0, 6)).toISOString()
      );
    });
  });
});
