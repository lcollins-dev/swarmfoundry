import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserRoleId } from '@libs/dto';

import { ALLOWED_ROLES_METADATA_KEY } from '@/api/v1/user/decorators/allowed-roles.decorator';
import { NO_AUTH_METADATA_KEY } from '@/api/v1/user/decorators/no-auth.decorator';
import {
  ALLOW_API_KEY_METADATA_KEY,
  ALLOWED_DURING_SETUP_METADATA_KEY,
  API_KEY_INVALID_MESSAGE,
  API_KEY_NOT_ALLOWED_MESSAGE,
  AuthGuard,
  SETUP_REQUIRED_MESSAGE,
} from '@/api/v1/user/guards/auth.guard';

import { UserUserRole } from '@/core/user/entities/user-user-role.entity';
import { User } from '@/core/user/entities/user.entity';

import { ApiKeyService } from '@/core/api-key/api-key.service';
import { NOT_ALLOWED_MESSAGE, SESSION_EXPIRED_MESSAGE, UserService } from '@/core/user/user.service';

interface IMockRequest {
  headers: Record<string, string | undefined>;
  user?: User;
}

const buildUserWithRoles = (roleIds: UserRoleId[]): User => {
  const user = new User({ name: 'Tester', email: 'tester@example.com', passwordHash: 'hash' });

  user.userUserRoles = roleIds.map((roleId, index) => {
    const userUserRole = new UserUserRole(1, roleId);
    userUserRole.id = index + 1;
    return userUserRole;
  });

  return user;
};

