import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { mcpId } from '../schema/tool-fields';
import { connectTestClient } from './mcp-test-client.util';
import { registerReadTool, TOOL_FAILED_MESSAGE } from './read-tool.util';

const connect = async (read: () => Promise<unknown>) => {
  const server = new McpServer({ name: 'test', version: '1' });

  registerReadTool(
    server,
    'read_thing',
    { title: 'Read a thing', description: 'Reads it.', inputSchema: { id: mcpId() } },
    read
  );

  return connectTestClient(server);
};

describe('registerReadTool', () => {
  it('marks the tool read-only and idempotent', async () => {
    const { client } = await connect(() => Promise.resolve(null));
    const { tools } = await client.listTools();

    expect(tools[0].annotations).toEqual({
      title: 'Read a thing',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('answers the result as JSON', async () => {
    const { call } = await connect(() => Promise.resolve({ id: 4 }));

    expect(await call('read_thing', { id: 4 })).toEqual({ result: { id: 4 } });
  });

  it('refuses arguments its schema refuses, before reading', async () => {
    let read = false;
    const { call } = await connect(() => {
      read = true;

      return Promise.resolve(null);
    });

    expect((await call('read_thing', { id: 0 })).error).toBeDefined();
    expect(read).toBe(false);
  });

  it('answers a refusal with its message', async () => {
    const { call } = await connect(() => Promise.reject(new BadRequestException("This thing doesn't exist.")));

    expect(await call('read_thing', { id: 4 })).toEqual({ error: "This thing doesn't exist." });
  });

  it.each([
    ['a server error', new InternalServerErrorException('pool exhausted')],
    ['any other failure', new Error('connection to 192.0.2.1 refused')],
  ])('answers %s with a generic message', async (_name, error) => {
    const { call } = await connect(() => Promise.reject(error));

    expect(await call('read_thing', { id: 4 })).toEqual({ error: TOOL_FAILED_MESSAGE });
  });
});
