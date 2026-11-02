import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ApiKeyDto, type PasswordLinkDto, type UserDto, UserRoleId } from '@libs/dto';

import { useDialogStore } from '@/stores/dialog';
import { useUserStore } from '@/stores/user';

import User from './User.vue';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateUser: vi.fn(),
  updateState: vi.fn(),
  logoutAllSessions: vi.fn(),
  createPasswordLink: vi.fn(),
}));

const apiKeyMocks = vi.hoisted(() => ({
  getUserApiKeyList: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock('vue-router', async importOriginal => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRoute: () => ({ params: { userId: '42' }, fullPath: '/users/42' }),
  useRouter: () => ({ options: { history: { state: {} } }, resolve: (to: string) => ({ href: to }) }),
}));

vi.mock('@/services/api/admin/UserAdminService', () => ({
  useUserAdminService: () => mocks,
}));

vi.mock('@/services/api/admin/ApiKeyAdminService', () => ({
  useApiKeyAdminService: () => apiKeyMocks,
}));

const API_KEY: ApiKeyDto = {
  id: 7,
  name: 'Laptop',
  lastUsedDate: null,
  createdDate: new Date('2026-10-04T15:32:00Z'),
};

const buildUser = (overrides: Partial<UserDto> = {}): UserDto => ({
  id: 42,
  name: 'Casey',
  email: 'casey@example.com',
  enabled: true,
  invited: false,
  userRoleIds: [],
  lastAccess: new Date('2026-10-25T11:32:00Z'),
  createdDate: new Date('2026-09-14T09:00:00Z'),
  lastLoginSuccess: null,
  lastLoginFail: null,
  ...overrides,
});

const PASSWORD_LINK: PasswordLinkDto = {
  link: `https://example.com/set-password#${'ab'.repeat(32)}`,
  expiresAt: new Date('2026-11-02T12:00:00Z'),
  emailed: true,
};

const mountPage = async () => {
  const wrapper = mount(User, {
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        RoleSelect: {
          props: ['value'],
          emits: ['update:value'],
          template: `<button type="button" data-testid="role-stub" @click="$emit('update:value', [${UserRoleId.USER_ADMIN}])" />`,
        },
      },
    },
  });

  await flushPromises();

  return wrapper;
};

type PageWrapper = Awaited<ReturnType<typeof mountPage>>;

const buttonByText = (wrapper: PageWrapper, text: string) => {
  const button = wrapper.findAll('button').find(candidate => candidate.text() === text);

  if (button === undefined) {
    throw new Error(`No ${text} button`);
  }

  return button;
};

describe('User page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());

    useUserStore().setProfile({
      name: 'Admin',
      email: 'admin@example.com',
      userRoleIds: [UserRoleId.USER_ADMIN],
      mustChangePassword: false,
    });

    mocks.getUser.mockResolvedValue(buildUser());
    mocks.updateUser.mockResolvedValue(undefined);
    mocks.createPasswordLink.mockResolvedValue(PASSWORD_LINK);
    apiKeyMocks.getUserApiKeyList.mockResolvedValue([API_KEY]);
    apiKeyMocks.revokeApiKey.mockResolvedValue(undefined);
  });

  it('has no way to set their password directly', async () => {
    const wrapper = await mountPage();

    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
  });

  it('creates a reset link and shows it once', async () => {
    const wrapper = await mountPage();

    await buttonByText(wrapper, 'Create Reset Link').trigger('click');
    await flushPromises();

    expect(mocks.createPasswordLink).toHaveBeenCalledWith(42);
    expect(wrapper.find('[data-testid="password-link-value"]').text()).toBe(PASSWORD_LINK.link);
    expect(wrapper.text()).toContain('Emailed to casey@example.com');
  });

  it('offers to resend the invite to a user who has not chosen a password', async () => {
    mocks.getUser.mockResolvedValue(buildUser({ invited: true }));

    const wrapper = await mountPage();

    expect(wrapper.find('[data-testid="user-invited"]').exists()).toBe(true);

    await buttonByText(wrapper, 'Resend Invite').trigger('click');
    await flushPromises();

    expect(mocks.createPasswordLink).toHaveBeenCalledWith(42);
  });

  it('makes no link for a disabled account', async () => {
    mocks.getUser.mockResolvedValue(buildUser({ enabled: false }));

    const wrapper = await mountPage();

    expect(buttonByText(wrapper, 'Create Reset Link').attributes('disabled')).toBeDefined();
  });

  it('saves a profile change without asking', async () => {
    const wrapper = await mountPage();

    await wrapper.find('input[name="display-name"]').setValue('Casey Lee');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(useDialogStore().top).toBeNull();
    expect(mocks.updateUser).toHaveBeenCalledWith(
      { name: 'Casey Lee', email: 'casey@example.com', userRoleIds: [] },
      42,
      'user-profile'
    );
  });

  it('asks before changing their roles', async () => {
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="role-stub"]').trigger('click');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const dialogStore = useDialogStore();

    expect(dialogStore.top?.options.title).toBe('Change roles?');
    expect(mocks.updateUser).not.toHaveBeenCalled();

    dialogStore.close(dialogStore.top!, true);
    await flushPromises();

    expect(mocks.updateUser).toHaveBeenCalledWith(
      { name: 'Casey', email: 'casey@example.com', userRoleIds: [UserRoleId.USER_ADMIN] },
      42,
      'user-profile'
    );
  });

  it('leaves the roles alone when the change is cancelled', async () => {
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="role-stub"]').trigger('click');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const dialogStore = useDialogStore();
    dialogStore.close(dialogStore.top!, false);
    await flushPromises();

    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  describe('API keys', () => {
    const signInAsSystemAdmin = () => {
      useUserStore().setProfile({
        name: 'Admin',
        email: 'admin@example.com',
        userRoleIds: [UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN],
        mustChangePassword: false,
      });
    };

    it('hides their keys from a user admin who is not a system admin', async () => {
      const wrapper = await mountPage();

      expect(wrapper.find('[data-testid="user-api-keys"]').exists()).toBe(false);
      expect(apiKeyMocks.getUserApiKeyList).not.toHaveBeenCalled();
    });

    it('lists their keys for a system admin', async () => {
      signInAsSystemAdmin();

      const wrapper = await mountPage();

      expect(apiKeyMocks.getUserApiKeyList).toHaveBeenCalledWith(42);
      expect(wrapper.find('[data-testid="api-key-name"]').text()).toBe('Laptop');
    });

    it('revokes a key once the admin confirms', async () => {
      signInAsSystemAdmin();

      const wrapper = await mountPage();

      await buttonByText(wrapper, 'Revoke').trigger('click');
      await flushPromises();

      const dialogStore = useDialogStore();

      expect(dialogStore.top?.options.title).toBe('Revoke Laptop?');
      expect(apiKeyMocks.revokeApiKey).not.toHaveBeenCalled();

      await dialogStore.top?.options.action?.();
      await flushPromises();

      expect(apiKeyMocks.revokeApiKey).toHaveBeenCalledWith(7);
      expect(apiKeyMocks.getUserApiKeyList).toHaveBeenCalledTimes(2);
    });
  });
});
