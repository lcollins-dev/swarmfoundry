import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScheduledTasks1792617050504 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task"
        ALTER COLUMN "projectId" DROP NOT NULL,
        ALTER COLUMN "issueIid" DROP NOT NULL,
        ALTER COLUMN "issueTitle" DROP NOT NULL,
        ALTER COLUMN "issueUrl" DROP NOT NULL,
        ALTER COLUMN "labelEventId" DROP NOT NULL,
        ADD "fireTime" timestamp NULL,
        ADD "cron" text NULL,
        ADD CONSTRAINT "UQ_task_fire_time" UNIQUE ("triggerName", "fireTime"),
        ADD CONSTRAINT "CHK_task_issue_or_fire_time" CHECK (
          ("fireTime" IS NULL AND "cron" IS NULL
            AND num_nulls("projectId", "issueIid", "issueTitle", "issueUrl", "labelEventId") = 0)
          OR ("fireTime" IS NOT NULL AND "cron" IS NOT NULL
            AND num_nonnulls("projectId", "issueIid", "issueTitle", "issueUrl", "labelEventId", "labelEventActor") = 0)
        )
    `);
  }

  public async down(): Promise<void> {
    // Not required
  }
}
