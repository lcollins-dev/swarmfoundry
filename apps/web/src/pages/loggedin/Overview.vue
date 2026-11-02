<template>
  <ui-page-container wide>
    <ui-page-heading title="Overview" subtitle="Your automation activity and performance." />

    <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
      <ui-kpi-tile
        label="Active now"
        :icon="IconPendingActions"
        :value="runningCount ?? '-'"
        :unit="slotCount === null ? undefined : `of ${slotCount} slots`"
        :bands="activeBands"
        :legend="activeLegend"
        data-testid="overview-active"
      />

      <ui-kpi-tile
        label="Success · 7d"
        :icon="IconTaskAlt"
        :value="stats ? formatSuccessRate(stats.successRate) : '-'"
        :unit="stats ? `of ${stats.finishedCount}` : undefined"
        :bands="successBands"
        :legend="successLegend"
        data-testid="overview-success"
      />

      <ui-kpi-tile
        label="Triggers"
        :icon="IconBolt"
        :value="triggers?.length ?? '-'"
        unit="configured"
        :bands="triggerBands"
        :legend="triggerLegend"
        data-testid="overview-triggers"
      />

      <ui-kpi-tile
        label="API cost · 7d"
        :icon="IconPayments"
        :value="stats ? formatUsd(stats.succeededCostUsd + stats.failedCostUsd) : '-'"
        unit="all triggers"
        :bands="costBands"
        :legend="costLegend"
        data-testid="overview-cost"
      />
    </div>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-stretch gap-4">
      <ui-card title="Triggers" flush>
        <ui-table :columns="TRIGGER_COLUMNS" :min-width="320">
          <ui-table-head>
            <span>Trigger</span>
            <span>Slots</span>
            <span></span>
          </ui-table-head>

          <ui-table-row
            v-for="trigger of triggers ?? []"
            :key="trigger.name"
            :to="triggerPath(trigger.name)"
            data-testid="overview-trigger"
          >
            <div class="min-w-0">
              <div class="flex min-w-0 items-center gap-2">
                <span class="truncate font-mono font-medium text-header">{{ trigger.name }}</span>
              </div>
              <div class="truncate font-mono text-xs text-muted">{{ triggerSummary(trigger) }}</div>
            </div>

            <span class="font-mono text-xs">{{ trigger.runningCount }} / {{ trigger.concurrency }}</span>

            <icon-chevron-right class="size-4 text-muted" />
          </ui-table-row>
        </ui-table>

        <template #footer>
          <ui-link to="/triggers" unstyled>
            <ui-button type="text" class="-mr-4.5">
              <template #icon>
                <icon-arrow-forward />
              </template>
              View all triggers
            </ui-button>
          </ui-link>
        </template>
      </ui-card>

      <ui-card title="Queue" flush>
        <running-task-compact-table
          v-if="runningTasks && triggerResponse"
          :running-tasks="runningTasks"
          :triggers="triggerResponse.triggerList"
          :config-sha="triggerResponse.configSha"
        />

        <template #footer>
          <ui-link to="/queue" unstyled>
            <ui-button type="text" class="-mr-4.5">
              <template #icon>
                <icon-arrow-forward />
              </template>
              View queue
            </ui-button>
          </ui-link>
        </template>
      </ui-card>
    </div>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import IconArrowForward from '~icons/material-symbols/arrow-forward-outline-rounded';
import IconBolt from '~icons/material-symbols/bolt-outline-rounded';
import IconChevronRight from '~icons/material-symbols/chevron-right-rounded';
import IconPayments from '~icons/material-symbols/payments-outline-rounded';
import IconPendingActions from '~icons/material-symbols/pending-actions-outline-rounded';
import IconTaskAlt from '~icons/material-symbols/task-alt-outline-rounded';

import { useResource } from '@/composables/useResource';
import { useRunningTasks } from '@/composables/useRunningTasks';

import { formatUsd } from '@/utils/format/number';
import { formatSuccessRate, sumStats, triggerPath, triggerSummary } from '@/utils/trigger';

import { useTriggerAdminService } from '@/services/api/admin/TriggerAdminService';

import RunningTaskCompactTable from '@/components/task/RunningTaskCompactTable.vue';
import {
  type IKpiBand,
  type IKpiLegendItem,
  UiButton,
  UiCard,
  UiKpiTile,
  UiLink,
  UiPageContainer,
  UiPageHeading,
  UiTable,
  UiTableHead,
  UiTableRow,
} from '@/components/ui';

const TRIGGER_COLUMNS = 'minmax(0, 1fr) 4rem 1.25rem';

const triggerAdminService = useTriggerAdminService();

const { data: triggerResponse } = useResource({
  request: {},
  fetch: () => triggerAdminService.getTriggerList(),
  live: true,
});
const triggers = computed(() => triggerResponse.value?.triggerList ?? null);

const { data: queue } = useResource({
  request: {},
  fetch: () => triggerAdminService.getQueue().then(response => response.queue),
  live: true,
});

const { data: runningTasks } = useRunningTasks();

const stats = computed(() => (triggers.value === null ? null : sumStats(triggers.value)));

const runningCount = computed(() => runningTasks.value?.length ?? null);

const slotCount = computed(() =>
  triggers.value === null ? null : triggers.value.reduce((total, trigger) => total + trigger.concurrency, 0)
);

const activeBands = computed<IKpiBand[]>(() => {
  if (runningCount.value === null || slotCount.value === null || queue.value === null) {
    return [];
  }

  return [
    { tone: 'primary', weight: runningCount.value },
    { tone: 'muted', weight: Math.max(0, slotCount.value - runningCount.value) },
    { tone: 'warning', weight: queue.value.length },
  ];
});

const activeLegend = computed<IKpiLegendItem[]>(() =>
  runningCount.value === null || queue.value === null
    ? []
    : [
        { label: `${runningCount.value} running`, tone: 'primary' },
        { label: `${queue.value.length} queued`, tone: 'warning' },
      ]
);

const successBands = computed<IKpiBand[]>(() =>
  stats.value === null
    ? []
    : [
        { tone: 'success', weight: stats.value.succeededCount },
        { tone: 'error', weight: stats.value.finishedCount - stats.value.succeededCount },
      ]
);

const successLegend = computed<IKpiLegendItem[]>(() =>
  stats.value === null
    ? []
    : [
        { label: `${stats.value.succeededCount} succeeded`, tone: 'success' },
        { label: `${stats.value.finishedCount - stats.value.succeededCount} failed`, tone: 'error' },
      ]
);

const triggerBands = computed<IKpiBand[]>(() =>
  triggers.value === null ? [] : [{ tone: 'success', weight: triggers.value.length }]
);

const triggerLegend = computed<IKpiLegendItem[]>(() =>
  triggers.value === null ? [] : [{ label: `${triggers.value.length} active`, tone: 'success' }]
);

const costBands = computed<IKpiBand[]>(() =>
  stats.value === null
    ? []
    : [
        { tone: 'success', weight: stats.value.succeededCostUsd },
        { tone: 'error', weight: stats.value.failedCostUsd },
      ]
);

const costLegend = computed<IKpiLegendItem[]>(() =>
  stats.value === null
    ? []
    : [
        { label: `${formatUsd(stats.value.succeededCostUsd)} ok`, tone: 'success' },
        { label: `${formatUsd(stats.value.failedCostUsd)} failed`, tone: 'error' },
      ]
);
</script>
