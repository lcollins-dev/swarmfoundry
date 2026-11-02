<template>
  <div
    class="h-1 w-full overflow-hidden rounded-full bg-emphasis"
    role="meter"
    :aria-label="props.label"
    aria-valuemin="0"
    aria-valuemax="1"
    :aria-valuenow="clamped"
  >
    <div class="h-full rounded-full" :class="TONE_CLASSES[props.tone]" :style="{ width: `${width}%` }" />
  </div>
</template>

<script setup lang="ts">
import { computed, PropType } from 'vue';

export type MeterTone = 'primary' | 'warning' | 'error';

const TONE_CLASSES: Record<MeterTone, string> = {
  primary: 'bg-primary',
  warning: 'bg-warning',
  error: 'bg-error',
};

/** `value` runs from 0 to 1, and fills the bar no further than full. */
const props = defineProps({
  value: {
    type: Number,
    required: true,
  },
  label: {
    type: String,
    required: true,
  },
  tone: {
    type: String as PropType<MeterTone>,
    default: 'primary',
  },
});

const clamped = computed(() => Math.min(Math.max(props.value, 0), 1));
const width = computed(() => clamped.value * 100);
</script>
