import { MigrationInterface, QueryRunner } from 'typeorm';

export class KeyTasksOnIssueChanges1792945285781 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "task" RENAME COLUMN "labelEventId" TO "changeId"');
    await queryRunner.query('ALTER TABLE "task" RENAME COLUMN "labelEventActor" TO "changeActor"');

    await queryRunner.query(`
      ALTER TABLE "task"
        ADD "changeKind" varchar(16) NULL,
        ADD "changeDate" timestamp NULL
    `);

    // The label event's own time was never stored. Its task was queued just after it.
    await queryRunner.query(`
      UPDATE "task"
        SET "changeKind" = 'label', "changeDate" = "queuedDate"
        WHERE "changeId" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "task"
        DROP CONSTRAINT "UQ_task_label_change",
        DROP CONSTRAINT "CHK_task_kind",
        ADD CONSTRAINT "UQ_task_issue_change"
          UNIQUE ("triggerName", "sourceName", "projectId", "issueIid", "changeKind", "changeId"),
        ADD CONSTRAINT "CHK_task_kind" CHECK (
          ("fireTime" IS NULL AND "cron" IS NULL
            AND num_nulls("projectId", "issueIid", "issueTitle", "issueUrl", "changeKind", "changeId", "changeDate") = 0
            AND num_nonnulls("mergeRequestIid", "mergeRequestEvent", "mergeRequestTitle", "mergeRequestUrl",
              "sourceBranch", "targetBranch") = 0)
          OR ("fireTime" IS NOT NULL AND "cron" IS NOT NULL
            AND num_nonnulls("projectId", "issueIid", "issueTitle", "issueUrl", "changeKind", "changeId", "changeDate",
              "changeActor", "mergeRequestIid", "mergeRequestEvent", "mergeRequestTitle", "mergeRequestUrl",
              "sourceBranch", "targetBranch") = 0)
          OR (num_nulls("projectId", "mergeRequestIid", "mergeRequestEvent", "mergeRequestTitle", "mergeRequestUrl",
              "sourceBranch", "targetBranch") = 0
            AND num_nonnulls("fireTime", "cron", "changeKind", "changeId", "changeDate", "changeActor") = 0
            AND num_nulls("issueIid", "issueTitle", "issueUrl") IN (0, 3))
        )
    `);

    // Each project starts watching its issues afresh, so no change from before the new key fires a second task.
    await queryRunner.query(`DELETE FROM "source_watermark" WHERE "kind" = 'issue'`);
  }

  public async down(): Promise<void> {
    // Not required
  }
}
