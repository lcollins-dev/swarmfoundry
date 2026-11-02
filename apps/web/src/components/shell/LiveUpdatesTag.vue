<template>
  <span class="mr-1 inline-flex" :title="LIVE_TITLES[telemetryStore.state]" data-testid="live-updates-tag">
    <ui-tag :type="LIVE_TAG_TYPES[telemetryStore.state]">{{ label }}</ui-tag>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { formatCompactDuration } from '@/utils/format/date';

import { TelemetryState, useTelemetryStore } from '@/stores/telemetry';

import { TagType, UiTag } from '@/components/ui';

const LIVE_TAG_TYPES: Record<TelemetryState, TagType> = {
  idle: 'default',
  live: 'success',
  stale: 'warning',
};

const LIVE_TITLES: Record<TelemetryState, string> = {
  idle: 'This page does not use live updates.',
  live: 'Runs, tasks and the queue update as they change.',
  stale: 'Connection lost. This page may be out of date.',
};

const telemetryStore = useTelemetryStore();

const label = computed(() => {
  const age = telemetryStore.ageSeconds === null ? null : formatCompactDuration(telemetryStore.ageSeconds * 1000);

  if (telemetryStore.state === 'idle' || age === null) {
    return telemetryStore.state === 'stale' ? 'Live updates · stale' : 'Live updates · idle';
  }

  return telemetryStore.state === 'live' ? `Live updates · ${age}` : `Live updates · ${age} old`;
});
</script>
