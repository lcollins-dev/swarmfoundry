import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIssueWatermarks1792895754388 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "merge_request_watermark"
        RENAME TO "source_watermark"
    `);

    await queryRunner.query(`
      ALTER TABLE "source_watermark"
        ADD "kind" varchar(16) NOT NULL DEFAULT 'mergeRequest',
        DROP CONSTRAINT "PK_merge_request_watermark",
        ADD CONSTRAINT "PK_source_watermark" PRIMARY KEY ("kind", "sourceName", "gitlabUrl", "projectId")
    `);

    await queryRunner.query('ALTER TABLE "source_watermark" ALTER COLUMN "kind" DROP DEFAULT');
  }

  public async down(): Promise<void> {
    // Not required
  }
}
