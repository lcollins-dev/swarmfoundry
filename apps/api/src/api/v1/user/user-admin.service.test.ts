import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserListStatus, UserRoleId } from '@libs/dto';

import { UserRole } from '@/core/user/entities/user-role.entity';
import { UserUserRole } from '@/core/user/entities/user-user-role.entity';
import { User } from '@/core/user/entities/user.entity';

import { UserAdminService } from '@/api/v1/user/user-admin.service';
import { ConfigService } from '@/config/config.service';
import { UserService } from '@/core/user/user.service';

const PAGE_SIZE = 10;

const buildUser = (overrides: Partial<User> = {}): User => {
  const user = new User({ name: 'Tester', email: 'tester@example.com', passwordHash: 'hash' });

  user.id = 1;
  user.enabled = true;
  user.lastLoginSuccess = null;
  user.lastLoginFail = null;
  user.lastAccess = new Date('2026-05-15T12:00:00Z');
  user.createdDate = new Date('2026-05-01T09:00:00Z');
  user.userUserRoles = [];

  Object.assign(user, overrides);

  return user;
};

describe('UserAdminService', () => {
  let userAdminService: UserAdminService;
  let userService: {
    findRoles: ReturnType<typeof vi.fn>;
    findAndCount: ReturnType<typeof vi.fn>;
    countByState: ReturnType<typeof vi.fn>;
    findWithThrow: ReturnType<typeof vi.fn>;
    setEnabled: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    userService = {
      findRoles: vi.fn().mockResolvedValue([]),
      findAndCount: vi.fn().mockResolvedValue([[], 0]),
      countByState: vi.fn().mockResolvedValue({ total: 0, enabled: 0 }),
      findWithThrow: vi.fn().mockResolvedValue(buildUser()),
      setEnabled: vi.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UserAdminService,
        { provide: ConfigService, useValue: { pageSize: PAGE_SIZE } },
        { provide: UserService, useValue: userService },
      ],
    }).compile();

    userAdminService = moduleRef.get(UserAdminService);
  });

  describe('getRoleList', () => {
    it('reads each role down to its id and name', async () => {
      userService.findRoles.mockResolvedValue([new UserRole(UserRoleId.USER_ADMIN, 'User Admin')]);

      const roles = await userAdminService.getRoleList();

      expect(roles).toEqual([{ id: UserRoleId.USER_ADMIN, name: 'User Admin' }]);
    });
  });

  describe('getUserList', () => {
    it('turns the requested page into an offset and a limit', async () => {
      await userAdminService.getUserList({ status: UserListStatus.ALL }, 3);

      expect(userService.findAndCount).toHaveBeenCalledWith(
        { search: undefined, enabled: undefined },
        PAGE_SIZE * 2,
        PAGE_SIZE
      );
    });

    it('passes the search term through as criteria', async () => {
      await userAdminService.getUserList({ status: UserListStatus.ALL, search: 'tester' }, 1);

      expect(userService.findAndCount).toHaveBeenCalledWith({ search: 'tester', enabled: undefined }, 0, PAGE_SIZE);
    });

    it('narrows to enabled users when the status is ENABLED', async () => {
      await userAdminService.getUserList({ status: UserListStatus.ENABLED }, 1);

      expect(userService.findAndCount).toHaveBeenCalledWith({ search: undefined, enabled: true }, 0, PAGE_SIZE);
    });

    it('narrows to disabled users when the status is DISABLED', async () => {
      await userAdminService.getUserList({ status: UserListStatus.DISABLED }, 1);

      expect(userService.findAndCount).toHaveBeenCalledWith({ search: undefined, enabled: false }, 0, PAGE_SIZE);
    });

    it('maps role ids off the junction rows', async () => {
      const user = buildUser({ userUserRoles: [new UserUserRole(1, UserRoleId.USER_ADMIN)] });
      userService.findAndCount.mockResolvedValue([[user], 1]);

      const response = await userAdminService.getUserList({ status: UserListStatus.ALL }, 1);

      expect(response.userList).toEqual([
        {
          id: 1,
          name: 'Tester',
          email: 'tester@example.com',
          enabled: true,
          userRoleIds: [UserRoleId.USER_ADMIN],
          lastAccess: new Date('2026-05-15T12:00:00Z'),
          createdDate: new Date('2026-05-01T09:00:00Z'),
        },
      ]);
    });

    it('rounds the page count up on a partial last page', async () => {
      userService.findAndCount.mockResolvedValue([[], 21]);

      const response = await userAdminService.getUserList({ status: UserListStatus.ALL }, 1);

      expect(response.pages).toBe(3);
    });

    it('reports how many users match across every page', async () => {
      userService.findAndCount.mockResolvedValue([[], 21]);

      const response = await userAdminService.getUserList({ status: UserListStatus.DISABLED }, 1);

      expect(response.total).toBe(21);
    });

    it('reports no pages when nothing matches', async () => {
      const response = await userAdminService.getUserList({ status: UserListStatus.ALL }, 1);

      expect(response.pages).toBe(0);
    });
  });

  describe('getUserStats', () => {
    it('derives the disabled count from the total', async () => {
      userService.countByState.mockResolvedValue({ total: 10, enabled: 7 });

      const stats = await userAdminService.getUserStats();

      expect(stats).toEqual({ total: 10, enabled: 7, disabled: 3 });
    });
  });

  describe('getUser', () => {
    it('asks for the roles alongside the row', async () => {
      await userAdminService.getUser(1);

      expect(userService.findWithThrow).toHaveBeenCalledWith(1, true);
    });

    it('throws when the user does not exist', async () => {
      userService.findWithThrow.mockRejectedValue(new BadRequestException());

      await expect(userAdminService.getUser(1)).rejects.toThrow(BadRequestException);
    });

    it('carries the login, access and creation dates', async () => {
      const lastLoginSuccess = new Date('2026-05-14T08:30:00Z');
      userService.findWithThrow.mockResolvedValue(buildUser({ lastLoginSuccess }));

      const user = await userAdminService.getUser(1);

      expect(user.lastLoginSuccess).toEqual(lastLoginSuccess);
      expect(user.lastAccess).toEqual(new Date('2026-05-15T12:00:00Z'));
      expect(user.createdDate).toEqual(new Date('2026-05-01T09:00:00Z'));
    });

    it('reports never-set login dates as null', async () => {
      const user = await userAdminService.getUser(1);

      expect(user.lastLoginSuccess).toBeNull();
      expect(user.lastLoginFail).toBeNull();
    });
  });

  describe('updateState', () => {
    it('changes state through the domain', async () => {
      await userAdminService.updateState(false, 1);

      expect(userService.setEnabled).toHaveBeenCalledWith(1, false);
    });
  });
});
