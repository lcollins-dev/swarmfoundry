import { Body, Controller, Get, Patch, Post, SetMetadata } from '@nestjs/common';

import {
  LoginRequestDto,
  ProfileResponseDto,
  TokenResponseDto,
  UpdateProfileRequestDto,
  UpdateProfileResponseDto,
} from '@libs/dto';

import { NoAuth } from './decorators/no-auth.decorator';
import { GetUser } from './decorators/user.decorator';
import { ALLOWED_DURING_SETUP_METADATA_KEY } from './guards/auth.guard';
import { ZodPipe } from '@/common/pipes/zod.pipe';

import { User } from '@/core/user/entities/user.entity';

import { UserService } from '@/core/user/user.service';

@Controller('api/v1/user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @NoAuth()
  @Post('login')
  async login(@Body(new ZodPipe(LoginRequestDto)) loginRequest: LoginRequestDto): Promise<TokenResponseDto> {
    const user = await this.userService.checkLoginWithThrow(loginRequest.email, loginRequest.password);

    return {
      token: await this.userService.createLoginToken(user),
    };
  }

  @Get('profile')
  @SetMetadata(ALLOWED_DURING_SETUP_METADATA_KEY, true)
  getProfile(@GetUser() user: User): ProfileResponseDto {
    return {
      name: user.name,
      email: user.email,
      userRoleIds: (user.userUserRoles ?? []).map(userUserRole => userUserRole.userRoleId),
      mustChangePassword: user.mustChangePassword,
    };
  }

  @Patch('profile')
  @SetMetadata(ALLOWED_DURING_SETUP_METADATA_KEY, true)
  async updateProfile(
    @GetUser() user: User,
    @Body(new ZodPipe(UpdateProfileRequestDto)) updateProfileRequest: UpdateProfileRequestDto
  ): Promise<UpdateProfileResponseDto> {
    await this.userService.updateProfile(
      updateProfileRequest.name,
      updateProfileRequest.email,
      updateProfileRequest.password,
      user.id
    );

    // Changing the password drops the session it was made from, so the caller is given the
    // replacement rather than being signed out mid-edit.
    if (updateProfileRequest.password !== undefined) {
      return { token: await this.userService.startSession(user) };
    }

    return {};
  }

  @Post('logout')
  @SetMetadata(ALLOWED_DURING_SETUP_METADATA_KEY, true)
  async doLogout(@GetUser() user: User): Promise<void> {
    await this.userService.invalidateSessions(user.id);
  }
}
