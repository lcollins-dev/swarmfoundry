import { ConfigResponseDto } from '@libs/dto';

import { RequestType } from '@/types/api';

import { useUserStore } from '@/stores/user';

import { useErrorService } from '../../ErrorService';
import { useApiService } from '../ApiService';

export const useConfigAdminService = () => {
  const apiService = useApiService();
  const errorService = useErrorService();

  const userStore = useUserStore();

  async function getConfig(): Promise<ConfigResponseDto> {
    const config = await apiService
      .makeRequest('admin/config', RequestType.GET, {
        response: ConfigResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return config;
  }

  return {
    getConfig,
  };
};
