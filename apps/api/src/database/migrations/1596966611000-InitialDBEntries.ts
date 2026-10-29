import { MigrationInterface, QueryRunner } from 'typeorm';

import { BatchJobId, UserRoleId } from '@libs/dto';

import { SysConfigId } from '@/core/sys-config/entities/sys-config.entity';

const USER_ROLES = [
  {
    id: UserRoleId.USER_ADMIN,
    name: 'User Admin',
  },
  {
    id: UserRoleId.SYSTEM_ADMIN,
    name: 'System Admin',
  },
];

/** Password changeme, documented in the deployment guide. First-time setup refuses it as the new password. */
const INITIAL_ADMIN = {
  email: 'admin@example.com',
  passwordHash: '$2b$08$oUSVn48gbl1cLzYIclqtce2zaC4upHqtf867j48aWpkcbp5DHyFe.',
  name: 'Admin',
  userRoleIds: [UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN],
};

const SYS_CONFIG_ENTRIES = [
  {
    id: SysConfigId.REGISTRATION_ENABLED,
    value: 'false',
  },
];

const BATCH_JOBS = [
  {
    id: BatchJobId.EXAMPLE,
    name: 'Example',
    desc: 'Example batch job',
    enabled: true,
  },
];

export class InitialDBEntries1596966611000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // User roles
    for (const userRole of USER_ROLES) {
      await queryRunner.query('INSERT INTO user_role(id, name) VALUES ($1, $2);', [userRole.id, userRole.name]);
    }

    await queryRunner.query(
      `INSERT INTO "user" ("email", "passwordHash", "name", "enabled", "mustChangePassword")
       VALUES ($1, $2, $3, true, true);`,
      [INITIAL_ADMIN.email, INITIAL_ADMIN.passwordHash, INITIAL_ADMIN.name]
    );

    for (const userRoleId of INITIAL_ADMIN.userRoleIds) {
      await queryRunner.query(
        'INSERT INTO user_user_role ("userId", "userRoleId") SELECT id, $2 FROM "user" WHERE email = $1;',
        [INITIAL_ADMIN.email, userRoleId]
      );
    }

    // sys-config
    for (const sysConfigEntry of SYS_CONFIG_ENTRIES) {
      await queryRunner.query('INSERT into sys_config(id, "valueJson") VALUES ($1, $2);', [
        sysConfigEntry.id,
        sysConfigEntry.value,
      ]);
    }

    // batch-job
    for (const batchJob of BATCH_JOBS) {
      await queryRunner.query('INSERT INTO batch_job(id, "name", "desc", enabled) VALUES ($1, $2, $3, $4)', [
        batchJob.id,
        batchJob.name,
        batchJob.desc,
        batchJob.enabled,
      ]);
    }
  }

  public async down(): Promise<void> {
    // Not required
  }
}
