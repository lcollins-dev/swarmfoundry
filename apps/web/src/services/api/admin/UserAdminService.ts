import {
  InviteUserResponseDto,
  PasswordLinkDto,
  type InviteUserRequestDto,
  type UpdateStateRequestDto,
  type UpdateUserRequestDto,
  type UserListRequestDto,
  type UserRoleDto,
  UserListResponseDto,
  UserRoleListResponseDto,
  UserDto,
  UserStatsResponseDto,
} from '@libs/dto';

import { RequestType } from '@/types/api';

import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import { useErrorService } from '../../ErrorService';
import { useApiService } from '../ApiService';

export const useUserAdminService = () => {
  const apiService = useApiService();
  const errorService = useErrorService();

  const userStore = useUserStore();
  const notificationStore = useNotificationStore();

  async function getRoleList(): Promise<UserRoleDto[]> {
    const roleList = await apiService
      .makeRequest('admin/user/role/list', RequestType.GET, {
        response: UserRoleListResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return roleList;
  }

  async function getUserList(
    userListRequest: UserListRequestDto,
    page: number,
    form: string | null = null
  ): Promise<UserListResponseDto> {
    const userList = await apiService
      .makeRequest(`admin/user/list?page=${page}`, RequestType.PATCH, {
        response: UserListResponseDto,
        token: userStore.token,
        body: userListRequest,
        form,
      })
      .finally(() => errorService.clearValidationError())
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();

    return userList;
  }

  async function getUserStats(): Promise<UserStatsResponseDto> {
    const stats = await apiService
      .makeRequest('admin/user/stats', RequestType.GET, {
        response: UserStatsResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return stats;
  }

  async function inviteUser(
    inviteUserRequest: InviteUserRequestDto,
    form: string | null = null
  ): Promise<InviteUserResponseDto> {
    const inviteUserResponse = await apiService
      .makeRequest('admin/user/invite', RequestType.POST, {
        response: InviteUserResponseDto,
        token: userStore.token,
        body: inviteUserRequest,
        form,
      })
      .finally(() => errorService.clearValidationError())
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();

    return inviteUserResponse;
  }

  async function getUser(userId: number, form: string | null = null): Promise<UserDto> {
    const user = await apiService
      .makeRequest(`admin/user/${userId}`, RequestType.GET, {
        response: UserDto,
        token: userStore.token,
        form,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return user;
  }

  async function updateUser(
    updateUserRequest: UpdateUserRequestDto,
    userId: number,
    form: string | null = null
  ): Promise<void> {
    await apiService
      .makeRequest(`admin/user/${userId}`, RequestType.PATCH, {
        token: userStore.token,
        body: updateUserRequest,
        form,
      })
      .finally(() => errorService.clearValidationError())
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();
  }

  async function updateState(
    updateStateRequest: UpdateStateRequestDto,
    userId: number,
    form: string | null = null
  ): Promise<void> {
    await apiService
      .makeRequest(`admin/user/${userId}/state`, RequestType.PATCH, {
        token: userStore.token,
        body: updateStateRequest,
        form,
      })
      .finally(() => errorService.clearValidationError())
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();
  }

  async function logoutAllSessions(userId: number, form: string | null = null): Promise<void> {
    await apiService
      .makeRequest(`admin/user/${userId}/logout-all-sessions`, RequestType.PATCH, {
        token: userStore.token,
        form,
      })
      .finally(() => errorService.clearValidationError())
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();
  }

  async function createPasswordLink(userId: number): Promise<PasswordLinkDto> {
    const passwordLink = await apiService
      .makeRequest(`admin/user/${userId}/password-link`, RequestType.POST, {
        response: PasswordLinkDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();

    return passwordLink;
  }

  return {
    getRoleList,
    getUserList,
    getUserStats,
    inviteUser,
    createPasswordLink,
    getUser,
    updateUser,
    updateState,
    logoutAllSessions,
  };
};
