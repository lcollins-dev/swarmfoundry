/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { RouteRecordRaw } from 'vue-router';

import { UserRoleId } from '@libs/dto';

import { Layout } from '@/components/layouts';

import ApiKeys from '@/pages/loggedin/ApiKeys.vue';
import Config from '@/pages/loggedin/Config.vue';
import EditProfile from '@/pages/loggedin/EditProfile.vue';
import FirstTimeSetup from '@/pages/loggedin/FirstTimeSetup.vue';
import Overview from '@/pages/loggedin/Overview.vue';
import Queue from '@/pages/loggedin/Queue.vue';
import BatchJobsBatchJob from '@/pages/loggedin/batch-jobs/BatchJob.vue';
import BatchJobs from '@/pages/loggedin/batch-jobs/Index.vue';
import RunsRun from '@/pages/loggedin/runs/Run.vue';
import Tasks from '@/pages/loggedin/tasks/Index.vue';
import TasksTask from '@/pages/loggedin/tasks/Task.vue';
import Triggers from '@/pages/loggedin/triggers/Index.vue';
import TriggersTrigger from '@/pages/loggedin/triggers/Trigger.vue';
import Users from '@/pages/loggedin/users/Index.vue';
import UsersInvite from '@/pages/loggedin/users/Invite.vue';
import UsersUser from '@/pages/loggedin/users/User.vue';

export const loggedInRoutes: RouteRecordRaw[] = [
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
    path: '/overview',
    component: Overview,
    meta: {
      requiresRoleId: UserRoleId.SYSTEM_ADMIN,
    },
  },
  {
    path: '/triggers',
    meta: {
      requiresRoleId: UserRoleId.SYSTEM_ADMIN,
    },
    children: [
      {
        path: '',
        component: Triggers,
      },
      {
        path: ':name',
        component: TriggersTrigger,
      },
    ],
  },
  {
    path: '/queue',
    component: Queue,
    meta: {
      requiresRoleId: UserRoleId.SYSTEM_ADMIN,
    },
  },
  {
    path: '/tasks',
    meta: {
      requiresRoleId: UserRoleId.SYSTEM_ADMIN,
    },
    children: [
      {
        path: '',
        component: Tasks,
      },
      {
        path: ':taskId(\\d+)',
        component: TasksTask,
      },
    ],
  },
  {
    path: '/runs/:runId(\\d+)',
    component: RunsRun,
    meta: {
      requiresRoleId: UserRoleId.SYSTEM_ADMIN,
    },
  },
  {
    path: '/api-keys',
    component: ApiKeys,
    meta: {
      requiresRoleId: UserRoleId.SYSTEM_ADMIN,
    },
  },
  {
    path: '/users',
    meta: {
      requiresRoleId: UserRoleId.USER_ADMIN,
    },
    children: [
      {
        path: '',
        component: Users,
      },
      {
        path: 'invite',
        component: UsersInvite,
      },
      {
        path: ':userId(\\d+)',
        component: UsersUser,
      },
    ],
  },
  {
    path: '/config',
    component: Config,
    meta: {
      requiresRoleId: UserRoleId.SYSTEM_ADMIN,
    },
  },
  {
    path: '/batch-jobs',
    meta: {
      requiresRoleId: UserRoleId.SYSTEM_ADMIN,
    },
    children: [
      {
        path: '',
        component: BatchJobs,
      },
      {
        path: ':batchJobId(\\d+)',
        component: BatchJobsBatchJob,
      },
    ],
  },
];
