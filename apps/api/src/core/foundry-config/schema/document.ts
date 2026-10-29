import { z } from 'zod';

import { agentDefinitionSchema } from './agents';
import { name } from './common';
import { environmentSchema } from './environments';
import { sourceSchema } from './sources';
import { triggerSchema } from './triggers';

export const foundryConfigDocumentSchema = z.strictObject({
  sources: z.record(name, sourceSchema).default({}),
  agents: z.record(name, agentDefinitionSchema).default({}),
  environments: z.record(name, environmentSchema).default({}),
  triggers: z.record(name, triggerSchema).default({}),
});
