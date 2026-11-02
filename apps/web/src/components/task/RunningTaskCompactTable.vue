<template>
  <ui-table :columns="TABLE_COLUMNS" :min-width="320">
    <ui-table-head>
      <span>Task</span>
      <span>Elapsed</span>
      <span></span>
    </ui-table-head>

    <ui-table-row v-for="row of rows" :key="row.task.id" :to="`/tasks/${row.task.id}`" data-testid="running-task-row">
      <div class="min-w-0">
        <div class="truncate font-mono font-medium text-header">
          {{ row.task.triggerName }} {{ row.subject.url === null ? '' : row.shortReference }}
        </div>
        <div class="truncate text-xs text-muted">{{ row.subject.url === null ? 'Scheduled' : row.subject.title }}</div>
      </div>

      <div class="min-w-0" data-testid="running-task-elapsed">
        <div class="font-mono text-xs">
          {{ row.elapsedMs === null ? 'Between runs' : formatCompactDuration(row.elapsedMs) }}
          <template v-if="row.timeoutMs !== null">/ {{ formatCompactDuration(row.timeoutMs) }}</template>
        </div>

        <ui-meter
          v-if="row.elapsedMs !== null && row.timeoutMs !== null"
          class="mt-1.5"
          label="Elapsed of its timeout"
          :value="row.elapsedMs / row.timeoutMs"
          :tone="elapsedMeterTone(row.elapsedMs / row.timeoutMs)"
        />
      </div>

      <icon-chevron-right class="size-4 text-muted" />
    </ui-table-row>
  </ui-table>

  <ui-empty v-if="props.runningTasks.length === 0">Nothing is running.</ui-empty>
</template>

<script setup lang="ts">
import { computed, PropType } from 'vue';
import IconChevronRight from '~icons/material-symbols/chevron-right-rounded';

import type { TriggerDto } from '@libs/dto';

import type { IRunningTask } from '@/composables/useRunningTasks';

import { formatCompactDuration } from '@/utils/format/date';
import { elapsedMeterTone, runningTaskRow } from '@/utils/runningTask';

import { UiEmpty, UiMeter, UiTable, UiTableHead, UiTableRow } from '@/components/ui';

const TABLE_COLUMNS = 'minmax(0, 1fr) 8.5rem 1.25rem';

const props = defineProps({
  runningTasks: {
    type: Array as PropType<IRunningTask[]>,
    required: true,
  },
  triggers: {
    type: Array as PropType<TriggerDto[]>,
    required: true,
  },
  configSha: {
    type: String as PropType<string | null>,
    default: null,
  },
});

const rows = computed(() =>
  props.runningTasks.map(runningTask => runningTaskRow(runningTask, props.triggers, props.configSha))
);
</script>
