import { BadRequestException, Injectable } from '@nestjs/common';

import {
  InviteUserRequestDto,
  InviteUserResponseDto,
  ListUserDto,
  PasswordLinkDto,
  UpdateUserRequestDto,
  UserDto,
  UserListRequestDto,
  UserListResponseDto,
  UserRoleDto,
  UserStatsResponseDto,
  UserListStatus,
} from '@libs/dto';

import { User } from '@/core/user/entities/user.entity';

import { ConfigService } from '@/config/config.service';
import { PasswordLinkService } from '@/core/user/password-link.service';
import { UserService } from '@/core/user/user.service';

export const OWN_ROLES_MESSAGE = 'Another admin has to change your roles.';
export const OWN_STATE_MESSAGE = 'Another admin has to disable your account.';
export const OWN_PASSWORD_LINK_MESSAGE = 'Change your own password in Profile & security.';
export const DISABLED_PASSWORD_LINK_MESSAGE = 'Enable this account before creating a password link.';

const sameRoles = (left: number[], right: number[]): boolean => {
  const rightSet = new Set(right);

  return new Set(left).size === rightSet.size && left.every(roleId => rightSet.has(roleId));
};

@Injectable()
export class UserAdminService {
  constructor(
    private readonly configService: ConfigService,
    private readonly passwordLinkService: PasswordLinkService,
    private readonly userService: UserService
  ) {}

  async getRoleList(): Promise<UserRoleDto[]> {
    const userRoles = await this.userService.findRoles();

    return userRoles.map(userRole => ({ id: userRole.id, name: userRole.name }));
  }

  async getUserList(userListRequest: UserListRequestDto, page: number): Promise<UserListResponseDto> {
    const pageSize = this.configService.pageSize;

    const [users, total] = await this.userService.findAndCount(
      {
        search: userListRequest.search,
        enabled:
          userListRequest.status === UserListStatus.ALL ? undefined : userListRequest.status === UserListStatus.ENABLED,
      },
      pageSize * (page - 1),
      pageSize
    );

    return {
      userList: users.map(user => this.toListUser(user)),
      pages: Math.ceil(total / pageSize),
      total,
    };
  }

  async getUserStats(): Promise<UserStatsResponseDto> {
    const { total, enabled } = await this.userService.countByState();

    return {
      total,
      enabled,
      disabled: total - enabled,
    };
  }

  async getUser(userId: number): Promise<UserDto> {
    const user = await this.userService.findWithThrow(userId, true);

    return {
      ...this.toListUser(user),
      lastLoginSuccess: user.lastLoginSuccess,
      lastLoginFail: user.lastLoginFail,
    };
  }

  async inviteUser(inviteUserRequest: InviteUserRequestDto): Promise<InviteUserResponseDto> {
    const user = await this.userService.invite(
      inviteUserRequest.name,
      inviteUserRequest.email,
      inviteUserRequest.userRoleIds
    );

    return { userId: user.id, passwordLink: await this.passwordLinkService.issue(user) };
  }

  async updateUser(caller: User, updateUserRequest: UpdateUserRequestDto, userId: number): Promise<void> {
    const callerRoleIds = (caller.userUserRoles ?? []).map(userUserRole => userUserRole.userRoleId);

    if (userId === caller.id && !sameRoles(updateUserRequest.userRoleIds, callerRoleIds)) {
      throw new BadRequestException(OWN_ROLES_MESSAGE);
    }

    await this.userService.updateProfile(updateUserRequest.name, updateUserRequest.email, undefined, userId);
    await this.userService.updateRoles(updateUserRequest.userRoleIds, userId);
  }

  async updateState(caller: User, enabled: boolean, userId: number): Promise<void> {
    if (userId === caller.id && !enabled) {
      throw new BadRequestException(OWN_STATE_MESSAGE);
    }

    await this.userService.setEnabled(userId, enabled);
  }

  /** Issues a fresh invite instead for a user who has no password yet. */
  async createPasswordLink(caller: User, userId: number): Promise<PasswordLinkDto> {
    if (userId === caller.id) {
      throw new BadRequestException(OWN_PASSWORD_LINK_MESSAGE);
    }

    const user = await this.userService.findWithThrow(userId);

    if (!user.enabled) {
      throw new BadRequestException(DISABLED_PASSWORD_LINK_MESSAGE);
    }

    return this.passwordLinkService.issue(user);
  }

  private toListUser(user: User): ListUserDto {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      enabled: user.enabled,
      invited: user.passwordHash === null,
      userRoleIds: (user.userUserRoles ?? []).map(userUserRole => userUserRole.userRoleId),
      lastAccess: user.lastAccess,
      createdDate: user.createdDate,
    };
  }
}
