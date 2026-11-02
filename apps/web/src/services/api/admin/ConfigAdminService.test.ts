import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigResponseDto } from '@libs/dto';

import { RequestType } from '@/types/api';

import { useUserStore } from '@/stores/user';

import { useErrorService } from '../../ErrorService';
import { useApiService } from '../ApiService';
import { useConfigAdminService } from './ConfigAdminService';

vi.mock('../ApiService', () => ({
  useApiService: vi.fn(),
}));

vi.mock('../../ErrorService', () => ({
  useErrorService: vi.fn(),
}));

describe('useConfigAdminService', () => {
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

  it('reads the running config', async () => {
    await useConfigAdminService().getConfig();

    expect(makeRequestMock).toHaveBeenCalledWith('admin/config', RequestType.GET, {
      token: 'signed-jwt',
      response: ConfigResponseDto,
    });
  });
});
