<template>
  <app-shell :sections="sections">
    <template #actions>
      <signed-in-header-actions hide-admin-item />
    </template>

    <template #sidebar-footer>
      <ui-nav-item to="/dashboard" label="Exit admin" :icon="IconExitToApp" />
    </template>

    <slot />
  </app-shell>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import IconExitToApp from '~icons/material-symbols/exit-to-app-rounded';
import IconGroup from '~icons/material-symbols/group-outline-rounded';
import IconSchedule from '~icons/material-symbols/schedule-outline-rounded';
import IconSettings from '~icons/material-symbols/settings-outline-rounded';
import IconSpaceDashboard from '~icons/material-symbols/space-dashboard-outline-rounded';

import { UserRoleId } from '@libs/dto';

import { useUserStore } from '@/stores/user';

import AppShell from '@/components/shell/AppShell.vue';
import { INavSection } from '@/components/shell/AppSidebar.vue';
import SignedInHeaderActions from '@/components/shell/SignedInHeaderActions.vue';
import { UiNavItem } from '@/components/ui';

const userStore = useUserStore();

const sections = computed<INavSection[]>(() => [
  { title: 'General', items: [{ label: 'Dashboard', icon: IconSpaceDashboard, to: '/admin/dashboard' }] },
  ...(userStore.hasRole(UserRoleId.USER_ADMIN)
    ? [{ title: 'People', items: [{ label: 'Users', icon: IconGroup, to: '/admin/users' }] }]
    : []),
  ...(userStore.hasRole(UserRoleId.SYSTEM_ADMIN)
    ? [
        {
          title: 'Server',
          items: [
            { label: 'System config', icon: IconSettings, to: '/admin/sys-config' },
            { label: 'Batch jobs', icon: IconSchedule, to: '/admin/batch-jobs' },
          ],
        },
      ]
    : []),
]);
</script>
