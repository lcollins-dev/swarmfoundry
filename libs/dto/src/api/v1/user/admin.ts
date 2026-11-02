import { z } from 'zod';

import { emailAddress, enumList, enumValue, flag, requestBody, text, timestamp } from '../../../fields';
import { UserRoleId } from './role';

export enum UserListStatus {
  ALL = 'all',
  ENABLED = 'enabled',
  DISABLED = 'disabled',
}

export const UserRoleDto = z.object({
  id: z.enum(UserRoleId),
  name: z.string(),
});
export type UserRoleDto = z.infer<typeof UserRoleDto>;

export const UserRoleListResponseDto = z.array(UserRoleDto);
export type UserRoleListResponseDto = z.infer<typeof UserRoleListResponseDto>;

export const ListUserDto = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  enabled: z.boolean(),
  userRoleIds: z.array(z.number()),
  /** Invited and yet to choose a password, so unable to sign in. */
  invited: z.boolean(),
  lastAccess: timestamp(),
  createdDate: timestamp(),
});
export type ListUserDto = z.infer<typeof ListUserDto>;

export const UserDto = ListUserDto.extend({
  lastLoginSuccess: timestamp().nullable(),
  lastLoginFail: timestamp().nullable(),
});
export type UserDto = z.infer<typeof UserDto>;

export const UserListRequestDto = requestBody({
  /** An empty search matches everyone, as no search does. */
  search: text(0, 512)
    .transform(search => (search === '' ? undefined : search))
    .optional(),
  status: enumValue(UserListStatus),
});
export type UserListRequestDto = z.infer<typeof UserListRequestDto>;

export const UserListResponseDto = z.object({
  userList: z.array(ListUserDto),
  pages: z.number(),
  /** How many users match the request, across every page. */
  total: z.number(),
});
export type UserListResponseDto = z.infer<typeof UserListResponseDto>;

export const UserStatsResponseDto = z.object({
  total: z.number(),
  enabled: z.number(),
  disabled: z.number(),
});
export type UserStatsResponseDto = z.infer<typeof UserStatsResponseDto>;

export const UpdateUserRequestDto = requestBody({
  name: text(2, 256),
  email: emailAddress(),
  userRoleIds: enumList(UserRoleId),
});
export type UpdateUserRequestDto = z.infer<typeof UpdateUserRequestDto>;

export const InviteUserRequestDto = requestBody({
  name: text(2, 256),
  email: emailAddress(),
  userRoleIds: enumList(UserRoleId),
});
export type InviteUserRequestDto = z.infer<typeof InviteUserRequestDto>;

export const PasswordLinkDto = z.object({
  link: z.string(),
  expiresAt: timestamp(),
  /** False when the email failed or no email transport is set up, so the admin hands the link over. */
  emailed: z.boolean(),
});
export type PasswordLinkDto = z.infer<typeof PasswordLinkDto>;

export const InviteUserResponseDto = z.object({
  userId: z.number(),
  passwordLink: PasswordLinkDto,
});
export type InviteUserResponseDto = z.infer<typeof InviteUserResponseDto>;

export const UpdateStateRequestDto = requestBody({
  enabled: flag(),
});
export type UpdateStateRequestDto = z.infer<typeof UpdateStateRequestDto>;
