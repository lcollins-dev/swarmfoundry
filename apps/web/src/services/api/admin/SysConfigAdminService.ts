import { GetSysConfigResponseDto, type UpdateSysConfigRequestDto } from '@libs/dto';

import { RequestType } from '@/types/api';

import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import { useErrorService } from '../../ErrorService';
import { useApiService } from '../ApiService';

export const useSysConfigAdminService = () => {
  const userStore = useUserStore();
  const notificationStore = useNotificationStore();

  const apiService = useApiService();
  const errorService = useErrorService();

  async function getSysConfig(): Promise<GetSysConfigResponseDto> {
    const getSysConfigResponse = await apiService
      .makeRequest('admin/sys-config', RequestType.GET, {
        response: GetSysConfigResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return getSysConfigResponse;
  }

  async function updateSysConfig(
    updateSysConfigRequest: UpdateSysConfigRequestDto,
    form: string | null = null
  ): Promise<void> {
    await apiService
      .makeRequest('admin/sys-config', RequestType.PATCH, {
        token: userStore.token,
        form,
        body: updateSysConfigRequest,
      })
      .finally(() => errorService.clearValidationError())
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();
  }

  return { getSysConfig, updateSysConfig };
};
