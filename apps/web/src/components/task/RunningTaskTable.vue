<template>
  <ui-table :columns="TABLE_COLUMNS">
    <ui-table-head>
      <span>Issue or MR</span>
      <span>Trigger</span>
      <span>Step</span>
      <span>Elapsed / timeout</span>
      <span></span>
    </ui-table-head>

    <ui-table-row v-for="row of rows" :key="row.task.id" :to="`/tasks/${row.task.id}`" data-testid="running-task-row">
      <div class="min-w-0">
        <div class="truncate font-medium text-header">{{ row.subject.title }}</div>
        <div class="mt-0.5 truncate font-mono text-xs text-muted">{{ row.subject.reference }}</div>
      </div>

      <span class="truncate font-mono text-xs">{{ row.task.triggerName }}</span>

      <span class="font-mono text-xs">{{ row.step }}</span>

      <div class="min-w-0" data-testid="running-task-elapsed">
        <div class="font-mono text-xs">
          {{ row.elapsedMs === null ? 'Between runs' : formatDuration(row.elapsedMs) }}
          <span v-if="row.timeoutMs !== null" class="text-muted">/ {{ formatDuration(row.timeoutMs) }}</span>
          <span v-else-if="!row.onRunningConfig" class="text-muted">· older config</span>
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

import { formatDuration } from '@/utils/format/date';
import { elapsedMeterTone, runningTaskRow } from '@/utils/runningTask';

import { UiEmpty, UiMeter, UiTable, UiTableHead, UiTableRow } from '@/components/ui';

const TABLE_COLUMNS = 'minmax(0, 1fr) 7rem 9rem 10rem 1.25rem';

/** A step's kind and timeout come from `triggers`, so show only for a task pinned to `configSha`, the running revision. */
const props = defineProps({
  runningTasks: {
    type: Array as PropType<IRunningTask[]>,
    required: true,
  },
  triggers: {
    type: Array as PropType<TriggerDto[]>,
    required: true,
  },
  /** Null when the config loads from a local file. */
  configSha: {
    type: String as PropType<string | null>,
    default: null,
  },
});

const rows = computed(() =>
  props.runningTasks.map(runningTask => runningTaskRow(runningTask, props.triggers, props.configSha))
);
</script>
