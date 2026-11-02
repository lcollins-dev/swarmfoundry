import { SetMetadata } from '@nestjs/common';

export const MCP_TOOLS_METADATA_KEY = 'mcp-tools';

/** Marks a provider whose tools every MCP server registers. Register it in its feature's module. */
// eslint-disable-next-line @typescript-eslint/naming-convention
export function McpTools(): ClassDecorator {
  return SetMetadata(MCP_TOOLS_METADATA_KEY, true);
}
