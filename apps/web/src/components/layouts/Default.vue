<template>
  <app-shell :sections="sections">
    <template #actions>
      <signed-in-header-actions />
    </template>

    <slot />
  </app-shell>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import IconBolt from '~icons/material-symbols/bolt-outline-rounded';
import IconChecklist from '~icons/material-symbols/checklist-outline-rounded';
import IconDashboard from '~icons/material-symbols/dashboard-outline-rounded';
import IconDescription from '~icons/material-symbols/description-outline-rounded';
import IconKey from '~icons/material-symbols/key-outline-rounded';
import IconPendingActions from '~icons/material-symbols/pending-actions-outline-rounded';
import IconPerson from '~icons/material-symbols/person-outline-rounded';
import IconSchedule from '~icons/material-symbols/schedule-outline-rounded';

import { UserRoleId } from '@libs/dto';

import { useUserStore } from '@/stores/user';

import AppShell from '@/components/shell/AppShell.vue';
import { INavItem, INavSection } from '@/components/shell/AppSidebar.vue';
import SignedInHeaderActions from '@/components/shell/SignedInHeaderActions.vue';

const userStore = useUserStore();

const sections = computed<INavSection[]>(() => {
  const isSystemAdmin = userStore.hasRole(UserRoleId.SYSTEM_ADMIN);
  const isUserAdmin = userStore.hasRole(UserRoleId.USER_ADMIN);

  const sectionList: INavSection[] = [];

  if (isSystemAdmin) {
    sectionList.push(
      { items: [{ label: 'Overview', icon: IconDashboard, to: '/overview' }] },
      {
        title: 'Pipeline',
        items: [
          { label: 'Triggers', icon: IconBolt, to: '/triggers' },
          { label: 'Queue', icon: IconPendingActions, to: '/queue' },
          { label: 'Tasks', icon: IconChecklist, to: '/tasks' },
        ],
      }
    );
  }

  const accessItems: INavItem[] = [];

  if (isSystemAdmin) {
    accessItems.push({ label: 'API keys', icon: IconKey, to: '/api-keys' });
  }

  if (isUserAdmin) {
    accessItems.push({ label: 'Users', icon: IconPerson, to: '/users' });
  }

  if (accessItems.length > 0) {
    sectionList.push({ title: 'Access', items: accessItems });
  }

  if (isSystemAdmin) {
    sectionList.push({
      title: 'System',
      items: [
        { label: 'Config', icon: IconDescription, to: '/config' },
        { label: 'Batch jobs', icon: IconSchedule, to: '/batch-jobs' },
      ],
    });
  }

  return sectionList;
});
</script>
