import { z } from 'zod';

export const systemInitSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  plugins: z.array(z.looseObject({ name: z.string(), source: z.string().optional() })).default([]),
});

export const pluginInstallSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('plugin_install'),
  status: z.string(),
  name: z.string().optional(),
  error: z.string().optional(),
});

// A usage field that is missing or malformed reads as undefined, so it never fails the line.
const count = z.int().nonnegative().optional().catch(undefined);

export const resultSchema = z.looseObject({
  type: z.literal('result'),
  num_turns: count,
  total_cost_usd: z.number().nonnegative().optional().catch(undefined),
  usage: z
    .looseObject({
      input_tokens: count,
      output_tokens: count,
      cache_read_input_tokens: count,
      cache_creation_input_tokens: count,
    })
    .optional()
    .catch(undefined),
});

export const assistantSchema = z.looseObject({
  type: z.literal('assistant'),
  message: z.looseObject({ content: z.array(z.unknown()).catch([]) }),
});

export const bashToolUseSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.literal('Bash'),
  input: z.looseObject({ command: z.string() }),
});

/** A prompt's content is a string, which reads as no blocks. */
export const userSchema = z.looseObject({
  type: z.literal('user'),
  message: z.looseObject({ content: z.array(z.unknown()).catch([]) }),
});

export const toolResultSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z
    .union([z.string(), z.array(z.looseObject({ text: z.string().optional() }))])
    .transform(content => (typeof content === 'string' ? content : content.map(part => part.text ?? '').join('\n')))
    .catch(''),
});
