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
  it('gives a system and user admin every section in sidebar order', async () => {
    signIn([UserRoleId.SYSTEM_ADMIN, UserRoleId.USER_ADMIN]);

    const { wrapper } = await mountAt('/overview');

    expect(navLinks(wrapper)).toEqual([
      'Overview',
      'Triggers',
      'Queue',
      'Tasks',
      'API keys',
      'Users',
      'Config',
      'Batch jobs',
    ]);
    expect(wrapper.get('[data-testid="user-menu"]').text()).toContain('Ann Lee');
  });

  it('shows a user admin only the access section', async () => {
    signIn([UserRoleId.USER_ADMIN]);

    const { wrapper } = await mountAt('/users');

    expect(navLinks(wrapper)).toEqual(['Users']);
  });

  it('shows a system admin their API keys but not the users', async () => {
    signIn([UserRoleId.SYSTEM_ADMIN]);

    const { wrapper } = await mountAt('/overview');

    expect(navLinks(wrapper)).toContain('API keys');
    expect(navLinks(wrapper)).not.toContain('Users');
  });

  it('leaves out the sidebar for a user without a role', async () => {
    signIn([]);

    const { wrapper } = await mountAt('/edit-profile');

    expect(wrapper.find('nav').exists()).toBe(false);
  });

  it('offers profile and sign out from the user menu', async () => {
    signIn([UserRoleId.SYSTEM_ADMIN]);

    const { wrapper } = await mountAt('/overview');

    expect(await openUserMenu(wrapper)).toEqual(['Profile & security', 'Sign out']);
  });

  it('takes the user to their profile from the menu', async () => {
    signIn([UserRoleId.SYSTEM_ADMIN]);

    const { wrapper, router } = await mountAt('/overview');

    await openUserMenu(wrapper);
    await wrapper.get('[data-testid="menu-item-profile"]').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/edit-profile');
  });

  it('hides the sidebar behind the menu button on a narrow screen', async () => {
    window.innerWidth = 800;
    signIn([UserRoleId.USER_ADMIN]);

    const { wrapper } = await mountAt('/users');

    expect(wrapper.find('nav').exists()).toBe(false);

    await wrapper.get('button[aria-label="Menu"]').trigger('click');

    expect(navLinks(wrapper)).toEqual(['Users']);
  });

  it('flips the theme from the header', async () => {
    signIn([]);

    const { wrapper } = await mountAt('/edit-profile');

    await wrapper.get('button[aria-label="Toggle theme"]').trigger('click');

    expect(useThemeStore().isDarkMode).toBe(false);
  });
});
