import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { ConfigRevisionService } from '@/core/foundry-config/config-revision.service';

import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';

interface IRevisionRow {
  id: number;
  status: string;
  errors: unknown;
  seenDate: Date;
  currentDate: Date | null;
}

describe('Config revisions (integration)', () => {
  let app: NestExpressApplication;
  let service: ConfigRevisionService;

  const revisionsOf = (sha: string) =>
    dbQuery<IRevisionRow>(
      app,
      'SELECT id, status, errors, "seenDate", "currentDate" FROM config_revision WHERE sha = $1',
      [sha]
    );

  beforeAll(async () => {
    app = await bootstrapApp();
    service = app.get(ConfigRevisionService);
  });

  it('keeps one row and id per sha, with the first time it was seen and the latest verdict', async () => {
    const sha = randomBytes(20).toString('hex');
    const issues = [{ path: 'sources.gitlab.token', message: 'uses ${GITLAB_TOKEN}, which is not set' }];

    const id = await service.recordLoad(sha, []);
    const [loaded] = await revisionsOf(sha);

    await expect(service.recordLoad(sha, issues)).resolves.toBe(id);

    expect(await revisionsOf(sha)).toEqual([
      { id, status: 'failed', errors: issues, seenDate: loaded.seenDate, currentDate: null },
    ]);
  });

  it('keeps the first time a revision became current', async () => {
    const sha = randomBytes(32).toString('hex');

    const id = await service.recordLoad(sha, []);
    await service.recordCurrent(id);
    const [first] = await revisionsOf(sha);

    await service.recordCurrent(id);

    expect(first.currentDate).toBeInstanceOf(Date);
    expect((await revisionsOf(sha))[0].currentDate).toEqual(first.currentDate);
  });
});
