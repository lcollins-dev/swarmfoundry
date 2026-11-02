import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CheckPasswordLinkResponseDto, PasswordLinkState, ProfileResponseDto, TokenResponseDto } from '@libs/dto';

import { RequestType } from '@/types/api';
import { ApiError, ApiErrorBase } from '@/types/api/error';

import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import { useErrorService } from '../ErrorService';
import { useApiService } from './ApiService';
import { usePasswordLinkService } from './PasswordLinkService';

vi.mock('./ApiService', () => ({
  useApiService: vi.fn(),
}));

vi.mock('../ErrorService', () => ({
  useErrorService: vi.fn(),
}));

const TOKEN = 'a'.repeat(64);
const PROFILE = { name: 'Tester', email: 'tester@example.com', userRoleIds: [], mustChangePassword: false };

describe('usePasswordLinkService', () => {
  let makeRequestMock: ReturnType<typeof vi.fn>;
  let handleErrorMock: ReturnType<typeof vi.fn>;
  let clearValidationErrorMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());

    makeRequestMock = vi.fn();
    handleErrorMock = vi.fn((error: unknown) => {
      throw error;
    });
    clearValidationErrorMock = vi.fn();

    vi.mocked(useApiService).mockReturnValue({
      makeRequest: makeRequestMock,
    } as unknown as ReturnType<typeof useApiService>);
    vi.mocked(useErrorService).mockReturnValue({
      handleError: handleErrorMock,
      clearValidationError: clearValidationErrorMock,
    } as unknown as ReturnType<typeof useErrorService>);

    useNotificationStore().clearAllNotifications = vi.fn<() => void>();
  });

  it('checks a link with the token in the body and no session', async () => {
    const checked = { state: PasswordLinkState.EXPIRED, passwordLink: null };
    makeRequestMock.mockResolvedValue(checked);

    await expect(usePasswordLinkService().checkPasswordLink(TOKEN)).resolves.toBe(checked);

    expect(makeRequestMock).toHaveBeenCalledWith('password-link/check', RequestType.POST, {
      response: CheckPasswordLinkResponseDto,
      body: { token: TOKEN },
    });
  });

  it('sets the password under the given form', async () => {
    makeRequestMock.mockResolvedValueOnce({ token: 'signed-jwt' }).mockResolvedValueOnce(PROFILE);

    await usePasswordLinkService().setPassword(TOKEN, 'TestPass123!', 'set-password');

    expect(makeRequestMock).toHaveBeenNthCalledWith(1, 'password-link', RequestType.POST, {
      response: TokenResponseDto,
      body: { token: TOKEN, password: 'TestPass123!' },
      form: 'set-password',
    });
  });

  it('stores the new session and then loads the profile with it', async () => {
    makeRequestMock.mockResolvedValueOnce({ token: 'signed-jwt' }).mockResolvedValueOnce(PROFILE);

    await usePasswordLinkService().setPassword(TOKEN, 'TestPass123!');

    expect(makeRequestMock).toHaveBeenNthCalledWith(2, 'user/profile', RequestType.GET, {
      response: ProfileResponseDto,
      token: 'signed-jwt',
    });
    expect(useUserStore().profile).toEqual(PROFILE);
  });

  it('leaves the session untouched and clears the validation error when refused', async () => {
    makeRequestMock.mockRejectedValue(new ApiError(ApiErrorBase.UNKNOWN, 'Refused'));

    await expect(usePasswordLinkService().setPassword(TOKEN, 'TestPass123!')).rejects.toThrow();

    expect(useUserStore().loggedIn).toBe(false);
    expect(clearValidationErrorMock).toHaveBeenCalled();
  });
});
