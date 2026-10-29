/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { RouteRecordRaw } from 'vue-router';

import { Layout } from '@/components/layouts';

import Dashboard from '@/pages/loggedin/Dashboard.vue';
import EditProfile from '@/pages/loggedin/EditProfile.vue';
import FirstTimeSetup from '@/pages/loggedin/FirstTimeSetup.vue';

import { adminRoutes } from './admin';

export const loggedInRoutes: RouteRecordRaw[] = [
  {
    path: '/dashboard',
    component: Dashboard,
  },
  {
    path: '/edit-profile',
    component: EditProfile,
  },
  {
    path: '/setup',
    component: FirstTimeSetup,
    meta: {
      layout: Layout.LOGGED_OUT,
    },
  },
  {
    path: '/admin',
    meta: {
      layout: Layout.ADMIN,
    },
    children: adminRoutes,
  },
];
