<template>
  <ui-dropdown v-model:open="open">
    <template #trigger="{ open: isOpen, toggle }">
      <ui-icon-button
        :icon="IconNotifications"
        label="Notifications"
        aria-haspopup="dialog"
        :aria-expanded="isOpen"
        @click="toggle"
      />

      <ui-count-badge
        :count="notificationList.length"
        class="pointer-events-none absolute right-0.5 top-2.5"
        aria-hidden="true"
        data-testid="notifications-count"
      />
    </template>

    <template #default="{ close }">
      <ui-popover
        title="Notifications"
        :subtitle="subtitle"
        class="w-80"
        role="dialog"
        aria-label="Notifications"
        data-testid="notifications-panel"
      >
        <div v-if="loading && notificationList.length === 0" class="flex justify-center py-6">
          <ui-spinner :size="20" />
        </div>

        <ui-empty v-else-if="notificationList.length === 0">No new notifications</ui-empty>

        <div v-else class="max-h-96 overflow-y-auto">
          <notification-row
            v-for="notification of notificationList"
            :key="notification.id"
            :notification="notification"
            @cleared="loadNotifications"
            @opened="close"
          />
        </div>
      </ui-popover>
    </template>
  </ui-dropdown>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import IconNotifications from '~icons/material-symbols/notifications-outline-rounded';

import { NotificationDto } from '@libs/dto';

import { useLogService } from '@/services/LogService';
import { useNotificationService } from '@/services/api/NotificationService';

import NotificationRow from '@/components/notifications/NotificationRow.vue';
import { UiCountBadge, UiDropdown, UiEmpty, UiIconButton, UiPopover, UiSpinner } from '@/components/ui';

const logService = useLogService();
const logger = logService.createLogger('components/notifications/NotificationsMenu');

const route = useRoute();

const notificationService = useNotificationService();

const notificationList = ref<NotificationDto[]>([]);
const loading = ref(false);
const open = ref(false);

const subtitle = computed(() =>
  notificationList.value.length > 0 ? `${notificationList.value.length} unread` : undefined
);

const loadNotifications = () => {
  loading.value = true;

  notificationService
    .getNotificationList()
    .then(response => {
      notificationList.value = response.notificationList;
    })
    .finally(() => {
      loading.value = false;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'loadNotifications(): Failed to get the notification list');
    });
};

watch(
  () => route.fullPath,
  () => {
    open.value = false;
  }
);

loadNotifications();
</script>
