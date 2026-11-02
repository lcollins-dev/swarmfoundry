<template>
  <ui-stat-grid>
    <ui-stat label="Instance" mono>{{ instance }}</ui-stat>

    <ui-stat label="Last poll" mono data-testid="source-last-poll">
      <template v-if="props.source.lastPoll !== null">
        {{ formatClockTime(props.source.lastPoll.endDate) }} · {{ formatCompactDuration(ageMs) }} ago
      </template>

      <template v-else>None since startup</template>
    </ui-stat>

    <ui-stat label="Next poll" mono data-testid="source-next-poll">
      {{ nextPoll }}
    </ui-stat>
  </ui-stat-grid>
</template>

<script setup lang="ts">
import { useNow } from '@vueuse/core';
import { computed, PropType } from 'vue';

import type { SourceDto } from '@libs/dto';

import { formatClockTime, formatCompactDuration } from '@/utils/format/date';

import { UiStat, UiStatGrid } from '@/components/ui';

const props = defineProps({
  source: {
    type: Object as PropType<SourceDto>,
    required: true,
  },
});

const now = useNow({ interval: 1000 });

const instance = computed(() => props.source.url.replace(/^https?:\/\//, ''));

const ageMs = computed(() =>
  props.source.lastPoll === null ? 0 : now.value.getTime() - props.source.lastPoll.endDate.getTime()
);

const nextPoll = computed(() => {
  if (props.source.nextPollDate === null) {
    return 'Polling now';
  }

  const untilMs = props.source.nextPollDate.getTime() - now.value.getTime();

  return untilMs > 0 ? `in ${formatCompactDuration(untilMs)}` : 'Due now';
});
</script>
