import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFailureSteps1792847300436 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "task" ADD "list" varchar(16) NOT NULL DEFAULT \'steps\', DROP COLUMN "onFailureError"'
    );

    await queryRunner.query(`
      ALTER TABLE "run"
        ADD "list" varchar(16) NOT NULL DEFAULT 'steps',
        DROP CONSTRAINT "UQ_run_task_id_number_step",
        ADD CONSTRAINT "UQ_run_task_id_list_step_number" UNIQUE ("taskId", "list", "step", "number")
    `);
  }

  public async down(): Promise<void> {
    // Not required
  }
}
