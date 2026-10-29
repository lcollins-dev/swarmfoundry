import { hash } from 'bcryptjs';
import { Client } from 'pg';

import { UserRoleId } from '@libs/dto';

import { uniqueEmail } from '../factories/user.factory';
import { LOCAL_INSTANCE } from './urls';
import { ISignInCredentials, TEST_PASSWORD } from './users';

export interface IFlaggedAdmin extends ISignInCredentials {
  id: number;
}

// Falls back to this checkout's dev instance database, as resources/instanced/env.sh places it.
const connect = async (): Promise<Client> => {
  const client = new Client({
    host: process.env.TYPEORM_HOST ?? 'localhost',
    port: Number(process.env.TYPEORM_PORT ?? 15400 + (LOCAL_INSTANCE ?? 0)),
    database: process.env.TYPEORM_DATABASE ?? 'swarmfoundry',
    user: process.env.TYPEORM_USERNAME ?? 'swarmfoundry',
    password: process.env.TYPEORM_PASSWORD ?? 'swarmfoundry',
  });

  await client.connect();

  return client;
};

const withClient = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
  const client = await connect();

  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

// Callers remove the account with deleteUser, since a held account makes the api warn on every boot.
export const createFlaggedAdmin = async (): Promise<IFlaggedAdmin> => {
  const email = uniqueEmail('setup');
  const passwordHash = await hash(TEST_PASSWORD, 4);

  return withClient(async client => {
    await client.query('BEGIN');

    try {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO "user" ("name", "email", "passwordHash", "enabled", "mustChangePassword")
         VALUES ($1, $2, $3, true, true) RETURNING "id"`,
        ['Setup Admin', email, passwordHash]
      );
      const id = inserted.rows[0].id;

      for (const userRoleId of [UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN]) {
        await client.query('INSERT INTO "user_user_role" ("userId", "userRoleId") VALUES ($1, $2)', [id, userRoleId]);
      }

      await client.query('COMMIT');

      return { id, email, password: TEST_PASSWORD };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export const deleteUser = async (userId: number): Promise<void> => {
  await withClient(async client => {
    await client.query('DELETE FROM "notification" WHERE "userId" = $1', [userId]);
    await client.query('DELETE FROM "user_user_role" WHERE "userId" = $1', [userId]);
    await client.query('DELETE FROM "user" WHERE "id" = $1', [userId]);
  });
};

// Dated a day ahead so it lists above any real run.
export const addFailedBatchJobRun = async (batchJobId: number, error: string): Promise<number> =>
  withClient(async client => {
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO "batch_job_run" ("batchJobId", "startDate", "endDate", "result", "error")
       SELECT $1::int4, "tomorrow", "tomorrow", 'failed', $2::text
       FROM (SELECT (now() AT TIME ZONE 'UTC') + interval '1 day' AS "tomorrow") AS "dates"
       RETURNING "id"`,
      [batchJobId, error]
    );

    return inserted.rows[0].id;
  });

export const deleteBatchJobRun = async (batchJobRunId: number): Promise<void> => {
  await withClient(async client => {
    await client.query('DELETE FROM "batch_job_run" WHERE "id" = $1', [batchJobRunId]);
  });
};
