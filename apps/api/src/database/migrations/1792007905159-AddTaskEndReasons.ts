import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskEndReasons1792007905159 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "task" ADD "cancelReason" text NULL, ADD "onFailureError" text NULL');
  }

  public async down(): Promise<void> {
    // Not required
  }
}
