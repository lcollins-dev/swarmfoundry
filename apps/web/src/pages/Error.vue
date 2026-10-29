<template>
  <div class="flex flex-col gap-6">
    <ui-result :icon="IconError" type="error" title="Something went wrong">
      We couldn't finish that. Try again in a moment.

      <template #actions>
        <ui-link to="/" unstyled>
          <ui-button>Go Home</ui-button>
        </ui-link>

        <ui-button type="primary" @click="doRetry">Try Again</ui-button>
      </template>
    </ui-result>

    <details class="overflow-hidden rounded-xl border border-divider bg-surface">
      <summary class="cursor-pointer px-4 py-3 font-medium text-highlight">Error details</summary>

      <ui-code block tone="error">{{ errorDetails }}</ui-code>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, watchEffect } from 'vue';
import { useRouter } from 'vue-router';
import IconError from '~icons/material-symbols/error-outline-rounded';

import { useLogService } from '@/services/LogService';
import { useErrorStore } from '@/stores/error';

import { UiButton, UiCode, UiLink, UiResult } from '@/components/ui';

const logService = useLogService();
const logger = logService.createLogger('pages/Error');

const router = useRouter();

const errorStore = useErrorStore();

const errorMessage = computed(() => {
  const error = errorStore.vueError;

  if (typeof error !== 'object' || error === null || !('message' in error) || typeof error.message !== 'string') {
    return 'Unknown error';
  }

  return error.message;
});

const errorStack = computed(() => {
  const error = errorStore.vueError;

  if (typeof error !== 'object' || error === null || !('stack' in error) || typeof error.stack !== 'string') {
    return 'No stack provided';
  }

  return error.stack.replace('</span>', '\n').replace(/<[^>]*\/?>/gm, '');
});

const errorDetails = computed(() => `${errorMessage.value}\n\n${errorStack.value}`);

const doRetry = () => {
  router.back();
};

watchEffect(() => {
  if (errorStore.vueError === null) {
    router.push('/').catch((error: unknown) => {
      logger.error({ error }, 'watchEffect(): Failed to navigate home');
    });
  }
});
</script>
