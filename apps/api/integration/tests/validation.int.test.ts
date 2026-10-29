import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { UserRoleId } from '@libs/dto';

import { login } from '../clients/user.client';
import { createTestUser } from '../factories/user.factory';
import { bootstrapApp } from '../setup';
import { authHeaders } from '../utils/auth';

const PROFILE_ROUTE = '/api/v1/user/profile';

describe('Request validation (integration)', () => {
  let app: NestExpressApplication;
  let token: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await bootstrapApp();

    const user = await createTestUser(app);
    token = await login(app, user.email);

    const admin = await createTestUser(app, { roleIds: [UserRoleId.USER_ADMIN] });
    adminToken = await login(app, admin.email);
  });

  it('rejects a body missing a required property', async () => {
    await request(app.getHttpServer()).patch(PROFILE_ROUTE).set(authHeaders(token)).send({}).expect(400);
  });

  it('rejects a body carrying a property the dto does not declare', async () => {
    await request(app.getHttpServer())
      .patch(PROFILE_ROUTE)
      .set(authHeaders(token))
      .send({ name: 'Valid Name', email: 'valid@swarmfoundry.test', notADeclaredField: 'nope' })
      .expect(400);
  });

  it('names the offending field in the validation response', async () => {
    const response = await request(app.getHttpServer())
      .patch(PROFILE_ROUTE)
      .set(authHeaders(token))
      .send({ name: 'x', email: 'valid@swarmfoundry.test' })
      .expect(400);

    const paths = Array.isArray(response.body.message)
      ? response.body.message.map((error: { path: string }) => error.path)
      : [];

    expect(paths).toContain('name');
  });

  it('rejects a non-numeric route parameter', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/user/not-a-number').set(authHeaders(adminToken)).expect(400);
  });

  it('rejects a route parameter beyond the int4 upper bound', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/user/2147483648').set(authHeaders(adminToken)).expect(400);
  });
});
