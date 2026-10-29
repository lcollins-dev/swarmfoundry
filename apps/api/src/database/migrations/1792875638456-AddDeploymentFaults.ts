import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeploymentFaults1792875638456 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "run" ADD "deploymentFault" varchar(16)');

    await queryRunner.query('UPDATE "run" SET "deploymentFault" = \'transient\' WHERE "infrastructureFailure"');

    await queryRunner.query('ALTER TABLE "run" DROP COLUMN "infrastructureFailure"');
  }

  public async down(): Promise<void> {
    // Not required
  }
}
