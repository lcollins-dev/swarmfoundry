import { z } from 'zod';

import { flag, requestBody } from '../../../fields';

export const GetSysConfigResponseDto = z.object({
  registrationEnabled: z.boolean(),
});
export type GetSysConfigResponseDto = z.infer<typeof GetSysConfigResponseDto>;

export const UpdateSysConfigRequestDto = requestBody({
  registrationEnabled: flag().optional(),
});
export type UpdateSysConfigRequestDto = z.infer<typeof UpdateSysConfigRequestDto>;
