import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { UserRoleId } from '@libs/dto';

import {
  createPasswordLink,
  getProfile,
  getUser,
  inviteUser,
  login,
  loginRequest,
  logoutAllSessions,
  updateUser,
  updateUserState,
} from '../../clients/user.client';
import { createTestUser, ITestUser, TEST_PASSWORD } from '../../factories/user.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';

const buildInviteBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Invited User',
  email: `int-admin-${randomUUID()}@swarmfoundry.test`,
  userRoleIds: [],
  ...overrides,
});

describe('Admin user management (integration)', () => {
  let app: NestExpressApplication;
  let admin: ITestUser;
  let token: string;

  beforeAll(async () => {
    app = await bootstrapApp();

    admin = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });
    token = await login(app, admin.email);
  });

  describe('inviting', () => {
    it('answers the new user id and a link to choose a password', async () => {
      const response = await inviteUser(app, token, buildInviteBody()).expect(201);

      expect(response.body.userId).toBeGreaterThan(0);
      expect(response.body.passwordLink.link).toMatch(/\/set-password#[0-9a-f]{64}$/);
      expect(typeof response.body.passwordLink.expiresAt).toBe('string');
      expect(typeof response.body.passwordLink.emailed).toBe('boolean');
    });

    it('stores the user without a password, so they cannot sign in yet', async () => {
      const body = buildInviteBody();

      const response = await inviteUser(app, token, body).expect(201);

      const rows = await dbQuery<{ passwordHash: string | null }>(
        app,
        'SELECT "passwordHash" FROM "user" WHERE id = $1',
        [response.body.userId]
      );

      expect(rows[0].passwordHash).toBeNull();
      await loginRequest(app, { email: body.email, password: '' }).expect(400);
    });

    it('marks the user as invited', async () => {
      const response = await inviteUser(app, token, buildInviteBody()).expect(201);

      const invited = await getUser(app, token, response.body.userId).expect(200);

      expect(invited.body.invited).toBe(true);
    });

    it('stores the requested roles', async () => {
      const body = buildInviteBody({ userRoleIds: [UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN] });

      const response = await inviteUser(app, token, body).expect(201);

      const invited = await getUser(app, token, response.body.userId).expect(200);

      expect(invited.body.userRoleIds).toEqual(
        expect.arrayContaining([UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN])
      );
    });

    it('rejects a duplicate email', async () => {
      const body = buildInviteBody();

      await inviteUser(app, token, body).expect(201);
      await inviteUser(app, token, body).expect(400);
    });

    it('rejects an email that differs only by case', async () => {
      const body = buildInviteBody();

      await inviteUser(app, token, body).expect(201);
      await inviteUser(app, token, { ...body, email: body.email.toUpperCase() }).expect(400);
    });

    it('rejects a malformed email', async () => {
      await inviteUser(app, token, buildInviteBody({ email: 'not-an-email' })).expect(400);
    });

    it('rejects a password, which only the invited user chooses', async () => {
      await inviteUser(app, token, buildInviteBody({ password: TEST_PASSWORD })).expect(400);
    });

    it('rejects a role id that is not a known role', async () => {
      await inviteUser(app, token, buildInviteBody({ userRoleIds: [9999] })).expect(400);
    });
  });

  describe('making a password link', () => {
    it('answers a link for another user', async () => {
      const user = await createTestUser(app);

      const response = await createPasswordLink(app, token, user.id).expect(201);

      expect(response.body.link).toMatch(/\/set-password#[0-9a-f]{64}$/);
    });

    it("refuses a link for the caller's own account", async () => {
      await createPasswordLink(app, token, admin.id).expect(400);
    });

    it('refuses a link for a disabled account', async () => {
      const user = await createTestUser(app, { enabled: false });

      await createPasswordLink(app, token, user.id).expect(400);
    });

    it('rejects a user id that does not exist', async () => {
      await createPasswordLink(app, token, 2147483647).expect(400);
    });
  });

  describe('reading', () => {
    it('returns the user with role ids and serialised dates', async () => {
      const user = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });

      const response = await getUser(app, token, user.id).expect(200);

      expect(response.body).toMatchObject({
        id: user.id,
        email: user.email,
        enabled: true,
        userRoleIds: [UserRoleId.USER_ADMIN],
      });
      expect(typeof response.body.createdDate).toBe('string');
      expect(response.body.lastLoginSuccess).toBeNull();
    });

    it('records the last successful login once the user signs in', async () => {
      const user = await createTestUser(app);
      await login(app, user.email);

      const response = await getUser(app, token, user.id).expect(200);

      expect(typeof response.body.lastLoginSuccess).toBe('string');
    });

    it('rejects a user id that does not exist', async () => {
      await getUser(app, token, 2147483647).expect(400);
    });

    it('rejects a user id that is not an integer', async () => {
      await getUser(app, token, 'abc').expect(400);
    });
  });

  describe('updating', () => {
    it('renames the user and replaces the role set', async () => {
      const user = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });

      await updateUser(app, token, user.id, {
        name: 'Renamed',
        email: user.email,
        userRoleIds: [UserRoleId.SYSTEM_ADMIN],
      }).expect(200);

      const response = await getUser(app, token, user.id).expect(200);

      expect(response.body.name).toBe('Renamed');
      expect(response.body.userRoleIds).toEqual([UserRoleId.SYSTEM_ADMIN]);
    });

    it('strips every role when an empty set is sent', async () => {
      const user = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });

      await updateUser(app, token, user.id, { name: user.name, email: user.email, userRoleIds: [] }).expect(200);

      const response = await getUser(app, token, user.id).expect(200);

      expect(response.body.userRoleIds).toEqual([]);
    });

    it('rejects a password field on an update', async () => {
      const user = await createTestUser(app);

      await updateUser(app, token, user.id, {
        name: user.name,
        email: user.email,
        password: 'An0ther$Pass',
        userRoleIds: [],
      }).expect(400);
    });

    it("refuses a change to the caller's own roles", async () => {
      await updateUser(app, token, admin.id, { name: admin.name, email: admin.email, userRoleIds: [] }).expect(400);

      const response = await getUser(app, token, admin.id).expect(200);

      expect(response.body.userRoleIds).toEqual([UserRoleId.USER_ADMIN]);
    });

    it('lets the caller save their own profile while keeping their roles', async () => {
      await updateUser(app, token, admin.id, {
        name: admin.name,
        email: admin.email,
        userRoleIds: [UserRoleId.USER_ADMIN],
      }).expect(200);
    });

    it('leaves a session alone', async () => {
      const user = await createTestUser(app);
      const userToken = await login(app, user.email);

      await updateUser(app, token, user.id, { name: 'Renamed', email: user.email, userRoleIds: [] }).expect(200);

      await getProfile(app, userToken).expect(200);
    });

    it('leaves the password alone', async () => {
      const user = await createTestUser(app);

      await updateUser(app, token, user.id, { name: 'Renamed', email: user.email, userRoleIds: [] }).expect(200);

      await login(app, user.email);
    });

    it('rejects an email already held by another user', async () => {
      const user = await createTestUser(app);
      const other = await createTestUser(app);

      await updateUser(app, token, user.id, { name: user.name, email: other.email, userRoleIds: [] }).expect(400);
    });

    it('rejects a user id that does not exist', async () => {
      await updateUser(app, token, 2147483647, {
        name: 'Ghost',
        email: `int-admin-${randomUUID()}@swarmfoundry.test`,
        userRoleIds: [],
      }).expect(400);
    });
  });

  describe('enabling and disabling', () => {
    it('records the account as disabled', async () => {
      const user = await createTestUser(app);

      await updateUserState(app, token, user.id, { enabled: false }).expect(200);

      const response = await getUser(app, token, user.id).expect(200);
      expect(response.body.enabled).toBe(false);

      const rows = await dbQuery<{ enabled: boolean }>(app, 'SELECT enabled FROM "user" WHERE id = $1', [user.id]);
      expect(rows[0].enabled).toBe(false);
    });

    it('refuses to sign a disabled account in', async () => {
      const user = await createTestUser(app);

      await updateUserState(app, token, user.id, { enabled: false }).expect(200);

      const response = await loginRequest(app, { email: user.email, password: TEST_PASSWORD }).expect(400);

      expect(response.body.message).toBe('This account has been disabled.');
    });

    it('keeps a wrong password on a disabled account indistinguishable from any bad login', async () => {
      const user = await createTestUser(app, { enabled: false });

      const response = await loginRequest(app, { email: user.email, password: 'not-the-password' }).expect(400);

      expect(response.body.message).not.toBe('This account has been disabled.');
    });

    it('invalidates the session of a user who is disabled after signing in', async () => {
      const user = await createTestUser(app);
      const userToken = await login(app, user.email);

      await getProfile(app, userToken).expect(200);

      await updateUserState(app, token, user.id, { enabled: false }).expect(200);

      await getProfile(app, userToken).expect(401);
    });

    it('lets a re-enabled user back in', async () => {
      const user = await createTestUser(app, { enabled: false });

      await updateUserState(app, token, user.id, { enabled: true }).expect(200);

      const userToken = await login(app, user.email);

      await getProfile(app, userToken).expect(200);
    });

    it("refuses to disable the caller's own account", async () => {
      await updateUserState(app, token, admin.id, { enabled: false }).expect(400);

      const response = await getUser(app, token, admin.id).expect(200);

      expect(response.body.enabled).toBe(true);
    });

    it('keeps a session from coming back when the account is enabled again', async () => {
      const user = await createTestUser(app);
      const userToken = await login(app, user.email);

      await updateUserState(app, token, user.id, { enabled: false }).expect(200);
      await updateUserState(app, token, user.id, { enabled: true }).expect(200);

      await getProfile(app, userToken).expect(401);
    });

    it('rejects a non-boolean enabled flag', async () => {
      const user = await createTestUser(app);

      await updateUserState(app, token, user.id, { enabled: 'yes' }).expect(400);
    });

    it('rejects a user id that does not exist', async () => {
      await updateUserState(app, token, 2147483647, { enabled: false }).expect(400);
    });
  });

  describe('logging out every session', () => {
    it('invalidates the token the user is holding', async () => {
      const user = await createTestUser(app);
      const userToken = await login(app, user.email);

      await getProfile(app, userToken).expect(200);

      await logoutAllSessions(app, token, user.id).expect(200);

      await getProfile(app, userToken).expect(401);
    });

    it('leaves the user able to sign in again', async () => {
      const user = await createTestUser(app);
      const userToken = await login(app, user.email);

      await logoutAllSessions(app, token, user.id).expect(200);

      const freshToken = await login(app, user.email);

      expect(freshToken).not.toBe(userToken);
      await getProfile(app, freshToken).expect(200);
    });
  });
});
