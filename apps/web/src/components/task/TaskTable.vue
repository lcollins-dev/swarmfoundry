<template>
  <ui-table :columns="props.showTrigger ? COLUMNS_WITH_TRIGGER : COLUMNS">
    <ui-table-head>
      <span>Issue or MR</span>
      <span v-if="props.showTrigger">Trigger</span>
      <span>Status</span>
      <span>Current step</span>
      <span>Runs</span>
      <span>Duration</span>
      <span>Tokens</span>
      <span>API cost</span>
      <span></span>
    </ui-table-head>

    <ui-table-row v-for="task of props.tasks" :key="task.id" :to="`/tasks/${task.id}`" data-testid="task-row">
      <div class="min-w-0">
        <div class="truncate font-medium text-header">{{ taskSubject(task).title }}</div>
        <div class="mt-0.5 truncate font-mono text-xs text-muted">{{ taskSubject(task).reference }}</div>
      </div>

      <span v-if="props.showTrigger" class="truncate font-mono text-xs">{{ task.triggerName }}</span>

      <div>
        <ui-tag :type="TASK_STATUS_TAG_TYPES[task.status]">{{ TASK_STATUS_LABELS[task.status] }}</ui-tag>
      </div>

      <span class="font-mono text-xs">{{ taskCurrentStep(task) }}</span>

      <span class="font-mono text-xs">{{ task.runCount }}</span>

      <span class="font-mono text-xs">{{ formatOptionalDuration(spanMs(task.startDate, task.endDate)) }}</span>

      <span class="font-mono text-xs">
        {{ task.totalTokens === null ? '-' : formatNumberAbbreviated(task.totalTokens) }}
      </span>

      <span class="font-mono text-xs">{{ task.costUsd === null ? '-' : formatUsd(task.costUsd) }}</span>

      <icon-chevron-right class="size-4 text-muted" />
    </ui-table-row>
  </ui-table>
</template>

<script setup lang="ts">
import { PropType } from 'vue';
import IconChevronRight from '~icons/material-symbols/chevron-right-rounded';

import type { ListTaskDto } from '@libs/dto';

import { formatDuration } from '@/utils/format/date';
import { formatNumberAbbreviated, formatUsd } from '@/utils/format/number';
import { TASK_STATUS_LABELS, TASK_STATUS_TAG_TYPES, spanMs, taskCurrentStep, taskSubject } from '@/utils/task';

import { UiTable, UiTableHead, UiTableRow, UiTag } from '@/components/ui';

const COLUMNS_WITH_TRIGGER = 'minmax(0, 1fr) 7rem 6.5rem 7.5rem 3rem 5.5rem 4.5rem 4.5rem 1.25rem';
const COLUMNS = 'minmax(0, 1fr) 6.5rem 7.5rem 3rem 5.5rem 4.5rem 4.5rem 1.25rem';

const props = defineProps({
  tasks: {
    type: Array as PropType<ListTaskDto[]>,
    required: true,
  },
  showTrigger: {
    type: Boolean,
    default: true,
  },
});

const formatOptionalDuration = (milliseconds: number | null): string =>
  milliseconds === null ? '-' : formatDuration(milliseconds);
</script>
