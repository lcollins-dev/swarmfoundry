<template>
  <ui-page-container wide>
    <ui-page-heading title="Queue" subtitle="Tasks in progress and waiting to run." />

    <ui-card title="Running" flush>
      <running-task-table
        v-if="runningTasks && triggerResponse"
        :running-tasks="runningTasks"
        :triggers="triggerResponse.triggerList"
        :config-sha="triggerResponse.configSha"
      />
    </ui-card>

    <ui-card title="Queued" subtitle="Tasks waiting to run." flush>
      <ui-table :columns="QUEUED_COLUMNS">
        <ui-table-head>
          <span>Issue or MR</span>
          <span>Trigger</span>
          <span>Waiting for</span>
          <span>Queued</span>
          <span></span>
        </ui-table-head>

        <ui-table-row
          v-for="task of queue ?? []"
          :key="task.id"
          :to="`/tasks/${task.id}`"
          data-testid="queued-task-row"
        >
          <div class="min-w-0">
            <div class="truncate font-medium text-header">{{ taskSubject(task).title }}</div>
            <div class="mt-0.5 truncate font-mono text-xs text-muted">{{ taskSubject(task).reference }}</div>
          </div>

          <span class="truncate font-mono text-xs">{{ task.triggerName }}</span>

          <span class="text-xs" data-testid="queued-task-wait">{{ queueWaitLabel(task.wait) }}</span>

          <span class="font-mono text-xs">{{ formatRelativeDate(task.queuedDate) }}</span>

          <icon-chevron-right class="size-4 text-muted" />
        </ui-table-row>
      </ui-table>

      <ui-empty v-if="queue && queue.length === 0">Nothing is queued.</ui-empty>
    </ui-card>
  </ui-page-container>
</template>

<script setup lang="ts">
import IconChevronRight from '~icons/material-symbols/chevron-right-rounded';

import { useResource } from '@/composables/useResource';
import { useRunningTasks } from '@/composables/useRunningTasks';

import { formatRelativeDate } from '@/utils/format/date';
import { taskSubject } from '@/utils/task';
import { queueWaitLabel } from '@/utils/trigger';

import { useTriggerAdminService } from '@/services/api/admin/TriggerAdminService';

import RunningTaskTable from '@/components/task/RunningTaskTable.vue';
import { UiCard, UiEmpty, UiPageContainer, UiPageHeading, UiTable, UiTableHead, UiTableRow } from '@/components/ui';

const QUEUED_COLUMNS = 'minmax(0, 1fr) 7rem minmax(0, 1fr) 7rem 1.25rem';

const triggerAdminService = useTriggerAdminService();

const { data: triggerResponse } = useResource({
  request: {},
  fetch: () => triggerAdminService.getTriggerList(),
  live: true,
});

const { data: queue } = useResource({
  request: {},
  fetch: () => triggerAdminService.getQueue().then(response => response.queue),
  live: true,
});

const { data: runningTasks } = useRunningTasks();
</script>
