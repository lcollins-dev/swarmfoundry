import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { authHeaders } from '../utils/auth';

export const createApiKey = (app: NestExpressApplication, token: string, body: Record<string, unknown>) =>
  request(app.getHttpServer()).post('/api/v1/admin/api-key').set(authHeaders(token)).send(body);

export const getApiKeyList = (app: NestExpressApplication, token: string) =>
  request(app.getHttpServer()).get('/api/v1/admin/api-key/list').set(authHeaders(token));

export const getUserApiKeyList = (app: NestExpressApplication, token: string, userId: number) =>
  request(app.getHttpServer()).get(`/api/v1/admin/api-key/user/${userId}`).set(authHeaders(token));

export const revokeApiKey = (app: NestExpressApplication, token: string, apiKeyId: number) =>
  request(app.getHttpServer()).delete(`/api/v1/admin/api-key/${apiKeyId}`).set(authHeaders(token));

export const issueApiKey = async (app: NestExpressApplication, token: string, name = 'Laptop'): Promise<string> => {
  const response = await createApiKey(app, token, { name }).expect(201);

  return String(response.body.token);
};
