import { MigrationInterface, QueryRunner } from 'typeorm';

import { NotificationSeverity, UserRoleId } from '@libs/dto';

/** Password TestPass123! - e2e/utils/users.ts signs in with it. */
const TEST_ADMIN = {
  email: 'admin@swarmfoundry.test',
  passwordHash: '$2b$08$EPsK4q/GjVhp2gLpnj1txu7zBLms9evVxFOHSRKzr7RPqMyY3JSB6',
  name: 'Test Admin',
};

/**
 * Ids sit outside NotificationTypeId, which ships empty - a real app declares its own members
 * there and seeds them from InitialDBEntries instead.
 */
const NOTIFICATION_TYPES = [
  {
    id: 9001,
    name: 'Batch job finished',
    severity: NotificationSeverity.SUCCESS,
    pageUrl: '/admin/batch-jobs',
  },
  {
    id: 9002,
    name: 'Item one needs attention',
    severity: NotificationSeverity.WARNING,
    pageUrl: null,
  },
  {
    id: 9003,
    name: 'New user added',
    severity: NotificationSeverity.INFO,
    pageUrl: '/admin/users',
  },
  {
    id: 9004,
    name: 'Batch job failed',
    severity: NotificationSeverity.ERROR,
    pageUrl: '/admin/batch-jobs',
  },
];

const NOTIFICATIONS = [
  {
    notificationTypeId: 9001,
    desc: 'Nightly export completed in 42s.',
    minutesAgo: 2,
  },
  {
    notificationTypeId: 9002,
    desc: 'Re-check the configuration to keep it enabled.',
    minutesAgo: 120,
  },
  {
    notificationTypeId: 9003,
    desc: 'user-six@example.test joined this group.',
    minutesAgo: 1440,
  },
  {
    notificationTypeId: 9004,
    desc: 'Example job exited with status 1 on its last run.',
    minutesAgo: 4320,
  },
];

export class TestData9000000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const adminRows = (await queryRunner.query(
      `INSERT INTO "user" ("email", "passwordHash", "name", "enabled", "lastAccess", "createdDate")
       VALUES ($1, $2, $3, true, now(), now())
       RETURNING id`,
      [TEST_ADMIN.email, TEST_ADMIN.passwordHash, TEST_ADMIN.name]
    )) as { id: number }[];
    const adminUserId = adminRows[0].id;

    for (const userRoleId of [UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN]) {
      await queryRunner.query('INSERT INTO user_user_role ("userId", "userRoleId") VALUES ($1, $2);', [
        adminUserId,
        userRoleId,
      ]);
    }

    for (const notificationType of NOTIFICATION_TYPES) {
      await queryRunner.query(
        'INSERT INTO notification_type(id, "name", "severity", "pageUrl") VALUES ($1, $2, $3, $4);',
        [notificationType.id, notificationType.name, notificationType.severity, notificationType.pageUrl]
      );
    }

    for (const notification of NOTIFICATIONS) {
      await queryRunner.query(
        `INSERT INTO notification ("notificationTypeId", "userId", "desc", "cleared", "createdDate")
         VALUES ($1, $2, $3, false, now() - ($4 || ' minutes')::interval);`,
        [notification.notificationTypeId, adminUserId, notification.desc, notification.minutesAgo]
      );
    }
  }

  public async down(): Promise<void> {
    // Not required
  }
}
