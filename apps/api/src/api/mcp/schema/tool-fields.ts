import { z } from 'zod';

export const MCP_ID_MAX = 2_147_483_647;
export const MCP_FILTER_MAX_LENGTH = 512;

export const mcpId = () => z.int().min(1).max(MCP_ID_MAX);

export const mcpDate = () => z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
