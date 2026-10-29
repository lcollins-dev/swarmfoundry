<template>
  <app-shell :sections="sections">
    <template #actions>
      <signed-in-header-actions />
    </template>

    <slot />
  </app-shell>
</template>

<script setup lang="ts">
import IconManageAccounts from '~icons/material-symbols/manage-accounts-outline-rounded';
import IconSpaceDashboard from '~icons/material-symbols/space-dashboard-outline-rounded';

import AppShell from '@/components/shell/AppShell.vue';
import { INavSection } from '@/components/shell/AppSidebar.vue';
import SignedInHeaderActions from '@/components/shell/SignedInHeaderActions.vue';

const sections: INavSection[] = [
  { title: 'General', items: [{ label: 'Dashboard', icon: IconSpaceDashboard, to: '/dashboard' }] },
  { title: 'Account', items: [{ label: 'Profile & security', icon: IconManageAccounts, to: '/edit-profile' }] },
];
</script>
