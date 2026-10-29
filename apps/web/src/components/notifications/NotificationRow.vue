<template>
  <div
    class="flex items-start gap-1 rounded-md"
    :class="{ 'hover:bg-inset has-focus-visible:bg-inset': hasPage }"
    data-testid="notification-row"
  >
    <ui-menu-item :interactive="hasPage" :hoverable="false" class="min-w-0 flex-1" @click="openPage">
      <template #icon>
        <ui-disc-icon
          :icon="SEVERITY_ICONS[severity]"
          :size="18"
          class="mt-px text-popover"
          :class="SEVERITY_DISC_CLASSES[severity]"
        />
      </template>

      <div class="min-w-0 flex-1">
        <div class="font-medium text-header">{{ props.notification.notificationType.name }}</div>

        <div v-dompurify-html="props.notification.desc" class="mt-0.5 leading-normal text-normal"></div>

        <div class="mt-1 font-mono text-xs text-muted">
          {{ formatRelativeDate(props.notification.createdDate) }}
        </div>
      </div>
    </ui-menu-item>

    <ui-spinner v-if="clearing" :size="16" type="current" class="mr-2.5 mt-2.5 text-muted" />

    <ui-icon-button v-else :icon="IconClose" label="Clear" size="sm" class="mr-2 mt-2" @click="clear" />
  </div>
</template>

<script setup lang="ts">
import { computed, PropType, ref } from 'vue';
import { useRouter } from 'vue-router';
import IconClose from '~icons/material-symbols/close-rounded';

import { NotificationDto } from '@libs/dto';

import { formatRelativeDate } from '@/utils/format/date';

import { useLogService } from '@/services/LogService';
import { useNotificationService } from '@/services/api/NotificationService';

import { UiDiscIcon, UiIconButton, UiMenuItem, UiSpinner } from '@/components/ui';
import { SEVERITY_DISC_CLASSES, SEVERITY_ICONS } from '@/components/ui/feedback/severity';

const logService = useLogService();
const logger = logService.createLogger('components/notifications/NotificationRow');

const props = defineProps({
  notification: {
    type: Object as PropType<NotificationDto>,
    required: true,
  },
});

const emit = defineEmits<{
  cleared: [];
  opened: [];
}>();

const router = useRouter();

const notificationService = useNotificationService();

const clearing = ref(false);

const pageUrl = computed(() => props.notification.notificationType.pageUrl ?? '');
const hasPage = computed(() => pageUrl.value !== '');

const severity = computed(() => props.notification.notificationType.severity);

const clear = () => {
  clearing.value = true;

  notificationService
    .clearNotification(props.notification.id)
    .then(() => {
      emit('cleared');
    })
    .finally(() => {
      clearing.value = false;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'clear(): Failed to clear the notification');
    });
};

const openPage = () => {
  if (!hasPage.value) {
    return;
  }

  emit('opened');

  router.push(pageUrl.value).catch((error: unknown) => {
    logger.error({ error }, 'openPage(): Failed to navigate to the notification page');
  });

  clear();
};
</script>
