import { z } from 'zod';

/** A plugin is enabled unless its value is `false`. */
export const agentSettingsSchema = z.looseObject({
  enabledPlugins: z.record(z.string(), z.unknown()).default({}),
});

/** The keys the runner adds its command limit to. Claude applies `env` to its own environment. */
export const managedSettingsSchema = z.looseObject({
  env: z.record(z.string(), z.unknown()).optional().catch(undefined),
  hooks: z
    .looseObject({ PreToolUse: z.array(z.unknown()).optional().catch(undefined) })
    .optional()
    .catch(undefined),
  sandbox: z.looseObject({}).optional().catch(undefined),
});
