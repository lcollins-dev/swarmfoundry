import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GetSysConfigResponseDto } from '@libs/dto';

import { RequestType } from '@/types/api';
import { ApiError, ApiErrorBase } from '@/types/api/error';

import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import { useErrorService } from '../../ErrorService';
import { useApiService } from '../ApiService';
import { useSysConfigAdminService } from './SysConfigAdminService';

vi.mock('../ApiService', () => ({
  useApiService: vi.fn(),
}));

vi.mock('../../ErrorService', () => ({
  useErrorService: vi.fn(),
}));

const TOKEN_OPTIONS = { token: 'signed-jwt' };

describe('useSysConfigAdminService', () => {
  let makeRequestMock: ReturnType<typeof vi.fn>;
  let handleErrorMock: ReturnType<typeof vi.fn>;
  let clearValidationErrorMock: ReturnType<typeof vi.fn>;
  let clearAllNotificationsMock: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    setActivePinia(createPinia());

    makeRequestMock = vi.fn().mockResolvedValue(undefined);
    handleErrorMock = vi.fn((error: unknown) => {
      throw error;
    });
    clearValidationErrorMock = vi.fn();
    clearAllNotificationsMock = vi.fn<() => void>();

    vi.mocked(useApiService).mockReturnValue({
      makeRequest: makeRequestMock,
    } as unknown as ReturnType<typeof useApiService>);
    vi.mocked(useErrorService).mockReturnValue({
      handleError: handleErrorMock,
      clearValidationError: clearValidationErrorMock,
    } as unknown as ReturnType<typeof useErrorService>);

    useNotificationStore().clearAllNotifications = clearAllNotificationsMock;
    useUserStore().setToken('signed-jwt');
  });

  it('reads the config', async () => {
    makeRequestMock.mockResolvedValue({ registrationEnabled: true });

    const response = await useSysConfigAdminService().getSysConfig();

    expect(makeRequestMock).toHaveBeenCalledWith('admin/sys-config', RequestType.GET, {
      ...TOKEN_OPTIONS,
      response: GetSysConfigResponseDto,
    });
    expect(response).toEqual({ registrationEnabled: true });
  });

  it('patches the config under the given form', async () => {
    await useSysConfigAdminService().updateSysConfig({ registrationEnabled: false }, 'sys-config');

    expect(makeRequestMock).toHaveBeenCalledWith('admin/sys-config', RequestType.PATCH, {
      ...TOKEN_OPTIONS,
      form: 'sys-config',
      body: { registrationEnabled: false },
    });
    expect(clearAllNotificationsMock).toHaveBeenCalled();
  });

  it('clears the validation error whether the patch succeeds or fails', async () => {
    makeRequestMock.mockRejectedValue(new ApiError(ApiErrorBase.UNKNOWN));

    await expect(useSysConfigAdminService().updateSysConfig({ registrationEnabled: false })).rejects.toThrow();

    expect(clearValidationErrorMock).toHaveBeenCalled();
    expect(clearAllNotificationsMock).not.toHaveBeenCalled();
  });
});
