import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { PasswordLinkState } from '@libs/dto';

import { ValidationError } from '@/types/error';

import { useErrorStore } from '@/stores/error';

import SetPassword from './SetPassword.vue';

const mocks = vi.hoisted(() => ({
  checkPasswordLink: vi.fn(),
  setPassword: vi.fn(),
}));

vi.mock('@/services/api/PasswordLinkService', () => ({
  usePasswordLinkService: () => mocks,
}));

const TOKEN = 'ab'.repeat(32);
const NEW_PASSWORD = 'N3w$Password';

const validLink = (invite: boolean) => ({
  state: PasswordLinkState.VALID,
  passwordLink: { name: 'Casey', email: 'casey@example.com', invite, expiresAt: new Date('2026-11-08T12:00:00Z') },
});

const mountPage = async (hash = `#${TOKEN}`) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)*', component: { template: '<div />' } }],
  });
  await router.push(`/set-password${hash}`);

  const wrapper = mount(SetPassword, { global: { plugins: [router] } });
  await flushPromises();

  return wrapper;
};

const fillPasswords = async (wrapper: Awaited<ReturnType<typeof mountPage>>, confirm = NEW_PASSWORD) => {
  await wrapper.find('input[name="new-password"]').setValue(NEW_PASSWORD);
  await wrapper.find('input[name="confirm-password"]').setValue(confirm);
  await wrapper.find('form').trigger('submit');
  await flushPromises();
};

describe('Set password page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());

    mocks.setPassword.mockResolvedValue(undefined);
  });

  it('checks the token from the fragment and greets an invited user', async () => {
    mocks.checkPasswordLink.mockResolvedValue(validLink(true));

    const wrapper = await mountPage();

    expect(mocks.checkPasswordLink).toHaveBeenCalledWith(TOKEN);
    expect(wrapper.text()).toContain('Choose your password');
    expect(wrapper.find<HTMLInputElement>('input[name="email"]').element.value).toBe('casey@example.com');
  });

  it('words a reset link as a reset', async () => {
    mocks.checkPasswordLink.mockResolvedValue(validLink(false));

    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('Reset your password');
  });

  it('sets the password with the token under its form', async () => {
    mocks.checkPasswordLink.mockResolvedValue(validLink(true));
    const wrapper = await mountPage();

    await fillPasswords(wrapper);

    expect(mocks.setPassword).toHaveBeenCalledWith(TOKEN, NEW_PASSWORD, 'set-password');
  });

  it('reports mismatched passwords without calling the api', async () => {
    mocks.checkPasswordLink.mockResolvedValue(validLink(true));
    const wrapper = await mountPage();

    await fillPasswords(wrapper, 'Something$Else1');

    expect(mocks.setPassword).not.toHaveBeenCalled();
    expect(useErrorStore().getFieldError('set-password', 'confirmPassword')).toBeDefined();
  });

  it('keeps the form when the password itself is refused', async () => {
    mocks.checkPasswordLink.mockResolvedValue(validLink(true));
    mocks.setPassword.mockImplementation(() => {
      useErrorStore().setValidationError(
        new ValidationError('set-password', { password: { message: 'Use at least 6 characters.' } })
      );
      return Promise.reject(new Error('Refused'));
    });
    const wrapper = await mountPage();

    await fillPasswords(wrapper);

    expect(mocks.checkPasswordLink).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="set-password-form"]').exists()).toBe(true);
  });

  it('checks the link again when the set is refused for the link', async () => {
    mocks.checkPasswordLink.mockResolvedValueOnce(validLink(true)).mockResolvedValueOnce({
      state: PasswordLinkState.INVALID,
      passwordLink: null,
    });
    mocks.setPassword.mockRejectedValue(new Error('Refused'));
    const wrapper = await mountPage();

    await fillPasswords(wrapper);

    expect(mocks.checkPasswordLink).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="set-password-problem"]').text()).toContain("This link isn't valid");
  });

  it.each([
    [PasswordLinkState.EXPIRED, 'This link has expired'],
    [PasswordLinkState.USED, 'This link has already been used'],
  ])('explains a %s link', async (state, title) => {
    mocks.checkPasswordLink.mockResolvedValue({ state, passwordLink: null });

    const wrapper = await mountPage();

    expect(wrapper.find('[data-testid="set-password-problem"]').text()).toContain(title);
  });

  it('calls a malformed token invalid without asking the api', async () => {
    const wrapper = await mountPage('#not-a-token');

    expect(mocks.checkPasswordLink).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="set-password-problem"]').text()).toContain("This link isn't valid");
  });
});
