import { posix } from 'node:path';
import { z } from 'zod';

import { environmentAgentBlockSchema } from './agents';
import { absolutePath, memoryBytes, name, text, variables } from './common';

/** Each one picks or outranks Claude's credentials. The runner sets exactly one auth variable from the agent's token. */
export const AGENT_AUTH_VARIABLES = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];

const sandboxVariables = variables.superRefine((env, context) => {
  for (const key of AGENT_AUTH_VARIABLES) {
    if (Object.hasOwn(env, key)) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: "would override the agent's auth, which the runner sets from its token",
      });
    }
  }
});

/**
 * A best-effort guard against handing the agent a container runtime's socket or the host's state. It reads
 * the path as written, so a symlink to a refused path gets through.
 */
const REFUSED_MOUNTS = new Set(['/', '/var']);
const REFUSED_MOUNT_TREES = ['/run', '/var/run', '/proc', '/sys', '/dev', '/var/lib/docker', '/var/lib/containerd'];

const mountSource = absolutePath.refine(source => {
  const normalised = posix.normalize(source).replace(/(.)\/+$/, '$1');
  const inRefusedTree = REFUSED_MOUNT_TREES.some(tree => normalised === tree || normalised.startsWith(`${tree}/`));

  return !REFUSED_MOUNTS.has(normalised) && !inRefusedTree && !normalised.endsWith('.sock');
}, 'must not expose a container runtime socket or host system directory');

const serviceSchema = z.strictObject({
  image: text,
  env: variables.default({}),
});

export const environmentSchema = z.strictObject({
  image: text,
  agent: environmentAgentBlockSchema.optional(),
  env: sandboxVariables.default({}),
  mounts: z
    .array(z.strictObject({ source: mountSource, target: absolutePath, readOnly: z.boolean().default(true) }))
    .default([]),
  services: z.record(name, serviceSchema).default({}),
  resources: z
    .strictObject({
      cpus: z.number().positive().optional(),
      memory: memoryBytes.optional(),
      pids: z.int().positive().optional(),
    })
    .default({}),
});
