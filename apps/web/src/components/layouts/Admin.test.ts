import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { UserRoleId } from '@libs/dto';

import { useUserStore } from '@/stores/user';

import Admin from './Admin.vue';

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

  return mount(Admin, {
    global: { plugins: [router], stubs: { NotificationsMenu: true } },
    attachTo: document.body,
  });
};

type Wrapper = Awaited<ReturnType<typeof mountAt>>;

const navLinks = (wrapper: Wrapper) => wrapper.findAll('nav a').map(link => link.text());

const openUserMenu = async (wrapper: Wrapper) => {
  await wrapper.get('[data-testid="user-menu"]').trigger('click');

  return wrapper.findAll('[role="menuitem"]').map(item => item.text());
};

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Admin layout', () => {
  it('shows a user admin the people section and the way out', async () => {
    signIn([UserRoleId.USER_ADMIN]);

    const wrapper = await mountAt('/admin/users');

    expect(navLinks(wrapper)).toEqual(['Dashboard', 'Users', 'Exit admin']);
  });

  it('shows a system admin the server section and the way out', async () => {
    signIn([UserRoleId.SYSTEM_ADMIN]);

    const wrapper = await mountAt('/admin/dashboard');

    expect(navLinks(wrapper)).toEqual(['Dashboard', 'System config', 'Batch jobs', 'Exit admin']);
  });

  it('leaves the admin entry out of the menu inside the admin area', async () => {
    signIn([UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN]);

    const wrapper = await mountAt('/admin/dashboard');

    expect(await openUserMenu(wrapper)).toEqual(['Profile & security', 'Sign out']);
  });
});
