import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddApiKeys1793559180648 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "api_key" (
        "id" serial NOT NULL,
        "keyId" varchar(32) NOT NULL,
        "name" varchar(128) NOT NULL,
        "secretHash" varchar(64) NOT NULL,
        "userId" int4 NOT NULL,
        "lastUsedDate" timestamp NULL,
        "createdDate" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_api_key_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_api_key_key_id" UNIQUE ("keyId"),
        CONSTRAINT "FK_api_key_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "api_key"`);
  }
}
