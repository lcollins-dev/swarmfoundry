import { QueueResponseDto, SourceListResponseDto, TriggerListResponseDto } from '@libs/dto';

import { RequestType } from '@/types/api';

import { useUserStore } from '@/stores/user';

import { useErrorService } from '../../ErrorService';
import { useApiService } from '../ApiService';

export const useTriggerAdminService = () => {
  const apiService = useApiService();
  const errorService = useErrorService();

  const userStore = useUserStore();

  async function getTriggerList(): Promise<TriggerListResponseDto> {
    const triggerList = await apiService
      .makeRequest('admin/trigger/list', RequestType.GET, {
        response: TriggerListResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return triggerList;
  }

  async function getSourceList(): Promise<SourceListResponseDto> {
    const sourceList = await apiService
      .makeRequest('admin/source/list', RequestType.GET, {
        response: SourceListResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return sourceList;
  }

  async function getQueue(): Promise<QueueResponseDto> {
    const queue = await apiService
      .makeRequest('admin/queue', RequestType.GET, {
        response: QueueResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return queue;
  }

  return {
    getTriggerList,
    getSourceList,
    getQueue,
  };
};
