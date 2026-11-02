import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import {
  InviteUserRequestDto,
  InviteUserResponseDto,
  PasswordLinkDto,
  UpdateStateRequestDto,
  UpdateUserRequestDto,
  UserDto,
  UserListRequestDto,
  UserListResponseDto,
  UserRoleDto,
  UserStatsResponseDto,
  UserRoleId,
  IdParamDto,
  PageParamDto,
} from '@libs/dto';

import { AllowedRoles } from './decorators/allowed-roles.decorator';
import { GetUser } from './decorators/user.decorator';
import { ZodPipe } from '@/common/pipes/zod.pipe';

import { User } from '@/core/user/entities/user.entity';

import { UserAdminService } from './user-admin.service';
import { UserService } from '@/core/user/user.service';

@Controller('api/v1/admin/user')
@AllowedRoles(UserRoleId.USER_ADMIN)
export class UserAdminController {
  constructor(
    private readonly userService: UserService,
    private readonly userAdminService: UserAdminService
  ) {}

  @Get('role/list')
  getRoleList(): Promise<UserRoleDto[]> {
    return this.userAdminService.getRoleList();
  }

  @Get('stats')
  getUserStats(): Promise<UserStatsResponseDto> {
    return this.userAdminService.getUserStats();
  }

  @Patch('list')
  getUserList(
    @Body(new ZodPipe(UserListRequestDto)) userListRequest: UserListRequestDto,
    @Query('page', new ZodPipe(PageParamDto)) page: number
  ): Promise<UserListResponseDto> {
    return this.userAdminService.getUserList(userListRequest, page);
  }

  @Post('invite')
  inviteUser(
    @Body(new ZodPipe(InviteUserRequestDto)) inviteUserRequest: InviteUserRequestDto
  ): Promise<InviteUserResponseDto> {
    return this.userAdminService.inviteUser(inviteUserRequest);
  }

  @Get(':userId')
  getUser(@Param('userId', new ZodPipe(IdParamDto)) userId: number): Promise<UserDto> {
    return this.userAdminService.getUser(userId);
  }

  @Patch(':userId')
  updateUser(
    @GetUser() caller: User,
    @Param('userId', new ZodPipe(IdParamDto)) userId: number,
    @Body(new ZodPipe(UpdateUserRequestDto)) updateUserRequest: UpdateUserRequestDto
  ): Promise<void> {
    return this.userAdminService.updateUser(caller, updateUserRequest, userId);
  }

  @Patch(':userId/state')
  updateState(
    @GetUser() caller: User,
    @Param('userId', new ZodPipe(IdParamDto)) userId: number,
    @Body(new ZodPipe(UpdateStateRequestDto)) updateStateRequest: UpdateStateRequestDto
  ): Promise<void> {
    return this.userAdminService.updateState(caller, updateStateRequest.enabled, userId);
  }

  @Post(':userId/password-link')
  createPasswordLink(
    @GetUser() caller: User,
    @Param('userId', new ZodPipe(IdParamDto)) userId: number
  ): Promise<PasswordLinkDto> {
    return this.userAdminService.createPasswordLink(caller, userId);
  }

  @Patch(':userId/logout-all-sessions')
  async logoutAllSessions(@Param('userId', new ZodPipe(IdParamDto)) userId: number): Promise<void> {
    await this.userService.invalidateSessions(userId);
  }
}
