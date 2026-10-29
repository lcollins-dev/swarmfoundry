import { z } from 'zod';

import { name, text } from './common';

export const claudeAgentSchema = z.strictObject({
  type: z.literal('claude'),
  auth: z.enum(['oauth', 'apiKey']),
  token: text,
  model: text,
  settings: text.optional(),
  instructions: text.optional(),
  concurrency: z.int().min(1).optional(),
});

export const agentDefinitionSchema = z.discriminatedUnion('type', [claudeAgentSchema]);

const definitionOnly = z
  .never({ error: 'is set on the agent definition only, so every step of the agent shares one cap' })
  .optional();

// Its fields are checked once merged, against the type of the agent it resolves to.
export const agentBlockSchema = z.looseObject({ name: name.optional(), concurrency: definitionOnly });

export const environmentAgentBlockSchema = z.looseObject({ name, concurrency: definitionOnly });
