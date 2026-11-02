import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QueueResponseDto, SourceListResponseDto, TriggerListResponseDto } from '@libs/dto';

import { RequestType } from '@/types/api';

import { useUserStore } from '@/stores/user';

import { useErrorService } from '../../ErrorService';
import { useApiService } from '../ApiService';
import { useTriggerAdminService } from './TriggerAdminService';

vi.mock('../ApiService', () => ({
  useApiService: vi.fn(),
}));

vi.mock('../../ErrorService', () => ({
  useErrorService: vi.fn(),
}));

const TOKEN_OPTIONS = { token: 'signed-jwt' };

describe('useTriggerAdminService', () => {
  let makeRequestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());

    makeRequestMock = vi.fn().mockResolvedValue(undefined);

    vi.mocked(useApiService).mockReturnValue({
      makeRequest: makeRequestMock,
    } as unknown as ReturnType<typeof useApiService>);
    vi.mocked(useErrorService).mockReturnValue({
      handleError: vi.fn(),
    } as unknown as ReturnType<typeof useErrorService>);

    useUserStore().setToken('signed-jwt');
  });

  it('reads the triggers and the sources of the running config, and the queue', async () => {
    await useTriggerAdminService().getTriggerList();
    await useTriggerAdminService().getSourceList();
    await useTriggerAdminService().getQueue();

    expect(makeRequestMock).toHaveBeenCalledWith('admin/trigger/list', RequestType.GET, {
      ...TOKEN_OPTIONS,
      response: TriggerListResponseDto,
    });
    expect(makeRequestMock).toHaveBeenCalledWith('admin/source/list', RequestType.GET, {
      ...TOKEN_OPTIONS,
      response: SourceListResponseDto,
    });
    expect(makeRequestMock).toHaveBeenCalledWith('admin/queue', RequestType.GET, {
      ...TOKEN_OPTIONS,
      response: QueueResponseDto,
    });
  });
});
