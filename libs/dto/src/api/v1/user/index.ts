import { z } from 'zod';

import { emailAddress, password, PASSWORD_MAX_LENGTH, requestBody, text } from '../../../fields';
import { UserRoleId } from './role';

export const CanRegisterResponseDto = z.object({
  canRegister: z.boolean(),
});
export type CanRegisterResponseDto = z.infer<typeof CanRegisterResponseDto>;

export const RegisterRequestDto = requestBody({
  name: text(2, 256),
  email: emailAddress(),
  password: password(),
});
export type RegisterRequestDto = z.infer<typeof RegisterRequestDto>;

export const LoginRequestDto = requestBody({
  email: emailAddress(),
  password: text(0, PASSWORD_MAX_LENGTH),
});
export type LoginRequestDto = z.infer<typeof LoginRequestDto>;

export const TokenResponseDto = z.object({
  token: z.string(),
});
export type TokenResponseDto = z.infer<typeof TokenResponseDto>;

export const ProfileResponseDto = z.object({
  name: z.string(),
  email: z.string(),
  userRoleIds: z.array(z.enum(UserRoleId)),
  /** While true, `/api/v1` refuses everything the first-time setup screen does not need. */
  mustChangePassword: z.boolean(),
});
export type ProfileResponseDto = z.infer<typeof ProfileResponseDto>;

export const UpdateProfileRequestDto = requestBody({
  name: text(2, 256),
  email: emailAddress(),
  password: password().optional(),
});
export type UpdateProfileRequestDto = z.infer<typeof UpdateProfileRequestDto>;

export const UpdateProfileResponseDto = z.object({
  /** Set when the update replaced the session, and the caller must swap to this token */
  token: z.string().optional(),
});
export type UpdateProfileResponseDto = z.infer<typeof UpdateProfileResponseDto>;

export * from './role';

export * from './admin';
