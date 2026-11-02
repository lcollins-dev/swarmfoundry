<template>
  <live-updates-tag />

  <notifications-menu />

  <theme-toggle />

  <user-menu
    v-if="userStore.profile !== null"
    :name="userStore.profile.name"
    :email="userStore.profile.email"
    :items="userMenuItems"
    @select="onUserMenuSelect"
  />
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import IconLogout from '~icons/material-symbols/logout-rounded';
import IconManageAccounts from '~icons/material-symbols/manage-accounts-outline-rounded';

import { useLogService } from '@/services/LogService';
import { useUserService } from '@/services/api/UserService';
import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import NotificationsMenu from '@/components/notifications/NotificationsMenu.vue';
import { IMenuItem } from '@/components/ui';

import LiveUpdatesTag from './LiveUpdatesTag.vue';
import ThemeToggle from './ThemeToggle.vue';
import UserMenu from './UserMenu.vue';

const logService = useLogService();
const logger = logService.createLogger('components/shell/SignedInHeaderActions');

const router = useRouter();

const notificationStore = useNotificationStore();
const userStore = useUserStore();
const userService = useUserService();

const userMenuItems: IMenuItem[] = [
  { key: 'profile', label: 'Profile & security', icon: IconManageAccounts },
  { key: 'sign-out', label: 'Sign out', icon: IconLogout },
];

const signOut = () => {
  userService
    .logout()
    .then(() => {
      notificationStore.addToast('Signed out', 'Sign in again to pick up where you left off.');
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'signOut(): Sign out failed');
    });
};

const onUserMenuSelect = (key: string) => {
  if (key === 'sign-out') {
    signOut();
    return;
  }

  router.push('/edit-profile').catch((error: unknown) => {
    logger.error({ error }, 'onUserMenuSelect(): Failed to navigate');
  });
};
</script>
