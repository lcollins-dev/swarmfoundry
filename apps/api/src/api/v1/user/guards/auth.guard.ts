import { CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { intersection } from 'lodash';

import { UserRoleId } from '@libs/dto';

import { ALLOWED_ROLES_METADATA_KEY } from '../decorators/allowed-roles.decorator';
import { NO_AUTH_METADATA_KEY } from '../decorators/no-auth.decorator';

import { User } from '@/core/user/entities/user.entity';

import { ApiKeyService } from '@/core/api-key/api-key.service';
import { NOT_ALLOWED_MESSAGE, SESSION_EXPIRED_MESSAGE, UserService } from '@/core/user/user.service';

export const SETUP_REQUIRED_MESSAGE = 'Finish setting up your account to continue.';
export const API_KEY_INVALID_MESSAGE = "This API key isn't valid. Create a new one on the API keys page.";
export const API_KEY_NOT_ALLOWED_MESSAGE = "An API key can't do that. Sign in to the console instead.";

/** Set on a handler, never a controller, to let an account held to first-time setup call it. */
export const ALLOWED_DURING_SETUP_METADATA_KEY = 'allowed-during-setup';

/** Set on a handler, never a controller, to let a personal API key call it. */
export const ALLOW_API_KEY_METADATA_KEY = 'allow-api-key';

export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(UserService) private readonly userService: UserService,
    @Inject(ApiKeyService) private readonly apiKeyService: ApiKeyService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const noAuthController = this.reflector.get<boolean | undefined>(NO_AUTH_METADATA_KEY, context.getClass());
    const noAuthRoute = this.reflector.get<boolean | undefined>(NO_AUTH_METADATA_KEY, context.getHandler());

    const requiresRoleController = this.reflector.get<UserRoleId[] | undefined>(
      ALLOWED_ROLES_METADATA_KEY,
      context.getClass()
    );
    const requiresRoleRoute = this.reflector.get<UserRoleId[] | undefined>(
      ALLOWED_ROLES_METADATA_KEY,
      context.getHandler()
    );

    if (noAuthController || noAuthRoute) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request & { user?: User }>();
    const authHeader =
      'authorization' in req.headers && typeof req.headers.authorization === 'string'
        ? req.headers.authorization
        : undefined;

    if (!authHeader) {
      throw new UnauthorizedException(SESSION_EXPIRED_MESSAGE);
    }

    const user = await this.authenticate(authHeader.replace('Bearer ', ''), context);
    req.user = user;

    if (user.mustChangePassword && !this.allowedDuringSetup(context)) {
      throw new ForbiddenException(SETUP_REQUIRED_MESSAGE);
    }

    // Check our controller roles - if set
    if (
      requiresRoleController &&
      intersection(
        requiresRoleController,
        (user.userUserRoles ?? []).map(userUserRole => userUserRole.userRoleId)
      ).length === 0
    ) {
      throw new ForbiddenException(NOT_ALLOWED_MESSAGE);
    }

    // Check our route roles - if set
    if (
      requiresRoleRoute &&
      intersection(
        requiresRoleRoute,
        (user.userUserRoles ?? []).map(userUserRole => userUserRole.userRoleId)
      ).length === 0
    ) {
      throw new ForbiddenException(NOT_ALLOWED_MESSAGE);
    }

    return true;
  }

  /** An API key skips the session and its idle timeout, so signing out of the console leaves it working. */
  private async authenticate(token: string, context: ExecutionContext): Promise<User> {
    if (!this.apiKeyService.isApiKey(token)) {
      return this.userService.checkToken(token);
    }

    const user = await this.apiKeyService.verify(token);

    if (!user) {
      throw new UnauthorizedException(API_KEY_INVALID_MESSAGE);
    }

    if (this.reflector.get<boolean | undefined>(ALLOW_API_KEY_METADATA_KEY, context.getHandler()) !== true) {
      throw new ForbiddenException(API_KEY_NOT_ALLOWED_MESSAGE);
    }

    return user;
  }

  private allowedDuringSetup(context: ExecutionContext): boolean {
    return this.reflector.get<boolean | undefined>(ALLOWED_DURING_SETUP_METADATA_KEY, context.getHandler()) === true;
  }
}
