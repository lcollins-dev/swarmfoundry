import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { RouteLocationNormalized } from 'vue-router';

import { UserRoleId } from '@libs/dto';

import { useUserStore } from '@/stores/user';

import { authMiddleware } from './auth';

const routerMock = vi.hoisted(() => ({ replace: vi.fn(() => Promise.resolve()) }));

vi.mock('vue-router', async importOriginal => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => routerMock,
}));

vi.mock('@/services/api/UserService', () => ({
  useUserService: () => ({ getProfile: vi.fn(() => Promise.resolve()) }),
}));

const signedInRoute = (fullPath: string): RouteLocationNormalized =>
  ({ path: fullPath.split('?')[0], fullPath, query: {}, hash: '', meta: { requiresAuthState: 'loggedin' } }) as never;

const adminRoute = (path: string): RouteLocationNormalized =>
  ({
    path,
    fullPath: `${path}?page=2#top`,
    query: { page: '2' },
    hash: '#top',
    meta: { requiresAuthState: 'loggedin', requiresRoleId: UserRoleId.SYSTEM_ADMIN },
  }) as never;

const signInRoute = (redirect?: string): RouteLocationNormalized =>
  ({
    path: '/sign-in',
    fullPath: '/sign-in',
    query: redirect === undefined ? {} : { redirect },
    hash: '',
    meta: { requiresAuthState: 'loggedout' },
  }) as never;

const runAuthMiddleware = (to: RouteLocationNormalized) => authMiddleware.call(undefined, to, to, () => undefined);

describe('authMiddleware', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    routerMock.replace.mockClear();
  });

  it('sends a signed-out visitor to sign in, carrying the page they asked for', async () => {
    expect(await runAuthMiddleware(signedInRoute('/admin/users?page=2'))).toEqual({
      path: '/sign-in',
      query: { redirect: '/admin/users?page=2' },
    });
  });

  it('sends a signed-out visitor to a plain sign in from the dashboard', async () => {
    expect(await runAuthMiddleware(signedInRoute('/dashboard'))).toEqual({ path: '/sign-in', query: {} });
  });

  it('sends a signed-in visitor on sign in to the page it carries', async () => {
    useUserStore().setToken('token');

    expect(await runAuthMiddleware(signInRoute('/edit-profile'))).toBe('/edit-profile');
  });

  it('sends a signed-in visitor on sign in to the dashboard when the page it carries leaves this origin', async () => {
    useUserStore().setToken('token');

    expect(await runAuthMiddleware(signInRoute('//evil.example/admin'))).toBe('/dashboard');
  });

  it('sends a signed-in visitor on sign in to the dashboard when it carries no page', async () => {
    useUserStore().setToken('token');

    expect(await runAuthMiddleware(signInRoute())).toBe('/dashboard');
  });

  it('sends the user to the page sign in carries once they sign in there', async () => {
    expect(await runAuthMiddleware(signInRoute('/admin/users'))).toBeUndefined();

    useUserStore().setToken('token');
    await nextTick();

    expect(routerMock.replace).toHaveBeenCalledWith('/admin/users');
  });

  it('sends a user who signs out on a page to a plain sign in', async () => {
    useUserStore().setToken('token');

    expect(await runAuthMiddleware(signedInRoute('/admin/users'))).toBeUndefined();

    useUserStore().clearAuth();
    await nextTick();

    expect(routerMock.replace).toHaveBeenCalledWith({ path: '/sign-in', query: {} });
  });

  it('holds a user who must finish first-time setup on the setup page', async () => {
    const userStore = useUserStore();
    userStore.setToken('token');
    userStore.setProfile({ name: 'Admin', email: 'admin@example.com', userRoleIds: [], mustChangePassword: true });

    expect(await runAuthMiddleware(signedInRoute('/admin/users'))).toBe('/setup');
    expect(await runAuthMiddleware(signedInRoute('/setup'))).toBeUndefined();
  });

  it('sends a user who has finished setup from the setup page to the dashboard', async () => {
    const userStore = useUserStore();
    userStore.setToken('token');
    userStore.setProfile({ name: 'Admin', email: 'me@example.com', userRoleIds: [], mustChangePassword: false });

    expect(await runAuthMiddleware(signedInRoute('/setup'))).toBe('/dashboard');
  });

  it('sends a user whose session ends on a page to sign in, carrying that page', async () => {
    useUserStore().setToken('token');

    expect(await runAuthMiddleware(signedInRoute('/admin/users?page=2'))).toBeUndefined();

    useUserStore().endSession();
    await nextTick();

    expect(routerMock.replace).toHaveBeenCalledWith({
      path: '/sign-in',
      query: { redirect: '/admin/users?page=2' },
    });
  });

  it('shows not found at the requested URL to a signed-in user without the role', async () => {
    const userStore = useUserStore();
    userStore.setToken('token');
    userStore.setProfile({ name: 'User', email: 'user@example.com', userRoleIds: [], mustChangePassword: false });

    expect(await runAuthMiddleware(adminRoute('/admin/batch-jobs'))).toEqual({
      name: 'not-found',
      params: { pathMatch: ['admin', 'batch-jobs'] },
      query: { page: '2' },
      hash: '#top',
    });
  });

  it('lets a signed-in user with the role through', async () => {
    const userStore = useUserStore();
    userStore.setToken('token');
    userStore.setProfile({
      name: 'Admin',
      email: 'admin@example.com',
      userRoleIds: [UserRoleId.SYSTEM_ADMIN],
      mustChangePassword: false,
    });

    expect(await runAuthMiddleware(adminRoute('/admin/batch-jobs'))).toBeUndefined();
  });
});
