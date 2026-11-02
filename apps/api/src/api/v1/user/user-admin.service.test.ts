import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserListStatus, UserRoleId } from '@libs/dto';

import { UserRole } from '@/core/user/entities/user-role.entity';
import { UserUserRole } from '@/core/user/entities/user-user-role.entity';
import { User } from '@/core/user/entities/user.entity';

import {
  DISABLED_PASSWORD_LINK_MESSAGE,
  OWN_PASSWORD_LINK_MESSAGE,
  OWN_ROLES_MESSAGE,
  OWN_STATE_MESSAGE,
  UserAdminService,
} from '@/api/v1/user/user-admin.service';
import { ConfigService } from '@/config/config.service';
import { PasswordLinkService } from '@/core/user/password-link.service';
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
    invite: ReturnType<typeof vi.fn>;
    updateProfile: ReturnType<typeof vi.fn>;
    updateRoles: ReturnType<typeof vi.fn>;
  };
  let issueMock: ReturnType<typeof vi.fn>;

  const issuedLink = { link: 'https://app.test/set-password#token', expiresAt: new Date(), emailed: true };

  beforeEach(async () => {
    userService = {
      findRoles: vi.fn().mockResolvedValue([]),
      findAndCount: vi.fn().mockResolvedValue([[], 0]),
      countByState: vi.fn().mockResolvedValue({ total: 0, enabled: 0 }),
      findWithThrow: vi.fn().mockResolvedValue(buildUser()),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      invite: vi.fn(),
      updateProfile: vi.fn().mockResolvedValue(undefined),
      updateRoles: vi.fn().mockResolvedValue(undefined),
    };
    issueMock = vi.fn().mockResolvedValue(issuedLink);

    const moduleRef = await Test.createTestingModule({
      providers: [
        UserAdminService,
        { provide: ConfigService, useValue: { pageSize: PAGE_SIZE } },
        { provide: UserService, useValue: userService },
        { provide: PasswordLinkService, useValue: { issue: issueMock } },
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
          invited: false,
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

    it('marks a user without a password as invited', async () => {
      userService.findWithThrow.mockResolvedValue(buildUser({ passwordHash: null }));

      await expect(userAdminService.getUser(1)).resolves.toMatchObject({ invited: true });
    });

    it('marks a user with a password as not invited', async () => {
      await expect(userAdminService.getUser(1)).resolves.toMatchObject({ invited: false });
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

  describe('inviteUser', () => {
    it('invites the user and answers with their id and link', async () => {
      const invited = buildUser({ id: 42, passwordHash: null });
      userService.invite.mockResolvedValue(invited);

      const response = await userAdminService.inviteUser({
        name: 'Tester',
        email: 'tester@example.com',
        userRoleIds: [UserRoleId.SYSTEM_ADMIN],
      });

      expect(userService.invite).toHaveBeenCalledWith('Tester', 'tester@example.com', [UserRoleId.SYSTEM_ADMIN]);
      expect(issueMock).toHaveBeenCalledWith(invited);
      expect(response).toEqual({ userId: 42, passwordLink: issuedLink });
    });
  });

  describe('updateUser', () => {
    const caller = buildUser({
      id: 5,
      userUserRoles: [new UserUserRole(5, UserRoleId.USER_ADMIN)],
    });

    it('updates the profile and then the roles of another user', async () => {
      await userAdminService.updateUser(
        caller,
        { name: 'Renamed', email: 'tester@example.com', userRoleIds: [UserRoleId.SYSTEM_ADMIN] },
        1
      );

      expect(userService.updateProfile).toHaveBeenCalledWith('Renamed', 'tester@example.com', undefined, 1);
      expect(userService.updateRoles).toHaveBeenCalledWith([UserRoleId.SYSTEM_ADMIN], 1);
    });

    it("refuses a change to the caller's own roles", async () => {
      await expect(
        userAdminService.updateUser(caller, { name: 'Admin', email: 'admin@example.com', userRoleIds: [] }, 5)
      ).rejects.toThrow(OWN_ROLES_MESSAGE);

      expect(userService.updateProfile).not.toHaveBeenCalled();
    });

    it('lets the caller save their own profile with their roles unchanged', async () => {
      await userAdminService.updateUser(
        caller,
        { name: 'Admin', email: 'admin@example.com', userRoleIds: [UserRoleId.USER_ADMIN] },
        5
      );

      expect(userService.updateRoles).toHaveBeenCalledWith([UserRoleId.USER_ADMIN], 5);
    });
  });

  describe('updateState', () => {
    const caller = buildUser({ id: 5 });

    it('changes state through the domain', async () => {
      await userAdminService.updateState(caller, false, 1);

      expect(userService.setEnabled).toHaveBeenCalledWith(1, false);
    });

    it('refuses to disable the caller', async () => {
      await expect(userAdminService.updateState(caller, false, 5)).rejects.toThrow(OWN_STATE_MESSAGE);

      expect(userService.setEnabled).not.toHaveBeenCalled();
    });
  });

  describe('createPasswordLink', () => {
    const caller = buildUser({ id: 5 });

    it('issues a link for another user', async () => {
      const target = buildUser();
      userService.findWithThrow.mockResolvedValue(target);

      await expect(userAdminService.createPasswordLink(caller, 1)).resolves.toBe(issuedLink);

      expect(issueMock).toHaveBeenCalledWith(target);
    });

    it('refuses a link for the caller', async () => {
      await expect(userAdminService.createPasswordLink(caller, 5)).rejects.toThrow(OWN_PASSWORD_LINK_MESSAGE);

      expect(issueMock).not.toHaveBeenCalled();
    });

    it('refuses a link for a disabled user', async () => {
      userService.findWithThrow.mockResolvedValue(buildUser({ enabled: false }));

      await expect(userAdminService.createPasswordLink(caller, 1)).rejects.toThrow(DISABLED_PASSWORD_LINK_MESSAGE);

      expect(issueMock).not.toHaveBeenCalled();
    });
  });
});
