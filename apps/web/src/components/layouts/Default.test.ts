import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { UserRoleId } from '@libs/dto';

import { useThemeStore } from '@/stores/theme';
import { useUserStore } from '@/stores/user';

import Default from './Default.vue';

const WIDE_WIDTH = window.innerWidth;

const signIn = (userRoleIds: UserRoleId[]) => {
  const userStore = useUserStore();

  userStore.setToken('token');
  userStore.setProfile({ name: 'Ann Lee', email: 'ann@example.com', userRoleIds, mustChangePassword: false });
};

const mountAt = async (path: string) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)*', component: { template: '<div />' } }],
  });
  await router.push(path);

  const wrapper = mount(Default, {
    global: { plugins: [router], stubs: { NotificationsMenu: true } },
    attachTo: document.body,
  });

  return { wrapper, router };
};

type Wrapper = Awaited<ReturnType<typeof mountAt>>['wrapper'];

const navLinks = (wrapper: Wrapper) => wrapper.findAll('nav a').map(link => link.text());

const openUserMenu = async (wrapper: Wrapper) => {
  await wrapper.get('[data-testid="user-menu"]').trigger('click');

  return wrapper.findAll('[role="menuitem"]').map(item => item.text());
};

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  window.innerWidth = WIDE_WIDTH;
  document.body.innerHTML = '';
});

describe('Default layout', () => {
  it('gives a signed-in user the account sections and their menu', async () => {
    signIn([]);

    const { wrapper } = await mountAt('/dashboard');

    expect(navLinks(wrapper)).toEqual(['Dashboard', 'Profile & security']);
    expect(wrapper.get('[data-testid="user-menu"]').text()).toContain('Ann Lee');
  });

  it('offers an admin the way into the admin area from their menu', async () => {
    signIn([UserRoleId.USER_ADMIN]);

    const { wrapper } = await mountAt('/dashboard');

    expect(await openUserMenu(wrapper)).toEqual(['Profile & security', 'Admin', 'Sign out']);
  });

  it('leaves the admin entry out of the menu for a user without an admin role', async () => {
    signIn([]);

    const { wrapper } = await mountAt('/dashboard');

    expect(await openUserMenu(wrapper)).toEqual(['Profile & security', 'Sign out']);
  });

  it('takes an admin to the admin dashboard from their menu', async () => {
    signIn([UserRoleId.SYSTEM_ADMIN]);

    const { wrapper, router } = await mountAt('/dashboard');

    await openUserMenu(wrapper);
    await wrapper.get('[data-testid="menu-item-admin"]').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/admin/dashboard');
  });

  it('hides the sidebar behind the menu button on a narrow screen', async () => {
    window.innerWidth = 800;
    signIn([]);

    const { wrapper } = await mountAt('/dashboard');

    expect(wrapper.find('nav').exists()).toBe(false);

    await wrapper.get('button[aria-label="Menu"]').trigger('click');

    expect(navLinks(wrapper)).toEqual(['Dashboard', 'Profile & security']);
  });

  it('flips the theme from the header', async () => {
    signIn([]);

    const { wrapper } = await mountAt('/dashboard');

    await wrapper.get('button[aria-label="Toggle theme"]').trigger('click');

    expect(useThemeStore().isDarkMode).toBe(false);
  });
});
