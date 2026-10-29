import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConfigRevisions1792530607877 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "config_revision" (
        "id" serial NOT NULL,
        "sha" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL,
        "errors" jsonb NOT NULL,
        "seenDate" timestamp NOT NULL,
        "currentDate" timestamp NULL,
        CONSTRAINT "PK_config_revision_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_config_revision_sha" UNIQUE ("sha")
      );
    `);

    await queryRunner.query(`
      ALTER TABLE "task"
        ADD "configId" int4 NULL,
        ADD CONSTRAINT "FK_task_config_revision" FOREIGN KEY ("configId") REFERENCES "config_revision"("id")
          ON DELETE RESTRICT
    `);

    await queryRunner.query(`
      ALTER TABLE "run"
        ADD "configId" int4 NULL,
        ADD CONSTRAINT "FK_run_config_revision" FOREIGN KEY ("configId") REFERENCES "config_revision"("id")
          ON DELETE RESTRICT
    `);
  }

  public async down(): Promise<void> {
    // Not required
  }
}
