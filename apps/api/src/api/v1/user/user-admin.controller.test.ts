import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InviteUserRequestDto, UpdateUserRequestDto, UserListStatus, UserRoleId } from '@libs/dto';

import { User } from '@/core/user/entities/user.entity';

import { UserAdminService } from '@/api/v1/user/user-admin.service';
import { UserService } from '@/core/user/user.service';

import { UserAdminController } from '@/api/v1/user/user-admin.controller';

const buildInviteUserRequest = (): InviteUserRequestDto => ({
  name: 'Tester',
  email: 'tester@example.com',
  userRoleIds: [UserRoleId.USER_ADMIN],
});

const caller = new User({ name: 'Admin', email: 'admin@example.com', passwordHash: 'hash' });
caller.id = 1;

const buildUpdateUserRequest = (overrides: Partial<UpdateUserRequestDto> = {}): UpdateUserRequestDto => ({
  name: 'Tester',
  email: 'tester@example.com',
  userRoleIds: [],
  ...overrides,
});

describe('UserAdminController', () => {
  let controller: UserAdminController;
  let inviteUserMock: ReturnType<typeof vi.fn>;
  let updateUserMock: ReturnType<typeof vi.fn>;
  let createPasswordLinkMock: ReturnType<typeof vi.fn>;
  let invalidateSessionsMock: ReturnType<typeof vi.fn>;
  let getRoleListMock: ReturnType<typeof vi.fn>;
  let getUserStatsMock: ReturnType<typeof vi.fn>;
  let getUserListMock: ReturnType<typeof vi.fn>;
  let getUserMock: ReturnType<typeof vi.fn>;
  let updateStateMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    inviteUserMock = vi.fn();
    updateUserMock = vi.fn().mockResolvedValue(undefined);
    createPasswordLinkMock = vi.fn();
    invalidateSessionsMock = vi.fn().mockResolvedValue(undefined);
    getRoleListMock = vi.fn();
    getUserStatsMock = vi.fn();
    getUserListMock = vi.fn();
    getUserMock = vi.fn();
    updateStateMock = vi.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      controllers: [UserAdminController],
      providers: [
        {
          provide: UserService,
          useValue: {
            invalidateSessions: invalidateSessionsMock,
          },
        },
        {
          provide: UserAdminService,
          useValue: {
            getRoleList: getRoleListMock,
            getUserStats: getUserStatsMock,
            getUserList: getUserListMock,
            getUser: getUserMock,
            updateState: updateStateMock,
            inviteUser: inviteUserMock,
            updateUser: updateUserMock,
            createPasswordLink: createPasswordLinkMock,
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(UserAdminController);
  });

  it('returns the role list from the service', async () => {
    getRoleListMock.mockResolvedValue([]);

    await expect(controller.getRoleList()).resolves.toEqual([]);
  });

  it('returns the user stats from the service', async () => {
    getUserStatsMock.mockResolvedValue({ total: 3, enabled: 2, disabled: 1 });

    await expect(controller.getUserStats()).resolves.toEqual({ total: 3, enabled: 2, disabled: 1 });
  });

  it('passes the filter body and the page number through to the list', async () => {
    getUserListMock.mockResolvedValue({ userList: [], pages: 0, total: 0 });

    const userListRequest = { status: UserListStatus.ALL };

    await controller.getUserList(userListRequest, 2);

    expect(getUserListMock).toHaveBeenCalledWith(userListRequest, 2);
  });

  describe('inviteUser', () => {
    it('answers what the service answers', async () => {
      const invited = { userId: 42, passwordLink: { link: 'link', expiresAt: new Date(), emailed: true } };
      inviteUserMock.mockResolvedValue(invited);

      await expect(controller.inviteUser(buildInviteUserRequest())).resolves.toBe(invited);

      expect(inviteUserMock).toHaveBeenCalledWith(buildInviteUserRequest());
    });
  });

  describe('updateUser', () => {
    it('passes the caller through, so the service can refuse their own roles', async () => {
      const request = buildUpdateUserRequest({ userRoleIds: [UserRoleId.SYSTEM_ADMIN] });

      await controller.updateUser(caller, 7, request);

      expect(updateUserMock).toHaveBeenCalledWith(caller, request, 7);
    });
  });

  describe('updateState', () => {
    it('unwraps the enabled flag from the body', async () => {
      await controller.updateState(caller, 7, { enabled: false });

      expect(updateStateMock).toHaveBeenCalledWith(caller, false, 7);
    });
  });

  describe('createPasswordLink', () => {
    it('passes the caller and the addressed user through', async () => {
      await controller.createPasswordLink(caller, 7);

      expect(createPasswordLinkMock).toHaveBeenCalledWith(caller, 7);
    });
  });

  describe('logoutAllSessions', () => {
    it('invalidates the addressed user session', async () => {
      await controller.logoutAllSessions(7);

      expect(invalidateSessionsMock).toHaveBeenCalledWith(7);
    });
  });

  describe('getUser', () => {
    it('passes the parsed id through', async () => {
      getUserMock.mockResolvedValue({ id: 7 });

      await controller.getUser(7);

      expect(getUserMock).toHaveBeenCalledWith(7);
    });
  });
});
