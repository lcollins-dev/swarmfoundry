import { z } from 'zod';

/** A subagent's event carries the tool call that started it as `parent_tool_use_id`. */
export const assistantMessageSchema = z.looseObject({
  type: z.literal('assistant'),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.looseObject({
    content: z.array(z.looseObject({ type: z.string(), text: z.unknown().optional() })),
  }),
});
