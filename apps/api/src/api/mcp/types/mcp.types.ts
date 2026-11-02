import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';

export interface IMcpToolProvider {
  register(server: McpServer): void;
}

export interface IReadTool<Shape extends ZodRawShapeCompat> {
  title: string;
  description: string;
  inputSchema: Shape;
}
