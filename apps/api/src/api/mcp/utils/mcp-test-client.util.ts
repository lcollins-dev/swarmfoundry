import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import type { IMcpToolProvider } from '../types/mcp.types';

/** A tool's JSON answer as `result`, or its refusal's text as `error`. */
export interface IToolAnswer {
  result?: unknown;
  error?: string;
}

export interface IMcpTestClient {
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<IToolAnswer>;
}

/** Connects a client in memory to a server holding the providers' tools, for unit tests. */
export async function connectTestClient(server: McpServer | IMcpToolProvider[]): Promise<IMcpTestClient> {
  const mcpServer = Array.isArray(server) ? new McpServer({ name: 'test', version: '1' }) : server;

  if (Array.isArray(server)) {
    for (const provider of server) {
      provider.register(mcpServer);
    }
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    call: async (name, args = {}) => {
      const answer = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      const [content] = answer.content;
      const text = content.type === 'text' ? content.text : '';

      return answer.isError === true ? { error: text } : { result: parseJson(text) };
    },
  };
}

const parseJson = (text: string): unknown => JSON.parse(text);
