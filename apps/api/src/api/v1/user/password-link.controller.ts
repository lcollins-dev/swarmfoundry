import { Body, Controller, HttpCode, Post } from '@nestjs/common';

import {
  CheckPasswordLinkRequestDto,
  CheckPasswordLinkResponseDto,
  SetPasswordRequestDto,
  TokenResponseDto,
} from '@libs/dto';

import { NoAuth } from './decorators/no-auth.decorator';
import { ZodPipe } from '@/common/pipes/zod.pipe';

import { PasswordLinkService } from '@/core/user/password-link.service';
import { UserService } from '@/core/user/user.service';

/** The set-password page's routes. The token travels in the body to keep it out of the request logs. */
@NoAuth()
@Controller('api/v1/password-link')
export class PasswordLinkController {
  constructor(
    private readonly passwordLinkService: PasswordLinkService,
    private readonly userService: UserService
  ) {}

  @Post('check')
  @HttpCode(200)
  async checkPasswordLink(
    @Body(new ZodPipe(CheckPasswordLinkRequestDto)) checkPasswordLinkRequest: CheckPasswordLinkRequestDto
  ): Promise<CheckPasswordLinkResponseDto> {
    const { state, passwordLink } = await this.passwordLinkService.check(checkPasswordLinkRequest.token);

    if (passwordLink?.user === undefined) {
      return { state, passwordLink: null };
    }

    return {
      state,
      passwordLink: {
        name: passwordLink.user.name,
        email: passwordLink.user.email,
        invite: passwordLink.user.passwordHash === null,
        expiresAt: passwordLink.expiresAt,
      },
    };
  }

  @Post()
  @HttpCode(200)
  async setPassword(
    @Body(new ZodPipe(SetPasswordRequestDto)) setPasswordRequest: SetPasswordRequestDto
  ): Promise<TokenResponseDto> {
    return {
      token: await this.userService.setPasswordWithLink(setPasswordRequest.token, setPasswordRequest.password),
    };
  }
}
