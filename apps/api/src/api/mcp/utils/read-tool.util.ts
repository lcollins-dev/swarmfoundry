import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { HttpException, HttpStatus, Logger } from '@nestjs/common';

import type { IReadTool } from '../types/mcp.types';

export const TOOL_FAILED_MESSAGE =
  "Something went wrong reading that. Try again, and check the server's logs if it persists.";

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const logger = new Logger('McpTools');

/** Answers `read`'s result as JSON, a 4xx as its message, and any other failure as a generic message after logging it. */
export function registerReadTool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  tool: IReadTool<Shape>,
  read: (args: ShapeOutput<Shape>) => Promise<unknown>
): void;

// The SDK's callback type is conditional on the shape, which resolves only for a concrete one.
export function registerReadTool(
  server: McpServer,
  name: string,
  tool: IReadTool<ZodRawShapeCompat>,
  read: (args: ShapeOutput<ZodRawShapeCompat>) => Promise<unknown>
): void {
  server.registerTool(name, { ...tool, annotations: { title: tool.title, ...READ_ONLY } }, args =>
    answer(name, () => read(args))
  );
}

async function answer(name: string, read: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await read()) }] };
  } catch (error) {
    if (error instanceof HttpException && error.getStatus() < HttpStatus.INTERNAL_SERVER_ERROR) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }

    logger.error({ error, tool: name }, 'answer(): A tool failed');

    return { content: [{ type: 'text', text: TOOL_FAILED_MESSAGE }], isError: true };
  }
}
