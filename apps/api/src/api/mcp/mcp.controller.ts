import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { All, Controller, MethodNotAllowedException, Post, Req, Res, SetMetadata } from '@nestjs/common';
import type { Request, Response } from 'express';

import { UserRoleId } from '@libs/dto';

import { AllowedRoles } from '../v1/user/decorators/allowed-roles.decorator';
import { ALLOW_API_KEY_METADATA_KEY } from '../v1/user/guards/auth.guard';

import { McpServerService } from './mcp-server.service';

export const MCP_METHOD_MESSAGE = 'This MCP server is stateless. Send each message as a POST.';

/** Streamable HTTP, stateless: each POST answers its own messages, and no stream outlives the request. */
@Controller('mcp')
@AllowedRoles(UserRoleId.SYSTEM_ADMIN)
export class McpController {
  constructor(private readonly mcpServerService: McpServerService) {}

  // The SDK validates each JSON-RPC message and each tool's arguments against its schema.
  @Post()
  @SetMetadata(ALLOW_API_KEY_METADATA_KEY, true)
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const server = this.mcpServerService.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** Refuses the standalone stream and session delete, which a stateless server has no use for. */
  @All()
  @SetMetadata(ALLOW_API_KEY_METADATA_KEY, true)
  refuse(): never {
    throw new MethodNotAllowedException(MCP_METHOD_MESSAGE);
  }
}
