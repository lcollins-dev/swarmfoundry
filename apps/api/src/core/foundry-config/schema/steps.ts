import { z } from 'zod';

import { agentBlockSchema } from './agents';
import { duration, label, name, text, username } from './common';

export const agentStepSchema = z.strictObject({
  environment: name,
  agent: agentBlockSchema.optional(),
  systemPrompt: text.optional(),
  prompt: text,
  timeout: duration,
});

// GitLab takes each list as one comma-separated string.
const relabelLabel = label.refine(value => !value.includes(','), 'must not hold a comma');

export const relabelStepSchema = z
  .strictObject({ add: z.array(relabelLabel).default([]), remove: z.array(relabelLabel).default([]) })
  .refine(relabel => relabel.add.length + relabel.remove.length > 0, 'must add or remove at least one label');

export const commentStepSchema = z.string().refine(body => body.trim() !== '', 'must not be blank');

export const assignStepSchema = z.array(username).min(1, 'must list at least one username');

/** Every key of `stepSchema`. */
export const STEP_KINDS = ['agent', 'relabel', 'comment', 'assign'] as const;

export const stepSchema = z
  .strictObject({
    agent: agentStepSchema.optional(),
    relabel: relabelStepSchema.optional(),
    comment: commentStepSchema.optional(),
    assign: assignStepSchema.optional(),
  })
  .refine(step => STEP_KINDS.filter(kind => step[kind] !== undefined).length === 1, {
    message: `must set exactly one action: ${STEP_KINDS.join(', ')}`,
    // Zod skips a refine after an unknown key, so a misspelt action would hide the missing one until the next load.
    when: ({ value }) => typeof value === 'object' && value !== null,
  });
