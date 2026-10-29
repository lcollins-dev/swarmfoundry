import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTasks1791989380438 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "task" (
        "id" serial NOT NULL,
        "triggerName" text NOT NULL,
        "sourceName" text NOT NULL,
        "projectId" int4 NOT NULL,
        "projectPath" text NOT NULL,
        "projectUrl" text NOT NULL,
        "issueIid" int4 NOT NULL,
        "issueTitle" text NOT NULL,
        "issueUrl" text NOT NULL,
        "labelEventId" int8 NOT NULL,
        "labelEventActor" varchar(255) NULL,
        "status" varchar(16) NOT NULL,
        "queuedDate" timestamp NOT NULL,
        "notBeforeDate" timestamp NULL,
        "endDate" timestamp NULL,
        CONSTRAINT "PK_task_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_task_label_change" UNIQUE ("triggerName", "sourceName", "projectId", "issueIid", "labelEventId")
      );
    `);

    await queryRunner.query(
      'CREATE INDEX "IDX_task_trigger_name_status_queued_date" ON "task" ("triggerName", "status", "queuedDate")'
    );

    await queryRunner.query(`
      CREATE TABLE "run" (
        "id" serial NOT NULL,
        "taskId" int4 NOT NULL,
        "number" int4 NOT NULL,
        "startDate" timestamp NOT NULL,
        "endDate" timestamp NULL,
        "containerId" varchar(128) NULL,
        "exitCode" int4 NULL,
        "result" text NULL,
        "error" text NULL,
        "outcome" varchar(16) NULL,
        CONSTRAINT "PK_run_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_run_task_id_number" UNIQUE ("taskId", "number"),
        CONSTRAINT "FK_run_task" FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "run_transcript_line" (
        "runId" int4 NOT NULL,
        "lineNumber" int4 NOT NULL,
        "line" text NOT NULL,
        "createdDate" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_run_transcript_line" PRIMARY KEY ("runId", "lineNumber"),
        CONSTRAINT "FK_run_transcript_line_run" FOREIGN KEY ("runId") REFERENCES "run"("id") ON DELETE CASCADE
      );
    `);
  }

  public async down(): Promise<void> {
    // Not required
  }
}
