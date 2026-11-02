import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPasswordLinks1793557946499 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" ALTER COLUMN "passwordHash" DROP NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "password_link" (
        "id" serial NOT NULL,
        "tokenHash" varchar(64) NOT NULL,
        "userId" int4 NOT NULL,
        "expiresAt" timestamp NOT NULL,
        "usedAt" timestamp NULL,
        "createdDate" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_password_link_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_password_link_token_hash" UNIQUE ("tokenHash"),
        CONSTRAINT "FK_password_link_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "password_link"`);

    // An invited user who never chose a password has nothing the old code can sign in with.
    await queryRunner.query(`DELETE FROM "user" WHERE "passwordHash" IS NULL`);
    await queryRunner.query(`ALTER TABLE "user" ALTER COLUMN "passwordHash" SET NOT NULL`);
  }
}
