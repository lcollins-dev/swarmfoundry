import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMergeRequestTasks1792701850067 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task"
        DROP CONSTRAINT "CHK_task_issue_or_fire_time",
        ADD "mergeRequestIid" int4 NULL,
        ADD "mergeRequestEvent" varchar(16) NULL,
        ADD "mergeRequestTitle" text NULL,
        ADD "mergeRequestUrl" text NULL,
        ADD "sourceBranch" text NULL,
        ADD "targetBranch" text NULL,
        ADD CONSTRAINT "UQ_task_merge_request_event"
          UNIQUE ("triggerName", "sourceName", "projectId", "mergeRequestIid", "mergeRequestEvent"),
        ADD CONSTRAINT "CHK_task_kind" CHECK (
          ("fireTime" IS NULL AND "cron" IS NULL
            AND num_nulls("projectId", "issueIid", "issueTitle", "issueUrl", "labelEventId") = 0
            AND num_nonnulls("mergeRequestIid", "mergeRequestEvent", "mergeRequestTitle", "mergeRequestUrl",
              "sourceBranch", "targetBranch") = 0)
          OR ("fireTime" IS NOT NULL AND "cron" IS NOT NULL
            AND num_nonnulls("projectId", "issueIid", "issueTitle", "issueUrl", "labelEventId", "labelEventActor",
              "mergeRequestIid", "mergeRequestEvent", "mergeRequestTitle", "mergeRequestUrl", "sourceBranch",
              "targetBranch") = 0)
          OR (num_nulls("projectId", "mergeRequestIid", "mergeRequestEvent", "mergeRequestTitle", "mergeRequestUrl",
              "sourceBranch", "targetBranch") = 0
            AND num_nonnulls("fireTime", "cron", "labelEventId", "labelEventActor") = 0
            AND num_nulls("issueIid", "issueTitle", "issueUrl") IN (0, 3))
        )
    `);

    await queryRunner.query(`
      CREATE TABLE "merge_request_watermark" (
        "sourceName" text NOT NULL,
        "gitlabUrl" text NOT NULL,
        "projectId" int4 NOT NULL,
        "watermark" timestamp NOT NULL,
        CONSTRAINT "PK_merge_request_watermark" PRIMARY KEY ("sourceName", "gitlabUrl", "projectId")
      );
    `);
  }

  public async down(): Promise<void> {
    // Not required
  }
}
