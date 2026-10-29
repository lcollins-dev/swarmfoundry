import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { authHeaders } from '../utils/auth';

export const getTaskList = (app: NestExpressApplication, token: string, query: Record<string, string | number> = {}) =>
  request(app.getHttpServer())
    .get('/api/v1/admin/task/list')
    .query({ page: 1, ...query })
    .set(authHeaders(token));

export const getTask = (app: NestExpressApplication, token: string, taskId: number | string) =>
  request(app.getHttpServer()).get(`/api/v1/admin/task/${taskId}`).set(authHeaders(token));

export const getRun = (app: NestExpressApplication, token: string, runId: number | string) =>
  request(app.getHttpServer()).get(`/api/v1/admin/run/${runId}`).set(authHeaders(token));

export const getTranscript = (
  app: NestExpressApplication,
  token: string,
  runId: number,
  query: Record<string, string | number> = {}
) => request(app.getHttpServer()).get(`/api/v1/admin/run/${runId}/transcript`).query(query).set(authHeaders(token));
