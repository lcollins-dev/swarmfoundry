<template>
  <ui-card>
    <div class="-my-1 flex flex-col gap-2.5">
      <div class="flex min-w-0 items-center justify-between gap-2 text-muted">
        <span class="truncate text-xs font-medium uppercase tracking-wider">{{ props.label }}</span>

        <component :is="props.icon" v-if="props.icon" class="size-4 shrink-0" />
      </div>

      <div class="-mt-1 flex min-w-0 items-baseline gap-1.5" data-testid="kpi-value">
        <span class="whitespace-nowrap text-xl font-semibold text-header tabular-nums">{{ props.value }}</span>

        <span v-if="props.unit" class="truncate text-xs text-muted">{{ props.unit }}</span>
      </div>

      <div class="flex min-h-1 gap-0.75 rounded-full bg-emphasis" data-testid="kpi-bands">
        <span
          v-for="(band, index) of shownBands"
          :key="index"
          class="h-1 basis-0 rounded-full"
          :class="KPI_TONE_CLASSES[band.tone]"
          :style="{ flexGrow: band.weight }"
        />
      </div>

      <div v-if="props.legend.length > 0" class="flex flex-wrap gap-x-3 gap-y-1 whitespace-nowrap text-xs">
        <span v-for="item of props.legend" :key="item.label" class="inline-flex items-center gap-1.5">
          <span class="size-1.5 shrink-0 rounded-full" :class="KPI_TONE_CLASSES[item.tone]" />

          {{ item.label }}
        </span>
      </div>
    </div>
  </ui-card>
</template>

<script setup lang="ts">
import { type Component, PropType, computed } from 'vue';

import UiCard from '../layout/Card.vue';

export type KpiTone = 'primary' | 'success' | 'warning' | 'error' | 'muted';

const KPI_TONE_CLASSES: Record<KpiTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  muted: 'bg-line-strong',
};

export interface IKpiBand {
  tone: KpiTone;
  weight: number;
}

export interface IKpiLegendItem {
  label: string;
  tone: KpiTone;
}

const props = defineProps({
  label: {
    type: String,
    required: true,
  },
  icon: {
    type: [Object, Function] as PropType<Component>,
    default: undefined,
  },
  value: {
    type: [String, Number],
    required: true,
  },
  unit: {
    type: String,
    default: undefined,
  },
  /** Each band takes its share of the bar relative to the others, so the weights need not total 100. */
  bands: {
    type: Array as PropType<IKpiBand[]>,
    default: () => [],
  },
  legend: {
    type: Array as PropType<IKpiLegendItem[]>,
    default: () => [],
  },
});

const shownBands = computed(() => props.bands.filter(band => band.weight > 0));
</script>
