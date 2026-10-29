import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapApp } from '../../setup';

const REGISTER_ROUTE = '/api/v1/user/register';

describe('Self registration (integration)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  it('reports registration as disabled by default', async () => {
    const response = await request(app.getHttpServer()).get(REGISTER_ROUTE).expect(200);

    expect(response.body.canRegister).toBe(false);
  });

  it('returns not found when registering while disabled', async () => {
    await request(app.getHttpServer())
      .post(REGISTER_ROUTE)
      .send({ name: 'Someone', email: 'someone@swarmfoundry.test', password: 'ValidPass1!' })
      .expect(404);
  });

  it('does not require a token to reach either route', async () => {
    await request(app.getHttpServer()).get(REGISTER_ROUTE).expect(200);
  });
});
