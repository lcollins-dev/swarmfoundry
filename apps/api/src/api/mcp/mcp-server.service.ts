import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';

import { MCP_TOOLS_METADATA_KEY } from './decorators/mcp-tools.decorator';

import { ConfigService } from '@/config/config.service';

import type { IMcpToolProvider } from './types/mcp.types';

/** Builds a server per request, since the transport is stateless and a server holds one transport. */
@Injectable()
export class McpServerService implements OnApplicationBootstrap {
  private toolProviders: IMcpToolProvider[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly discoveryService: DiscoveryService,
    private readonly reflector: Reflector
  ) {}

  onApplicationBootstrap(): void {
    this.toolProviders = this.discoveryService
      .getProviders()
      .filter(wrapper => isMcpToolsClass(this.reflector, wrapper.metatype))
      .map((wrapper): unknown => wrapper.instance)
      .filter(isMcpToolProvider);
  }

  createServer(): McpServer {
    const server = new McpServer(
      { name: 'swarmfoundry', version: this.configService.version },
      {
        instructions:
          'Read-only access to Swarmfoundry: tasks queued by triggers, the runs of each task step, and each ' +
          "run's transcript of agent events. Start from list_tasks or search_transcripts, then read a run with " +
          'get_run and page through its transcript with get_transcript.',
      }
    );

    for (const provider of this.toolProviders) {
      provider.register(server);
    }

    return server;
  }
}

const isMcpToolsClass = (reflector: Reflector, metatype: unknown): boolean =>
  typeof metatype === 'function' && reflector.get<boolean | undefined>(MCP_TOOLS_METADATA_KEY, metatype) === true;

const isMcpToolProvider = (instance: unknown): instance is IMcpToolProvider =>
  typeof instance === 'object' &&
  instance !== null &&
  'register' in instance &&
  typeof instance.register === 'function';
