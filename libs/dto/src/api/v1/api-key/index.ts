import { z } from 'zod';

import { requestBody, text, timestamp } from '../../../fields';

export const ApiKeyDto = z.object({
  id: z.number(),
  name: z.string(),
  /** Stamped at most once a minute, so a busy key reads as recently used rather than exactly. */
  lastUsedDate: timestamp().nullable(),
  createdDate: timestamp(),
});
export type ApiKeyDto = z.infer<typeof ApiKeyDto>;

export const ApiKeyListResponseDto = z.object({
  apiKeyList: z.array(ApiKeyDto),
});
export type ApiKeyListResponseDto = z.infer<typeof ApiKeyListResponseDto>;

export const CreateApiKeyRequestDto = requestBody({
  name: text(1, 128),
});
export type CreateApiKeyRequestDto = z.infer<typeof CreateApiKeyRequestDto>;

export const CreateApiKeyResponseDto = z.object({
  apiKey: ApiKeyDto,
  /** The full key, shown this once. Only a hash of it is stored. */
  token: z.string(),
});
export type CreateApiKeyResponseDto = z.infer<typeof CreateApiKeyResponseDto>;
