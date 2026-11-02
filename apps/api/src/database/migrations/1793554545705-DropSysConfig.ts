import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropSysConfig1793554545705 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "sys_config"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "sys_config" (
        "id" int4 NOT NULL,
        "valueJson" text NOT NULL,
        CONSTRAINT "PK_sys_config_id" PRIMARY KEY ("id")
      )
    `);

    // Code from before this migration fails without the registration flag the initial entries seeded.
    await queryRunner.query(`INSERT INTO "sys_config" ("id", "valueJson") VALUES (100, 'false')`);
  }
}
