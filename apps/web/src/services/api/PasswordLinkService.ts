import {
  CheckPasswordLinkResponseDto,
  TokenResponseDto,
  type CheckPasswordLinkRequestDto,
  type SetPasswordRequestDto,
} from '@libs/dto';

import { RequestType } from '@/types/api';

import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import { useErrorService } from '../ErrorService';
import { useApiService } from './ApiService';
import { useUserService } from './UserService';

export const usePasswordLinkService = () => {
  const userStore = useUserStore();
  const notificationStore = useNotificationStore();

  const apiService = useApiService();
  const errorService = useErrorService();
  const userService = useUserService();

  async function checkPasswordLink(token: string): Promise<CheckPasswordLinkResponseDto> {
    const checkRequest: CheckPasswordLinkRequestDto = { token };

    const checked = await apiService
      .makeRequest('password-link/check', RequestType.POST, {
        response: CheckPasswordLinkResponseDto,
        body: checkRequest,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return checked;
  }

  /** Signs the user in with the session the new password starts. */
  async function setPassword(token: string, password: string, form: string | null = null): Promise<void> {
    const setPasswordRequest: SetPasswordRequestDto = { token, password };

    const tokenResponse = await apiService
      .makeRequest('password-link', RequestType.POST, {
        response: TokenResponseDto,
        body: setPasswordRequest,
        form,
      })
      .finally(() => errorService.clearValidationError())
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();
    userStore.setToken(tokenResponse.token);

    await userService.getProfile();
  }

  return { checkPasswordLink, setPassword };
};
