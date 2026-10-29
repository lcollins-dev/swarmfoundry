/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { RouteRecordRaw, createRouter, createWebHistory } from 'vue-router';

import { UserRoleId } from '@libs/dto';

import { Layout } from '@/components/layouts';

import Error from '@/pages/Error.vue';
import PageNotFound from '@/pages/PageNotFound.vue';

import { loggedInRoutes } from './loggedin';
import { loggedOutRoutes } from './loggedout';
import { NOT_FOUND_ROUTE, authMiddleware } from './middleware/auth';
import { clearNotificationsErrorMiddleware } from './middleware/clear-notifications-errors';
import { logMiddleware } from './middleware/log';

declare module 'vue-router' {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  interface RouteMeta {
    layout?: Layout;
    requiresAuthState?: 'loggedin' | 'loggedout';
    requiresRoleId?: UserRoleId[] | UserRoleId;
  }
}

const routes: Readonly<RouteRecordRaw[]> = [
  // Logged out
  ...loggedOutRoutes.map(route => {
    route.meta = route.meta ?? {};
    route.meta.requiresAuthState = 'loggedout';
    route.meta.layout = route.meta.layout ?? Layout.LOGGED_OUT;

    return route;
  }),
  ...loggedInRoutes.map(route => {
    route.meta = route.meta ?? {};
    route.meta.requiresAuthState = 'loggedin';
    route.meta.layout = route.meta.layout ?? Layout.DEFAULT;

    return route;
  }),
  // Base
  {
    path: '/error',
    component: Error,
    meta: {
      layout: Layout.MINIMAL,
    },
  },
  {
    path: '/:pathMatch(.*)*',
    name: NOT_FOUND_ROUTE,
    component: PageNotFound,
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(logMiddleware);
router.beforeEach(clearNotificationsErrorMiddleware);
router.beforeEach(authMiddleware);

export { router };
