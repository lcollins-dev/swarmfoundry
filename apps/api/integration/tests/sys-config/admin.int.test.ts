import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { UserRoleId } from '@libs/dto';

import { login } from '../../clients/user.client';
import { createTestUser } from '../../factories/user.factory';
import { bootstrapApp } from '../../setup';
import { authHeaders } from '../../utils/auth';

const SYS_CONFIG_ROUTE = '/api/v1/admin/sys-config';

describe('Sys config admin route (integration)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get(SYS_CONFIG_ROUTE).expect(401);
  });

  it('rejects a user without the SYSTEM_ADMIN role', async () => {
    const user = await createTestUser(app);
    const token = await login(app, user.email);

    await request(app.getHttpServer()).get(SYS_CONFIG_ROUTE).set(authHeaders(token)).expect(403);
  });

  it('rejects a USER_ADMIN who is not a SYSTEM_ADMIN', async () => {
    const admin = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });
    const token = await login(app, admin.email);

    await request(app.getHttpServer()).get(SYS_CONFIG_ROUTE).set(authHeaders(token)).expect(403);
  });

  it('allows a SYSTEM_ADMIN to read the config', async () => {
    const admin = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
    const token = await login(app, admin.email);

    const response = await request(app.getHttpServer()).get(SYS_CONFIG_ROUTE).set(authHeaders(token)).expect(200);

    expect(typeof response.body.registrationEnabled).toBe('boolean');
  });

  it('rejects a non-boolean registration flag', async () => {
    const admin = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
    const token = await login(app, admin.email);

    await request(app.getHttpServer())
      .patch(SYS_CONFIG_ROUTE)
      .set(authHeaders(token))
      .send({ registrationEnabled: 'yes' })
      .expect(400);
  });
});
