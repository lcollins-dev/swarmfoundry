import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskSteps1792785807242 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "task" ADD "step" int4 NOT NULL DEFAULT 0');

    await queryRunner.query(`
      ALTER TABLE "run"
        ADD "step" int4 NOT NULL DEFAULT 0,
        ADD "infrastructureFailure" boolean NOT NULL DEFAULT false,
        DROP CONSTRAINT "UQ_run_task_id_number",
        ADD CONSTRAINT "UQ_run_task_id_number_step" UNIQUE ("taskId", "number", "step")
    `);
  }

  public async down(): Promise<void> {
    // Not required
  }
}
