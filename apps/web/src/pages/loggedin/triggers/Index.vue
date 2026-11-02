<template>
  <ui-page-container wide>
    <ui-page-heading title="Triggers" subtitle="Rules that start tasks from GitLab events and schedules." />

    <template v-for="source of sources ?? []" :key="source.name">
      <source-poll-failure :source="source" />

      <ui-card title="GitLab source" :subtitle="source.name">
        <source-poll-status :source="source" />
      </ui-card>
    </template>

    <ui-card flush>
      <ui-table :columns="TABLE_COLUMNS" :min-width="820">
        <ui-table-head>
          <span>Trigger</span>
          <span>Running</span>
          <span>Last fired</span>
          <span>Success · 7d</span>
          <span></span>
        </ui-table-head>

        <ui-table-row
          v-for="trigger of triggers ?? []"
          :key="trigger.name"
          :to="triggerPath(trigger.name)"
          data-testid="trigger-row"
        >
          <div class="min-w-0">
            <div class="truncate font-mono font-medium text-header">{{ trigger.name }}</div>
            <div class="truncate font-mono text-xs text-muted">{{ triggerSummary(trigger) }}</div>
          </div>

          <span class="font-mono text-xs">{{ trigger.runningCount }} / {{ trigger.concurrency }}</span>

          <span class="font-mono text-xs">
            {{ trigger.lastFiredDate === null ? 'Never' : formatShortDayTime(trigger.lastFiredDate) }}
          </span>

          <div class="min-w-0">
            <div class="truncate font-medium text-header">{{ formatSuccessRate(trigger.stats.successRate) }}</div>
            <div class="truncate text-xs text-muted">
              {{ trigger.stats.finishedCount }} {{ trigger.stats.finishedCount === 1 ? 'task' : 'tasks' }}
            </div>
          </div>

          <icon-chevron-right class="size-4 text-muted" />
        </ui-table-row>
      </ui-table>

      <ui-empty v-if="triggers && triggers.length === 0">No triggers in the current config.</ui-empty>
    </ui-card>
  </ui-page-container>
</template>

<script setup lang="ts">
import IconChevronRight from '~icons/material-symbols/chevron-right-rounded';

import { useResource } from '@/composables/useResource';

import { formatShortDayTime } from '@/utils/format/date';
import { formatSuccessRate, triggerPath, triggerSummary } from '@/utils/trigger';

import { useTriggerAdminService } from '@/services/api/admin/TriggerAdminService';

import SourcePollFailure from '@/components/trigger/SourcePollFailure.vue';
import SourcePollStatus from '@/components/trigger/SourcePollStatus.vue';
import { UiCard, UiEmpty, UiPageContainer, UiPageHeading, UiTable, UiTableHead, UiTableRow } from '@/components/ui';

const TABLE_COLUMNS = 'minmax(0, 1fr) 5rem 7.5rem 6.5rem 1.25rem';

const triggerAdminService = useTriggerAdminService();

const { data: triggers } = useResource({
  request: {},
  fetch: () => triggerAdminService.getTriggerList().then(response => response.triggerList),
  live: true,
});

const { data: sources } = useResource({
  request: {},
  fetch: () => triggerAdminService.getSourceList().then(response => response.sourceList),
  live: true,
});
</script>
