import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { UserRoleId } from '@libs/dto';

import { login } from '../../clients/user.client';
import { createTestUser } from '../../factories/user.factory';
import { bootstrapApp } from '../../setup';
import { authHeaders } from '../../utils/auth';

const SYS_CONFIG_ROUTE = '/api/v1/admin/sys-config';
const REGISTER_ROUTE = '/api/v1/user/register';

// Flipping registration changes what every other spec sees, so this file owns its app.
describe('Registration toggle (integration, serial)', () => {
  let app: NestExpressApplication;
  let token: string;

  const setRegistrationEnabled = (registrationEnabled: boolean) =>
    request(app.getHttpServer()).patch(SYS_CONFIG_ROUTE).set(authHeaders(token)).send({ registrationEnabled });

  beforeAll(async () => {
    app = await bootstrapApp();

    const admin = await createTestUser(app, { roleIds: [UserRoleId.SYSTEM_ADMIN] });
    token = await login(app, admin.email);
  });

  it('starts with registration disabled', async () => {
    const response = await request(app.getHttpServer()).get(SYS_CONFIG_ROUTE).set(authHeaders(token)).expect(200);

    expect(response.body.registrationEnabled).toBe(false);
  });

  it('opens registration to the public once enabled', async () => {
    await setRegistrationEnabled(true).expect(200);

    const canRegister = await request(app.getHttpServer()).get(REGISTER_ROUTE).expect(200);
    expect(canRegister.body.canRegister).toBe(true);

    const email = `int-register-${randomUUID()}@swarmfoundry.test`;

    const registered = await request(app.getHttpServer())
      .post(REGISTER_ROUTE)
      .send({ name: 'Registered User', email, password: 'ValidPass1!' })
      .expect(201);

    expect(typeof registered.body.token).toBe('string');
  });

  it('rejects a second registration with the same email', async () => {
    await setRegistrationEnabled(true).expect(200);

    const email = `int-register-${randomUUID()}@swarmfoundry.test`;
    const body = { name: 'Registered User', email, password: 'ValidPass1!' };

    await request(app.getHttpServer()).post(REGISTER_ROUTE).send(body).expect(201);
    await request(app.getHttpServer()).post(REGISTER_ROUTE).send(body).expect(400);
  });

  it('closes registration again once disabled', async () => {
    await setRegistrationEnabled(false).expect(200);

    const canRegister = await request(app.getHttpServer()).get(REGISTER_ROUTE).expect(200);
    expect(canRegister.body.canRegister).toBe(false);

    await request(app.getHttpServer())
      .post(REGISTER_ROUTE)
      .send({
        name: 'Registered User',
        email: `int-register-${randomUUID()}@swarmfoundry.test`,
        password: 'ValidPass1!',
      })
      .expect(404);
  });

  it('persists the flag to the database', async () => {
    await setRegistrationEnabled(true).expect(200);

    const response = await request(app.getHttpServer()).get(SYS_CONFIG_ROUTE).set(authHeaders(token)).expect(200);

    expect(response.body.registrationEnabled).toBe(true);

    await setRegistrationEnabled(false).expect(200);
  });
});
