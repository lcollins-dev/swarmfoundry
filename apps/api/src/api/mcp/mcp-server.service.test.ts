import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { McpTools } from './decorators/mcp-tools.decorator';

import { McpServerService } from './mcp-server.service';
import { ConfigService } from '@/config/config.service';

import { mcpId } from './schema/tool-fields';
import type { IMcpToolProvider } from './types/mcp.types';
import { connectTestClient } from './utils/mcp-test-client.util';
import { registerReadTool } from './utils/read-tool.util';

const registerNamed = (server: McpServer, name: string) =>
  registerReadTool(server, name, { title: name, description: name, inputSchema: { id: mcpId() } }, () =>
    Promise.resolve(null)
  );

@Injectable()
@McpTools()
class FirstTools implements IMcpToolProvider {
  register(server: McpServer): void {
    registerNamed(server, 'first_tool');
  }
}

@Injectable()
@McpTools()
class SecondTools implements IMcpToolProvider {
  register(server: McpServer): void {
    registerNamed(server, 'second_tool');
  }
}

@Injectable()
class UnmarkedTools implements IMcpToolProvider {
  register(server: McpServer): void {
    registerNamed(server, 'unmarked_tool');
  }
}

describe('McpServerService', () => {
  it("registers the tools of every provider marked @McpTools, in any module, and the server's version", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        McpServerService,
        FirstTools,
        SecondTools,
        UnmarkedTools,
        { provide: ConfigService, useValue: { version: '1.2.3' } },
      ],
    }).compile();
    await moduleRef.init();

    const { client } = await connectTestClient(moduleRef.get(McpServerService).createServer());
    const { tools } = await client.listTools();

    expect(tools.map(tool => tool.name).sort()).toEqual(['first_tool', 'second_tool']);
    expect(client.getServerVersion()).toMatchObject({ name: 'swarmfoundry', version: '1.2.3' });
  });
});
