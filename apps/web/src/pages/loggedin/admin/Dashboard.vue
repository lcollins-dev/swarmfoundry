<template>
  <ui-page-container>
    <ui-page-heading title="Admin dashboard" subtitle="The admin areas open to you on this system." />

    <ui-card flush>
      <ui-list-row
        v-for="area of areaList"
        :key="area.to"
        :to="area.to"
        :title="area.title"
        :meta="area.description"
        data-testid="admin-area"
      >
        <template #icon>
          <component :is="area.icon" class="size-5" />
        </template>

        <template #actions>
          <icon-chevron-right class="size-4 text-muted" />
        </template>
      </ui-list-row>
    </ui-card>
  </ui-page-container>
</template>

<script setup lang="ts">
import { type Component, computed } from 'vue';
import IconChevronRight from '~icons/material-symbols/chevron-right-rounded';
import IconGroup from '~icons/material-symbols/group-outline-rounded';
import IconSchedule from '~icons/material-symbols/schedule-outline-rounded';
import IconSettings from '~icons/material-symbols/settings-outline-rounded';

import { UserRoleId } from '@libs/dto';

import { useUserStore } from '@/stores/user';

import { UiCard, UiListRow, UiPageContainer, UiPageHeading } from '@/components/ui';

const userStore = useUserStore();

interface IAdminArea {
  title: string;
  description: string;
  icon: Component;
  to: string;
  show: boolean;
}

const areaList = computed<IAdminArea[]>(() =>
  [
    {
      title: 'Users',
      description: 'Everyone with an account on this system.',
      icon: IconGroup,
      to: '/admin/users',
      show: userStore.hasRole(UserRoleId.USER_ADMIN),
    },
    {
      title: 'System config',
      description: 'Settings that apply across the whole system.',
      icon: IconSettings,
      to: '/admin/sys-config',
      show: userStore.hasRole(UserRoleId.SYSTEM_ADMIN),
    },
    {
      title: 'Batch jobs',
      description: 'Scheduled jobs registered on this system.',
      icon: IconSchedule,
      to: '/admin/batch-jobs',
      show: userStore.hasRole(UserRoleId.SYSTEM_ADMIN),
    },
  ].filter(area => area.show)
);
</script>
