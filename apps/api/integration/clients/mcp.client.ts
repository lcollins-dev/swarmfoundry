import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { authHeaders } from '../utils/auth';

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };

export const postMcp = (app: NestExpressApplication, token: string | null, body: Record<string, unknown>) =>
  request(app.getHttpServer())
    .post('/mcp')
    .set({ ...MCP_HEADERS, ...(token === null ? {} : authHeaders(token)) })
    .send({ jsonrpc: '2.0', id: 1, ...body });

/** The tool's JSON answer, or its refusal's text as `error`. */
export const callTool = async (
  app: NestExpressApplication,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
) => {
  const response = await postMcp(app, token, { method: 'tools/call', params: { name, arguments: args } }).expect(200);
  const { content, isError } = response.body.result;

  return isError
    ? { result: undefined, error: content[0].text }
    : { result: JSON.parse(content[0].text), error: undefined };
};
