import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDatabaseConfig, recreateDatabase } from '../../utils/database';
import { migrations } from '@/database/migrations';
import { KeyTasksOnIssueChanges1792945285781 } from '@/database/migrations/1792945285781-KeyTasksOnIssueChanges';

describe('The deploy that keys issue tasks on changes (integration)', () => {
  const config = { ...getDatabaseConfig(), database: 'swarmfoundry_change_key_int' };
  const index = migrations.indexOf(KeyTasksOnIssueChanges1792945285781);
  let dataSource: DataSource;

  const connect = (upTo: number) =>
    new DataSource({
      type: 'postgres',
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      database: config.database,
      migrations: migrations.slice(0, upTo),
    }).initialize();

  beforeAll(async () => {
    await recreateDatabase(config);

    const before = await connect(index);
    await before.runMigrations();

    await before.query(
      `INSERT INTO task ("triggerName", "sourceName", "projectId", "projectPath", "projectUrl", "issueIid", "issueTitle",
         "issueUrl", "labelEventId", "labelEventActor", status, "queuedDate")
       VALUES ('implement', 'gitlab', 7, 'group/project', 'https://gitlab.test/group/project', 1, 'Issue 1',
         'https://gitlab.test/i/1', 100, 'ada', 'succeeded', '2026-10-24T10:00:00')`
    );
    await before.query(
      `INSERT INTO source_watermark (kind, "sourceName", "gitlabUrl", "projectId", watermark)
       VALUES ('issue', 'gitlab', 'https://gitlab.test', 7, '2026-10-24T10:00:00'),
         ('mergeRequest', 'gitlab', 'https://gitlab.test', 7, '2026-10-24T10:00:00')`
    );
    await before.destroy();

    dataSource = await connect(index + 1);
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('keeps an earlier task keyed on its label event, timed by when it was queued', async () => {
    expect(await dataSource.query('SELECT "changeKind", "changeId", "changeDate", "changeActor" FROM task')).toEqual([
      { changeKind: 'label', changeId: '100', changeDate: new Date('2026-10-24T10:00:00Z'), changeActor: 'ada' },
    ]);
  });

  it('refuses a second task for the label event an earlier task was queued for', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO task ("triggerName", "sourceName", "projectId", "projectPath", "projectUrl", "issueIid",
           "issueTitle", "issueUrl", "changeKind", "changeId", "changeDate", status, "queuedDate")
         VALUES ('implement', 'gitlab', 7, 'group/project', 'https://gitlab.test/group/project', 1, 'Issue 1',
           'https://gitlab.test/i/1', 'label', 100, now(), 'queued', now())`
      )
    ).rejects.toThrow(/UQ_task_issue_change/);
  });

  it('starts every issue watermark afresh, so no change from before the deploy keys a task, and keeps merge requests', async () => {
    expect(await dataSource.query('SELECT kind FROM source_watermark')).toEqual([{ kind: 'mergeRequest' }]);
  });
});
