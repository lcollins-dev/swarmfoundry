<template>
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
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import IconAdminPanelSettings from '~icons/material-symbols/admin-panel-settings-outline-rounded';
import IconLogout from '~icons/material-symbols/logout-rounded';
import IconManageAccounts from '~icons/material-symbols/manage-accounts-outline-rounded';

import { UserRoleId } from '@libs/dto';

import { useLogService } from '@/services/LogService';
import { useUserService } from '@/services/api/UserService';
import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import NotificationsMenu from '@/components/notifications/NotificationsMenu.vue';
import { IMenuItem } from '@/components/ui';

import ThemeToggle from './ThemeToggle.vue';
import UserMenu from './UserMenu.vue';

const props = defineProps({
  hideAdminItem: {
    type: Boolean,
    default: false,
  },
});

const logService = useLogService();
const logger = logService.createLogger('components/shell/SignedInHeaderActions');

const router = useRouter();

const notificationStore = useNotificationStore();
const userStore = useUserStore();
const userService = useUserService();

const userMenuItems = computed<IMenuItem[]>(() => [
  { key: 'profile', label: 'Profile & security', icon: IconManageAccounts },
  ...(userStore.hasRole(UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN) && !props.hideAdminItem
    ? [{ key: 'admin', label: 'Admin', icon: IconAdminPanelSettings }]
    : []),
  { key: 'sign-out', label: 'Sign out', icon: IconLogout },
]);

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

  router.push(key === 'admin' ? '/admin/dashboard' : '/edit-profile').catch((error: unknown) => {
    logger.error({ error }, 'onUserMenuSelect(): Failed to navigate');
  });
};
</script>
