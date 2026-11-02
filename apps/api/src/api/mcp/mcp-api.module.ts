import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { McpServerService } from './mcp-server.service';

import { McpController } from './mcp.controller';

@Module({
  imports: [DiscoveryModule],
  providers: [McpServerService],
  controllers: [McpController],
})
export class McpApiModule {}
