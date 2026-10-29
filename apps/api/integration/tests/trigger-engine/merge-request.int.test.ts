import { NestExpressApplication } from '@nestjs/platform-express';
import { beforeAll, describe, expect, it } from 'vitest';

import { TaskService } from '@/core/task/task.service';

import {
  createMergeRequestEvent,
  createMergeRequestTrigger,
  TEST_SOURCE,
} from '../../factories/trigger-engine.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';

interface ITaskRow {
  id: number;
  mergeRequestIid: number;
  mergeRequestEvent: string;
  issueIid: number | null;
  status: string;
}

describe('Merge request triggers (integration)', () => {
  let app: NestExpressApplication;

  const tasksOf = (trigger: ITriggerConfig) =>
    dbQuery<ITaskRow>(
      app,
      `SELECT id, "mergeRequestIid", "mergeRequestEvent", "issueIid", status FROM task WHERE "triggerName" = $1
       ORDER BY id`,
      [trigger.name]
    );

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it('keeps one task per trigger, merge request and event, whoever inserts it', async () => {
    const trigger = createMergeRequestTrigger();
    const taskService = app.get(TaskService);

    const inserted = await Promise.all([
      taskService.enqueueMergeRequest(trigger.name, createMergeRequestEvent(5)),
      taskService.enqueueMergeRequest(trigger.name, createMergeRequestEvent(5)),
      taskService.enqueueMergeRequest(trigger.name, createMergeRequestEvent(5, 5, 'opened')),
    ]);

    expect(inserted.filter(task => task !== null)).toHaveLength(2);
    expect((await tasksOf(trigger)).map(task => task.mergeRequestEvent).sort()).toEqual(['merged', 'opened']);
  });

  it('refuses a merge request task holding part of an issue, a label event or a fire time', async () => {
    const mergeRequest = {
      projectId: 7,
      mergeRequestIid: 8,
      mergeRequestEvent: 'merged',
      mergeRequestTitle: 'Merge request 8',
      mergeRequestUrl: 'https://gitlab.test/mr/8',
      sourceBranch: '8-branch',
      targetBranch: 'master',
    };

    const insert = (fields: Record<string, string | number | null>) =>
      dbQuery(
        app,
        `INSERT INTO task ("triggerName", "sourceName", "projectPath", "projectUrl", status, "queuedDate", "projectId",
           "issueIid", "issueTitle", "issueUrl", "changeKind", "changeId", "fireTime", cron, "mergeRequestIid",
           "mergeRequestEvent", "mergeRequestTitle", "mergeRequestUrl", "sourceBranch", "targetBranch")
         VALUES ('int-check-mr', $1, 'group/project', 'https://gitlab.test/group/project', 'queued', now(), $2, $3, $4,
           $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          TEST_SOURCE,
          fields.projectId,
          fields.issueIid ?? null,
          fields.issueTitle ?? null,
          fields.issueUrl ?? null,
          fields.changeKind ?? null,
          fields.changeId ?? null,
          fields.fireTime ?? null,
          fields.cron ?? null,
          fields.mergeRequestIid,
          fields.mergeRequestEvent,
          fields.mergeRequestTitle,
          fields.mergeRequestUrl,
          fields.sourceBranch,
          fields.targetBranch,
        ]
      );

    for (const fields of [
      { ...mergeRequest, issueIid: 1 },
      { ...mergeRequest, issueIid: 1, issueTitle: 'Issue 1', issueUrl: 'https://gitlab.test/i/1', changeId: 10 },
      { ...mergeRequest, fireTime: '2025-01-01T00:00:00Z', cron: '0 0 1 1 *' },
      { ...mergeRequest, projectId: null },
      { ...mergeRequest, targetBranch: null },
    ]) {
      await expect(insert(fields)).rejects.toThrow(/CHK_task_kind/);
    }

    await expect(insert(mergeRequest)).resolves.toBeDefined();
  });
});
