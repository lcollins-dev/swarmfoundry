import { z } from 'zod';

// An optional field that is malformed reads as undefined, so it never turns the event unknown.
const optionalText = z.string().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

const parentToolUseId = z.string().nullable().optional().catch(undefined);

export const systemInitLineSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: optionalText,
  model: optionalText,
  cwd: optionalText,
  tools: z.array(z.string()).optional().catch(undefined),
  permissionMode: optionalText,
});

/** Claude's retry after an API error. Only a 429 is a rate limit. */
export const apiRetryLineSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('api_retry'),
  error_status: z.number().nullable().optional().catch(undefined),
  retry_delay_ms: optionalNumber,
});

export const rateLimitLineSchema = z.looseObject({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.looseObject({ status: optionalText, resetsAt: optionalNumber }).optional().catch(undefined),
});

export const resultLineSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().optional().catch(undefined),
  result: optionalText,
  num_turns: optionalNumber,
  duration_ms: optionalNumber,
  total_cost_usd: optionalNumber,
});

/** An `assistant` or `user` line. A subagent's carries the tool call that started it as `parent_tool_use_id`. */
export const messageLineSchema = z.looseObject({
  type: z.enum(['assistant', 'user']),
  parent_tool_use_id: parentToolUseId,
  message: z.looseObject({ content: z.array(z.unknown()) }),
});

export const textBlockSchema = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
});

export const toolUseBlockSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export const toolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional().catch(undefined),
});
