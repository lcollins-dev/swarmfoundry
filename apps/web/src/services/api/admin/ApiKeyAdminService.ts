import { ApiKeyListResponseDto, CreateApiKeyResponseDto, type ApiKeyDto, type CreateApiKeyRequestDto } from '@libs/dto';

import { RequestType } from '@/types/api';

import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import { useErrorService } from '../../ErrorService';
import { useApiService } from '../ApiService';

export const useApiKeyAdminService = () => {
  const apiService = useApiService();
  const errorService = useErrorService();

  const userStore = useUserStore();
  const notificationStore = useNotificationStore();

  async function getApiKeyList(): Promise<ApiKeyDto[]> {
    const response = await apiService
      .makeRequest('admin/api-key/list', RequestType.GET, {
        response: ApiKeyListResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return response.apiKeyList;
  }

  async function getUserApiKeyList(userId: number): Promise<ApiKeyDto[]> {
    const response = await apiService
      .makeRequest(`admin/api-key/user/${userId}`, RequestType.GET, {
        response: ApiKeyListResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return response.apiKeyList;
  }

  async function createApiKey(
    createApiKeyRequest: CreateApiKeyRequestDto,
    form: string | null = null
  ): Promise<CreateApiKeyResponseDto> {
    const response = await apiService
      .makeRequest('admin/api-key', RequestType.POST, {
        response: CreateApiKeyResponseDto,
        token: userStore.token,
        body: createApiKeyRequest,
        form,
      })
      .finally(() => errorService.clearValidationError())
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();

    return response;
  }

  async function revokeApiKey(apiKeyId: number): Promise<void> {
    await apiService
      .makeRequest(`admin/api-key/${apiKeyId}`, RequestType.DELETE, {
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();
  }

  return {
    getApiKeyList,
    getUserApiKeyList,
    createApiKey,
    revokeApiKey,
  };
};
