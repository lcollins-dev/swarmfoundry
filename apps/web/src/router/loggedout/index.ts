/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { RouteRecordRaw } from 'vue-router';

import SetPassword from '@/pages/loggedout/SetPassword.vue';
import SignIn from '@/pages/loggedout/SignIn.vue';

export const loggedOutRoutes: RouteRecordRaw[] = [
  {
    path: '/sign-in',
    component: SignIn,
  },
  {
    path: '/set-password',
    component: SetPassword,
  },
];
