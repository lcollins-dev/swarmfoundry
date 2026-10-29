import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { useErrorStore } from '@/stores/error';
import { useUserStore } from '@/stores/user';

import FirstTimeSetup from './FirstTimeSetup.vue';

const updateProfile = vi.fn(() => Promise.resolve());

vi.mock('@/services/api/UserService', () => ({
  useUserService: () => ({ updateProfile, logout: vi.fn(() => Promise.resolve()) }),
}));

const mountPage = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/setup');

  const wrapper = mount(FirstTimeSetup, { global: { plugins: [router] } });
  await flushPromises();

  return { router, wrapper };
};

describe('First-time setup page', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    updateProfile.mockClear();

    useUserStore().setProfile({
      name: 'Admin',
      email: 'admin@example.com',
      userRoleIds: [],
      mustChangePassword: true,
    });
  });

  it('starts from the default admin profile', async () => {
    const { wrapper } = await mountPage();

    expect(wrapper.find<HTMLInputElement>('input[name="name"]').element.value).toBe('Admin');
    expect(wrapper.find<HTMLInputElement>('input[name="email"]').element.value).toBe('admin@example.com');
  });

  it('reports mismatched passwords without calling the api', async () => {
    const { wrapper } = await mountPage();

    await wrapper.find('input[name="new-password"]').setValue('S3tup$Done');
    await wrapper.find('input[name="confirm-password"]').setValue('S3tup$Don');
    await wrapper.find('form').trigger('submit');

    expect(updateProfile).not.toHaveBeenCalled();
    expect(useErrorStore().getFieldError('setup', 'confirmPassword')).toBeDefined();
  });

  it('saves the new email and password together, then opens the dashboard', async () => {
    const { router, wrapper } = await mountPage();

    await wrapper.find('input[name="email"]').setValue(' me@example.com ');
    await wrapper.find('input[name="new-password"]').setValue('S3tup$Done');
    await wrapper.find('input[name="confirm-password"]').setValue('S3tup$Done');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(updateProfile).toHaveBeenCalledWith(
      { name: 'Admin', email: 'me@example.com', password: 'S3tup$Done' },
      'setup'
    );
    expect(router.currentRoute.value.path).toBe('/dashboard');
  });
});