const buildContext = (request: IMockRequest): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: vi.fn(),
      getNext: vi.fn(),
    }),
    getClass: () => class TestController {},
    getHandler: () => () => undefined,
    getArgs: vi.fn(),
    getArgByIndex: vi.fn(),
    switchToRpc: vi.fn(),
    switchToWs: vi.fn(),
    getType: vi.fn(),
  }) as unknown as ExecutionContext;

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let reflectorGet: ReturnType<typeof vi.fn>;
  let checkTokenMock: ReturnType<typeof vi.fn>;
  let verifyApiKeyMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    reflectorGet = vi.fn();
    checkTokenMock = vi.fn();
    verifyApiKeyMock = vi.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthGuard,
        {
          provide: Reflector,
          useValue: { get: reflectorGet },
        },
        {
          provide: UserService,
          useValue: { checkToken: checkTokenMock },
        },
        {
          provide: ApiKeyService,
          useValue: {
            isApiKey: (token: string) => token.startsWith('sfk_'),
            verify: verifyApiKeyMock,
          },
        },
      ],
    }).compile();

    guard = moduleRef.get(AuthGuard);
  });

  describe('no-auth bypass', () => {
    it('returns true when no-auth is set on the controller', async () => {
      reflectorGet.mockImplementation((key: string, target: unknown) => {
        if (key === NO_AUTH_METADATA_KEY && typeof target === 'function' && target.prototype) {
          return true;
        }

        return undefined;
      });

      const context = buildContext({ headers: {} });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(checkTokenMock).not.toHaveBeenCalled();
    });

    it('returns true when no-auth is set on the route handler', async () => {
      reflectorGet.mockImplementation((key: string, target: unknown) => {
        if (key === NO_AUTH_METADATA_KEY && typeof target === 'function' && !('prototype' in target)) {
          return true;
        }

        return undefined;
      });

      const context = buildContext({ headers: {} });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(checkTokenMock).not.toHaveBeenCalled();
    });
  });

  describe('missing auth header', () => {
    it('throws when no authorization header is present', async () => {
      reflectorGet.mockReturnValue(undefined);

      const context = buildContext({ headers: {} });

      await expect(guard.canActivate(context)).rejects.toThrow(new UnauthorizedException(SESSION_EXPIRED_MESSAGE));
    });
  });

  describe('role checking', () => {
    it('returns true when the user holds a controller-required role', async () => {
      reflectorGet.mockImplementation((key: string, target: unknown) => {
        if (key === ALLOWED_ROLES_METADATA_KEY && typeof target === 'function' && target.prototype) {
          return [UserRoleId.USER_ADMIN];
        }

        return undefined;
      });
      checkTokenMock.mockResolvedValue(buildUserWithRoles([UserRoleId.USER_ADMIN]));

      const context = buildContext({ headers: { authorization: 'Bearer abc' } });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(checkTokenMock).toHaveBeenCalledWith('abc');
    });

    it('throws when the user does not hold any controller-required role', async () => {
      reflectorGet.mockImplementation((key: string, target: unknown) => {
        if (key === ALLOWED_ROLES_METADATA_KEY && typeof target === 'function' && target.prototype) {
          return [UserRoleId.SYSTEM_ADMIN];
        }

        return undefined;
      });
      checkTokenMock.mockResolvedValue(buildUserWithRoles([UserRoleId.USER_ADMIN]));

      const context = buildContext({ headers: { authorization: 'Bearer abc' } });

      await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException(NOT_ALLOWED_MESSAGE));
    });

    it('returns true when the user holds a route-required role', async () => {
      reflectorGet.mockImplementation((key: string, target: unknown) => {
        if (key === ALLOWED_ROLES_METADATA_KEY && typeof target === 'function' && !('prototype' in target)) {
          return [UserRoleId.USER_ADMIN];
        }

        return undefined;
      });
      checkTokenMock.mockResolvedValue(buildUserWithRoles([UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN]));

      const context = buildContext({ headers: { authorization: 'Bearer abc' } });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('throws when the user does not hold any route-required role', async () => {
      reflectorGet.mockImplementation((key: string, target: unknown) => {
        if (key === ALLOWED_ROLES_METADATA_KEY && typeof target === 'function' && !('prototype' in target)) {
          return [UserRoleId.SYSTEM_ADMIN];
        }

        return undefined;
      });
      checkTokenMock.mockResolvedValue(buildUserWithRoles([UserRoleId.USER_ADMIN]));

      const context = buildContext({ headers: { authorization: 'Bearer abc' } });

      await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException(NOT_ALLOWED_MESSAGE));
    });

    it('returns true when no role requirements are set', async () => {
      reflectorGet.mockReturnValue(undefined);
      checkTokenMock.mockResolvedValue(buildUserWithRoles([]));

      const context = buildContext({ headers: { authorization: 'Bearer abc' } });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('first-time setup', () => {
    const buildHeldAdmin = (): User => {
      const user = buildUserWithRoles([UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN]);
      user.mustChangePassword = true;

      return user;
    };

    it('refuses an account held to setup on a route the setup screen does not need, roles notwithstanding', async () => {
      reflectorGet.mockImplementation((key: string, target: unknown) => {
        if (key === ALLOWED_ROLES_METADATA_KEY && typeof target === 'function' && target.prototype) {
          return [UserRoleId.USER_ADMIN];
        }

        return undefined;
      });
      checkTokenMock.mockResolvedValue(buildHeldAdmin());

      const context = buildContext({ headers: { authorization: 'Bearer abc' } });

      await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException(SETUP_REQUIRED_MESSAGE));
    });

    it('lets an account held to setup through on a route marked for setup', async () => {
      reflectorGet.mockImplementation((key: string, target: unknown) => {
        if (key === ALLOWED_DURING_SETUP_METADATA_KEY && typeof target === 'function' && !('prototype' in target)) {
          return true;
        }

        return undefined;
      });
      checkTokenMock.mockResolvedValue(buildHeldAdmin());

      const context = buildContext({ headers: { authorization: 'Bearer abc' } });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('ignores the setup mark on a controller', async () => {
      reflectorGet.mockImplementation((key: string, target: unknown) => {
        if (key === ALLOWED_DURING_SETUP_METADATA_KEY && typeof target === 'function' && target.prototype) {
          return true;
        }

        return undefined;
      });
      checkTokenMock.mockResolvedValue(buildHeldAdmin());

      const context = buildContext({ headers: { authorization: 'Bearer abc' } });

      await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException(SETUP_REQUIRED_MESSAGE));
    });
  });

  describe('Bearer token extraction', () => {
    it('strips the "Bearer " prefix before passing the token to UserService', async () => {
      reflectorGet.mockReturnValue(undefined);
      checkTokenMock.mockResolvedValue(buildUserWithRoles([]));

      const context = buildContext({ headers: { authorization: 'Bearer my-token-value' } });

      await guard.canActivate(context);

      expect(checkTokenMock).toHaveBeenCalledWith('my-token-value');
    });

    it('attaches the resolved user to the request', async () => {
      reflectorGet.mockReturnValue(undefined);

      const resolvedUser = buildUserWithRoles([UserRoleId.USER_ADMIN]);
      checkTokenMock.mockResolvedValue(resolvedUser);

      const request: IMockRequest = { headers: { authorization: 'Bearer abc' } };
      const context = buildContext(request);

      await guard.canActivate(context);

      expect(request.user).toBe(resolvedUser);
    });
  });

  describe('API keys', () => {
    const isHandler = (target: unknown) => typeof target === 'function' && !('prototype' in target);
    const isController = (target: unknown) => typeof target === 'function' && 'prototype' in target;

    const markHandler = (roleIds: UserRoleId[] = [UserRoleId.SYSTEM_ADMIN]) => {
      reflectorGet.mockImplementation((key: string, target: unknown) => {
        if (key === ALLOW_API_KEY_METADATA_KEY && isHandler(target)) {
          return true;
        }

        if (key === ALLOWED_ROLES_METADATA_KEY && isController(target)) {
          return roleIds;
        }

        return undefined;
      });
    };

    it('lets a valid key through to a handler marked for keys, without the session check', async () => {
      markHandler();

      const owner = buildUserWithRoles([UserRoleId.SYSTEM_ADMIN]);
      verifyApiKeyMock.mockResolvedValue(owner);

      const request: IMockRequest = { headers: { authorization: 'Bearer sfk_key' } };

      await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
      expect(verifyApiKeyMock).toHaveBeenCalledWith('sfk_key');
      expect(checkTokenMock).not.toHaveBeenCalled();
      expect(request.user).toBe(owner);
    });

    it('refuses an invalid key with 401', async () => {
      markHandler();
      verifyApiKeyMock.mockResolvedValue(null);

      const context = buildContext({ headers: { authorization: 'Bearer sfk_key' } });

      await expect(guard.canActivate(context)).rejects.toThrow(new UnauthorizedException(API_KEY_INVALID_MESSAGE));
    });

    it('refuses a valid key on a handler not marked for keys with 403', async () => {
      reflectorGet.mockReturnValue(undefined);
      verifyApiKeyMock.mockResolvedValue(buildUserWithRoles([UserRoleId.SYSTEM_ADMIN]));

      const context = buildContext({ headers: { authorization: 'Bearer sfk_key' } });

      await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException(API_KEY_NOT_ALLOWED_MESSAGE));
    });

    it('ignores the key mark on a controller', async () => {
      reflectorGet.mockImplementation((key: string, target: unknown) =>
        key === ALLOW_API_KEY_METADATA_KEY && isController(target) ? true : undefined
      );
      verifyApiKeyMock.mockResolvedValue(buildUserWithRoles([UserRoleId.SYSTEM_ADMIN]));

      const context = buildContext({ headers: { authorization: 'Bearer sfk_key' } });

      await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException(API_KEY_NOT_ALLOWED_MESSAGE));
    });

    it("holds a key to its owner's roles", async () => {
      markHandler();
      verifyApiKeyMock.mockResolvedValue(buildUserWithRoles([UserRoleId.USER_ADMIN]));

      const context = buildContext({ headers: { authorization: 'Bearer sfk_key' } });

      await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException(NOT_ALLOWED_MESSAGE));
    });
  });
});
