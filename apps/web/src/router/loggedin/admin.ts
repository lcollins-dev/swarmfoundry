/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { RouteRecordRaw } from 'vue-router';

import { UserRoleId } from '@libs/dto';

import AdminDashboard from '@/pages/loggedin/admin/Dashboard.vue';
import AdminSysConfig from '@/pages/loggedin/admin/SysConfig.vue';
import AdminBatchJobsBatchJob from '@/pages/loggedin/admin/batch-jobs/BatchJob.vue';
import AdminBatchJobs from '@/pages/loggedin/admin/batch-jobs/Index.vue';
import AdminUsersCreate from '@/pages/loggedin/admin/users/Create.vue';
import AdminUsers from '@/pages/loggedin/admin/users/Index.vue';
import AdminUsersUser from '@/pages/loggedin/admin/users/User.vue';

export const adminRoutes: RouteRecordRaw[] = [
  {
    path: 'dashboard',
    component: AdminDashboard,
    meta: {
      requiresRoleId: [UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN],
    },
  },
  {
    path: 'sys-config',
    component: AdminSysConfig,
    meta: {
      requiresRoleId: UserRoleId.SYSTEM_ADMIN,
    },
  },
  {
    path: 'users',
    meta: {
      requiresRoleId: UserRoleId.USER_ADMIN,
    },
    children: [
      {
        path: '',
        component: AdminUsers,
      },
      {
        path: 'create',
        component: AdminUsersCreate,
      },
      {
        path: ':userId(\\d+)',
        component: AdminUsersUser,
      },
    ],
  },
  {
    path: 'batch-jobs',
    meta: {
      requiresRoleId: UserRoleId.SYSTEM_ADMIN,
    },
    children: [
      {
        path: '',
        component: AdminBatchJobs,
      },
      {
        path: ':batchJobId(\\d+)',
        component: AdminBatchJobsBatchJob,
      },
    ],
  },
];
