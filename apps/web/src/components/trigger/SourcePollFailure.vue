<template>
  <ui-notice
    v-if="props.source.lastPoll !== null && !props.source.lastPoll.succeeded"
    type="error"
    :title="`Last poll failed · ${props.source.name}`"
    data-testid="source-poll-failure"
  >
    <div v-if="props.source.lastPoll.error !== null">{{ props.source.lastPoll.error }}</div>
    <div v-for="failed of props.source.lastPoll.failedProjects" :key="failed.project">
      {{ `${failed.project}: ${failed.error}` }}
    </div>
  </ui-notice>
</template>

<script setup lang="ts">
import { PropType } from 'vue';

import type { SourceDto } from '@libs/dto';

import { UiNotice } from '@/components/ui';

const props = defineProps({
  source: {
    type: Object as PropType<SourceDto>,
    required: true,
  },
});
</script>
