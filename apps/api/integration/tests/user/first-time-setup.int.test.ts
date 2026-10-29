import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { UserRoleId } from '@libs/dto';

import { SETUP_REQUIRED_MESSAGE } from '@/api/v1/user/guards/auth.guard';

import { getNotificationList } from '../../clients/notification.client';
import { getProfile, getUserStats, login, logout } from '../../clients/user.client';
import { bootstrapApp } from '../../setup';
import { authHeaders } from '../../utils/auth';

// Seeded by migrations/1596966611000-InitialDBEntries.ts, which documents the password.
const INITIAL_ADMIN = { email: 'admin@example.com', password: 'changeme' };

const NEW_PASSWORD = 'S3tup$Done';

const updateProfile = (app: NestExpressApplication, token: string, body: Record<string, unknown>) =>
  request(app.getHttpServer()).patch('/api/v1/user/profile').set(authHeaders(token)).send(body);

describe('First-time setup (integration)', () => {
  let app: NestExpressApplication;
  let token: string;

  beforeAll(async () => {
    app = await bootstrapApp();

    token = await login(app, INITIAL_ADMIN.email, INITIAL_ADMIN.password);
  });

  it('signs the seeded admin in with the documented password, with both admin roles and the hold set', async () => {
    const response = await getProfile(app, token).expect(200);

    expect(response.body).toMatchObject({
      email: INITIAL_ADMIN.email,
      userRoleIds: [UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN],
      mustChangePassword: true,
    });
  });

  it('refuses every other route, admin roles notwithstanding', async () => {
    const refusals = [
      () => getUserStats(app, token),
      () => getNotificationList(app, token),
      () => request(app.getHttpServer()).get('/api/v1/admin/sys-config').set(authHeaders(token)),
    ];

    for (const refusal of refusals) {
      const response = await refusal().expect(403);

      expect(response.body.message).toBe(SETUP_REQUIRED_MESSAGE);
    }
  });

  it('keeps the hold through a profile change that leaves the password alone', async () => {
    await updateProfile(app, token, { name: 'Setup Admin', email: INITIAL_ADMIN.email }).expect(200);

    const response = await getProfile(app, token).expect(200);

    expect(response.body).toMatchObject({ name: 'Setup Admin', mustChangePassword: true });
  });

  it('refuses the documented password as the new one', async () => {
    await updateProfile(app, token, {
      name: 'Setup Admin',
      email: INITIAL_ADMIN.email,
      password: INITIAL_ADMIN.password,
    }).expect(400);

    await getUserStats(app, token).expect(403);
  });

  it('signs out while held to setup', async () => {
    await logout(app, token).expect(201);
    await getProfile(app, token).expect(401);

    token = await login(app, INITIAL_ADMIN.email, INITIAL_ADMIN.password);
  });

  it('lifts the hold with a password change, after which every route is open', async () => {
    const response = await updateProfile(app, token, {
      name: 'Setup Admin',
      email: INITIAL_ADMIN.email,
      password: NEW_PASSWORD,
    }).expect(200);

    token = String(response.body.token);

    const profile = await getProfile(app, token).expect(200);
    expect(profile.body.mustChangePassword).toBe(false);

    await getUserStats(app, token).expect(200);
    await login(app, INITIAL_ADMIN.email, NEW_PASSWORD);
  });
});
