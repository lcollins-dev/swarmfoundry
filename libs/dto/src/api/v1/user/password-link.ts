import { z } from 'zod';

import { password, requestBody, timestamp } from '../../../fields';

export const PASSWORD_LINK_INVALID_MESSAGE = "This link doesn't work any more. Ask your admin for a new one.";

const PASSWORD_LINK_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const passwordLinkToken = () =>
  z
    .string({ error: PASSWORD_LINK_INVALID_MESSAGE })
    .regex(PASSWORD_LINK_TOKEN_PATTERN, { error: PASSWORD_LINK_INVALID_MESSAGE });

export enum PasswordLinkState {
  VALID = 'valid',
  /** No link has this token, or a newer link for the same user replaced it. */
  INVALID = 'invalid',
  EXPIRED = 'expired',
  USED = 'used',
}

export const CheckPasswordLinkRequestDto = requestBody({
  token: passwordLinkToken(),
});
export type CheckPasswordLinkRequestDto = z.infer<typeof CheckPasswordLinkRequestDto>;

export const CheckedPasswordLinkDto = z.object({
  name: z.string(),
  email: z.string(),
  /** The user has never had a password. */
  invite: z.boolean(),
  expiresAt: timestamp(),
});
export type CheckedPasswordLinkDto = z.infer<typeof CheckedPasswordLinkDto>;

export const CheckPasswordLinkResponseDto = z.object({
  state: z.enum(PasswordLinkState),
  /** Set only while the link is valid. */
  passwordLink: CheckedPasswordLinkDto.nullable(),
});
export type CheckPasswordLinkResponseDto = z.infer<typeof CheckPasswordLinkResponseDto>;

export const SetPasswordRequestDto = requestBody({
  token: passwordLinkToken(),
  password: password(),
});
export type SetPasswordRequestDto = z.infer<typeof SetPasswordRequestDto>;
