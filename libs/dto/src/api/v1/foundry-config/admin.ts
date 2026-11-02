import { z } from 'zod';

import { timestamp } from '../../../fields';

export const ConfigQueryDto = z.object({
  /** A config repo revision the config is running or a task ran on. The running config when absent. */
  sha: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, { error: 'Enter a full commit sha.' })
    .optional(),
});
export type ConfigQueryDto = z.infer<typeof ConfigQueryDto>;

export const ConfigResponseDto = z.object({
  /** Null when the config loads from a local file. */
  sha: z.string().nullable(),
  /** When the revision first became the running config. Null for a local file. */
  currentDate: timestamp().nullable(),
  /** The config file first, then each prompt, settings and instructions file it references, as written. */
  files: z.array(
    z.object({
      /** From the config folder. */
      path: z.string(),
      /** `${VAR}` stays unresolved, and any secret written in is masked. */
      content: z.string(),
    })
  ),
});
export type ConfigResponseDto = z.infer<typeof ConfigResponseDto>;
