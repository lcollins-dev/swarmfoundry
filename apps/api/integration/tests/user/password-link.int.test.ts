import { NestExpressApplication } from '@nestjs/platform-express';
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { PasswordLinkState, UserRoleId } from '@libs/dto';

import {
  checkPasswordLink,
  createPasswordLink,
  getProfile,
  getUser,
  inviteUser,
  linkToken,
  login,
  setPassword,
  updateUserState,
} from '../../clients/user.client';
import { createTestUser } from '../../factories/user.factory';
import { bootstrapApp } from '../../setup';
import { dbQuery } from '../../utils/db';

const NEW_PASSWORD = 'An0ther$Pass';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('Password links (integration)', () => {
  let app: NestExpressApplication;
  let adminToken: string;

  beforeAll(async () => {
    app = await bootstrapApp();

    const admin = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });
    adminToken = await login(app, admin.email);
  });

  const invite = async () => {
    const email = `int-link-${randomUUID()}@swarmfoundry.test`;
    const response = await inviteUser(app, adminToken, { name: 'Invited User', email, userRoleIds: [] }).expect(201);

    return { email, userId: Number(response.body.userId), token: linkToken(String(response.body.passwordLink.link)) };
  };

  const resetLink = async (userId: number) => {
    const response = await createPasswordLink(app, adminToken, userId).expect(201);

    return linkToken(String(response.body.link));
  };

  describe('an invite', () => {
    it('reads as a valid invite for its user', async () => {
      const { email, token } = await invite();

      const response = await checkPasswordLink(app, { token }).expect(200);

      expect(response.body).toMatchObject({
        state: PasswordLinkState.VALID,
        passwordLink: { name: 'Invited User', email, invite: true },
      });
    });

    it('sets the password and signs the user in', async () => {
      const { email, userId, token } = await invite();

      const response = await setPassword(app, { token, password: NEW_PASSWORD }).expect(200);

      await getProfile(app, String(response.body.token)).expect(200);
      await login(app, email, NEW_PASSWORD);

      const user = await getUser(app, adminToken, userId).expect(200);
      expect(user.body.invited).toBe(false);
    });

    it('stores only the hash of its token', async () => {
      const { userId, token } = await invite();

      const rows = await dbQuery<{ tokenHash: string }>(
        app,
        'SELECT "tokenHash" FROM "password_link" WHERE "userId" = $1',
        [userId]
      );

      expect(rows).toEqual([{ tokenHash: sha256(token) }]);
    });
  });

  describe('a reset link', () => {
    it('reads as a reset for a user who has a password', async () => {
      const user = await createTestUser(app);
      const token = await resetLink(user.id);

      const response = await checkPasswordLink(app, { token }).expect(200);

      expect(response.body.passwordLink.invite).toBe(false);
    });

    it("ends the user's other sessions", async () => {
      const user = await createTestUser(app);
      const oldSession = await login(app, user.email);
      const token = await resetLink(user.id);

      const response = await setPassword(app, { token, password: NEW_PASSWORD }).expect(200);

      await getProfile(app, oldSession).expect(401);
      await getProfile(app, String(response.body.token)).expect(200);
    });
  });

  describe('a link that no longer works', () => {
    it('works only once', async () => {
      const { token } = await invite();

      await setPassword(app, { token, password: NEW_PASSWORD }).expect(200);
      await setPassword(app, { token, password: 'Th1rd$Pass' }).expect(400);

      const response = await checkPasswordLink(app, { token }).expect(200);
      expect(response.body).toEqual({ state: PasswordLinkState.USED, passwordLink: null });
    });

    it('stops working once expired', async () => {
      const { userId, token } = await invite();

      await dbQuery(app, `UPDATE "password_link" SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = $1`, [
        userId,
      ]);

      const response = await checkPasswordLink(app, { token }).expect(200);
      expect(response.body.state).toBe(PasswordLinkState.EXPIRED);

      await setPassword(app, { token, password: NEW_PASSWORD }).expect(400);
    });

    it('stops working when a newer link is made for the same user', async () => {
      const { userId, token: oldToken } = await invite();
      const newToken = await resetLink(userId);

      const response = await checkPasswordLink(app, { token: oldToken }).expect(200);
      expect(response.body.state).toBe(PasswordLinkState.INVALID);

      await setPassword(app, { token: oldToken, password: NEW_PASSWORD }).expect(400);
      await setPassword(app, { token: newToken, password: NEW_PASSWORD }).expect(200);
    });

    it('stops working when the account is disabled, and stays dead once enabled again', async () => {
      const user = await createTestUser(app);
      const token = await resetLink(user.id);

      await updateUserState(app, adminToken, user.id, { enabled: false }).expect(200);
      await updateUserState(app, adminToken, user.id, { enabled: true }).expect(200);

      const response = await checkPasswordLink(app, { token }).expect(200);
      expect(response.body.state).toBe(PasswordLinkState.INVALID);
    });

    it('reads an unknown token as invalid', async () => {
      const response = await checkPasswordLink(app, { token: 'f'.repeat(64) }).expect(200);

      expect(response.body).toEqual({ state: PasswordLinkState.INVALID, passwordLink: null });
    });
  });

  describe('validation', () => {
    it('rejects a malformed token', async () => {
      await checkPasswordLink(app, { token: 'not-a-token' }).expect(400);
    });

    it('rejects a weak password and leaves the link working', async () => {
      const { token } = await invite();

      await setPassword(app, { token, password: 'weak' }).expect(400);

      const response = await checkPasswordLink(app, { token }).expect(200);
      expect(response.body.state).toBe(PasswordLinkState.VALID);
    });
  });
});
