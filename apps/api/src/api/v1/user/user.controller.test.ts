import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateProfileRequestDto, UserRoleId } from '@libs/dto';

import { ALLOWED_DURING_SETUP_METADATA_KEY } from '@/api/v1/user/guards/auth.guard';

import { UserUserRole } from '@/core/user/entities/user-user-role.entity';
import { User } from '@/core/user/entities/user.entity';

import { UserService } from '@/core/user/user.service';

import { UserController } from '@/api/v1/user/user.controller';

describe('UserController', () => {
  let controller: UserController;
  let updateProfileMock: ReturnType<typeof vi.fn>;
  let startSessionMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    updateProfileMock = vi.fn().mockResolvedValue(undefined);
    startSessionMock = vi.fn();

    const moduleRef = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        {
          provide: UserService,
          useValue: {
            updateProfile: updateProfileMock,
            startSession: startSessionMock,
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(UserController);
  });

  describe('updateProfile', () => {
    const buildUpdateProfileRequest = (password?: string): UpdateProfileRequestDto => ({
      name: 'Tester',
      email: 'tester@example.com',
      password,
    });

    const buildUser = (): User => {
      const user = new User({ name: 'Tester', email: 'tester@example.com', passwordHash: 'hash' });
      user.id = 7;

      return user;
    };

    it('hands back a replacement token when the password changed', async () => {
      startSessionMock.mockResolvedValue('new-jwt');

      const response = await controller.updateProfile(buildUser(), buildUpdateProfileRequest('Sup3r$ecret'));

      expect(updateProfileMock).toHaveBeenCalledWith('Tester', 'tester@example.com', 'Sup3r$ecret', 7);
      expect(response).toEqual({ token: 'new-jwt' });
    });

    it('starts no new session when the password was left alone', async () => {
      const response = await controller.updateProfile(buildUser(), buildUpdateProfileRequest());

      expect(startSessionMock).not.toHaveBeenCalled();
      expect(response).toEqual({});
    });
  });

  describe('getProfile', () => {
    it('maps user role ids from userRoleId (not the junction-table id)', () => {
      const user = new User({ name: 'Tester', email: 'tester@example.com', passwordHash: 'hash' });
      user.id = 1;

      const adminRole = new UserUserRole(1, UserRoleId.USER_ADMIN);
      adminRole.id = 501;
      const systemRole = new UserUserRole(1, UserRoleId.SYSTEM_ADMIN);
      systemRole.id = 502;

      user.userUserRoles = [adminRole, systemRole];

      const profile = controller.getProfile(user);

      expect(profile).toEqual({
        name: 'Tester',
        email: 'tester@example.com',
        userRoleIds: [UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN],
        mustChangePassword: false,
      });
    });

    it('reports a hold on first-time setup', () => {
      const user = new User({
        name: 'Admin',
        email: 'admin@example.com',
        passwordHash: 'hash',
        mustChangePassword: true,
      });
      user.userUserRoles = [];

      expect(controller.getProfile(user).mustChangePassword).toBe(true);
    });

    it('returns an empty role list when the user has no roles', () => {
      const user = new User({ name: 'Tester', email: 'tester@example.com', passwordHash: 'hash' });
      user.id = 1;
      user.userUserRoles = [];

      const profile = controller.getProfile(user);

      expect(profile.userRoleIds).toEqual([]);
    });
  });

  describe('first-time setup', () => {
    const allowedDuringSetup = (handlerName: keyof UserController): unknown => {
      const handler: unknown = Object.getOwnPropertyDescriptor(UserController.prototype, handlerName)?.value;

      return typeof handler === 'function'
        ? Reflect.getMetadata(ALLOWED_DURING_SETUP_METADATA_KEY, handler)
        : undefined;
    };

    it('opens only the routes the setup screen needs to an account held to setup', () => {
      expect(allowedDuringSetup('getProfile')).toBe(true);
      expect(allowedDuringSetup('updateProfile')).toBe(true);
      expect(allowedDuringSetup('doLogout')).toBe(true);
      expect(allowedDuringSetup('login')).toBeUndefined();
    });
  });
});
