import { z } from 'zod';

export const runResultSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  api_error_status: z.number().nullable().optional(),
  result: z.string().optional(),
});
