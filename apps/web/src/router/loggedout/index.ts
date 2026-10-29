/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { RouteRecordRaw } from 'vue-router';

import Index from '@/pages/loggedout/Index.vue';
import Register from '@/pages/loggedout/Register.vue';
import SignIn from '@/pages/loggedout/SignIn.vue';

export const loggedOutRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    component: Index,
  },
  {
    path: '/register',
    component: Register,
  },
  {
    path: '/sign-in',
    component: SignIn,
  },
];
