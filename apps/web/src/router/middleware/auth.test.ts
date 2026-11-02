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

const signInAs = (userRoleIds: UserRoleId[]) => {
  const userStore = useUserStore();
  userStore.setToken('token');
  userStore.setProfile({ name: 'Ann Lee', email: 'ann@example.com', userRoleIds, mustChangePassword: false });
};

const runAuthMiddleware = (to: RouteLocationNormalized) => authMiddleware.call(undefined, to, to, () => undefined);

describe('authMiddleware', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    routerMock.replace.mockClear();
  });

  it('sends a signed-out visitor to sign in, carrying the page they asked for', async () => {
    expect(await runAuthMiddleware(signedInRoute('/users?page=2'))).toEqual({
      path: '/sign-in',
      query: { redirect: '/users?page=2' },
    });
  });

  it('sends a signed-out visitor to a plain sign in from the overview', async () => {
    expect(await runAuthMiddleware(signedInRoute('/overview'))).toEqual({ path: '/sign-in', query: {} });
  });

  it('sends a signed-in visitor on sign in to the page it carries', async () => {
    useUserStore().setToken('token');

    expect(await runAuthMiddleware(signInRoute('/edit-profile'))).toBe('/edit-profile');
  });

  it('sends a signed-in visitor on sign in home when the page it carries leaves this origin', async () => {
    signInAs([UserRoleId.SYSTEM_ADMIN]);

    expect(await runAuthMiddleware(signInRoute('//evil.example/admin'))).toBe('/overview');
  });

  it('sends a signed-in visitor on sign in home when it carries no page', async () => {
    signInAs([UserRoleId.SYSTEM_ADMIN]);

    expect(await runAuthMiddleware(signInRoute())).toBe('/overview');
  });

  it('sends a user admin home to the users page, since the overview needs the system admin role', async () => {
    signInAs([UserRoleId.USER_ADMIN]);

    expect(await runAuthMiddleware(signInRoute())).toBe('/users');
  });

  it('sends a user without a role home to their profile', async () => {
    signInAs([]);

    expect(await runAuthMiddleware(signInRoute())).toBe('/edit-profile');
  });

  it('sends the user to the page sign in carries once they sign in there', async () => {
    expect(await runAuthMiddleware(signInRoute('/users'))).toBeUndefined();

    useUserStore().setToken('token');
    await nextTick();

    expect(routerMock.replace).toHaveBeenCalledWith('/users');
  });

  it('waits for the profile after sign in before sending the user home, as home depends on the roles', async () => {
    expect(await runAuthMiddleware(signInRoute())).toBeUndefined();

    const userStore = useUserStore();
    userStore.setToken('token');
    await nextTick();

    expect(routerMock.replace).not.toHaveBeenCalled();

    userStore.setProfile({
      name: 'Ann Lee',
      email: 'ann@example.com',
      userRoleIds: [UserRoleId.SYSTEM_ADMIN],
      mustChangePassword: false,
    });
    await nextTick();

    expect(routerMock.replace).toHaveBeenCalledWith('/overview');
  });

  it('sends a user who signs out on a page to a plain sign in', async () => {
    useUserStore().setToken('token');

    expect(await runAuthMiddleware(signedInRoute('/users'))).toBeUndefined();

    useUserStore().clearAuth();
    await nextTick();

    expect(routerMock.replace).toHaveBeenCalledWith({ path: '/sign-in', query: {} });
  });

  it('holds a user who must finish first-time setup on the setup page', async () => {
    const userStore = useUserStore();
    userStore.setToken('token');
    userStore.setProfile({ name: 'Admin', email: 'admin@example.com', userRoleIds: [], mustChangePassword: true });

    expect(await runAuthMiddleware(signedInRoute('/users'))).toBe('/setup');
    expect(await runAuthMiddleware(signedInRoute('/setup'))).toBeUndefined();
  });

  it('sends a user who has finished setup from the setup page home', async () => {
    signInAs([UserRoleId.SYSTEM_ADMIN]);

    expect(await runAuthMiddleware(signedInRoute('/setup'))).toBe('/overview');
  });

  it('sends a user whose session ends on a page to sign in, carrying that page', async () => {
    useUserStore().setToken('token');

    expect(await runAuthMiddleware(signedInRoute('/users?page=2'))).toBeUndefined();

    useUserStore().endSession();
    await nextTick();

    expect(routerMock.replace).toHaveBeenCalledWith({
      path: '/sign-in',
      query: { redirect: '/users?page=2' },
    });
  });

  it('shows not found at the requested URL to a signed-in user without the role', async () => {
    const userStore = useUserStore();
    userStore.setToken('token');
    userStore.setProfile({ name: 'User', email: 'user@example.com', userRoleIds: [], mustChangePassword: false });

    expect(await runAuthMiddleware(adminRoute('/batch-jobs'))).toEqual({
      name: 'not-found',
      params: { pathMatch: ['batch-jobs'] },
      query: { page: '2' },
      hash: '#top',
    });
  });

  it('sends a user without the role for the overview home to the first page their roles open', async () => {
    signInAs([UserRoleId.USER_ADMIN]);

    const home = { ...adminRoute('/overview'), path: '/overview' } as RouteLocationNormalized;

    expect(await runAuthMiddleware(home)).toBe('/users');
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

    expect(await runAuthMiddleware(adminRoute('/batch-jobs'))).toBeUndefined();
  });
});
