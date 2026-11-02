<template>
  <ui-page-container wide>
    <ui-page-heading v-if="trigger" :title="trigger.name" :back-to="backLink.to" :back-label="backLink.label">
      <template #subtitle>{{ triggerSummary(trigger) }}</template>
    </ui-page-heading>

    <ui-back-link v-else :to="backLink.to" :label="backLink.label" />

    <ui-notice v-if="triggers && !trigger" type="warning" title="Trigger unavailable" data-testid="trigger-missing">
      This trigger is not in the current config. You can find its previous tasks on the Tasks page.
    </ui-notice>

    <template v-if="trigger">
      <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <ui-kpi-tile
          label="Success · 7d"
          :icon="IconTaskAlt"
          :value="formatSuccessRate(trigger.stats.successRate)"
          :unit="`of ${trigger.stats.finishedCount}`"
          :bands="[
            { tone: 'success', weight: trigger.stats.succeededCount },
            { tone: 'error', weight: failedCount },
          ]"
          :legend="[
            { label: `${trigger.stats.succeededCount} succeeded`, tone: 'success' },
            { label: `${failedCount} failed`, tone: 'error' },
          ]"
          data-testid="trigger-success"
        />

        <ui-kpi-tile
          label="Active now"
          :icon="IconPendingActions"
          :value="trigger.runningCount"
          :unit="`of ${trigger.concurrency} ${trigger.concurrency === 1 ? 'slot' : 'slots'}`"
          :bands="[
            { tone: 'primary', weight: trigger.runningCount },
            { tone: 'muted', weight: Math.max(0, trigger.concurrency - trigger.runningCount) },
            { tone: 'warning', weight: trigger.queuedCount },
          ]"
          :legend="[
            { label: `${trigger.runningCount} running`, tone: 'primary' },
            { label: `${trigger.queuedCount} queued`, tone: 'warning' },
          ]"
          data-testid="trigger-running"
        />

        <ui-kpi-tile
          label="Median duration"
          :icon="IconTimer"
          :value="formatOptionalDuration(trigger.stats.medianDurationMs)"
          :unit="agentTimeoutMs === 0 ? 'no agent step' : `/ ${formatCompactDuration(agentTimeoutMs)}`"
          :bands="durationBands"
          :legend="[{ label: `p90 ${formatOptionalDuration(trigger.stats.p90DurationMs)}`, tone: 'primary' }]"
          data-testid="trigger-duration"
        />

        <ui-kpi-tile
          label="API cost · 7d"
          :icon="IconPayments"
          :value="formatUsd(trigger.stats.succeededCostUsd + trigger.stats.failedCostUsd)"
          :unit="agentTimeoutMs === 0 ? 'no agent step' : undefined"
          :bands="[
            { tone: 'success', weight: trigger.stats.succeededCostUsd },
            { tone: 'error', weight: trigger.stats.failedCostUsd },
          ]"
          :legend="[
            { label: `${formatUsd(trigger.stats.succeededCostUsd)} ok`, tone: 'success' },
            { label: `${formatUsd(trigger.stats.failedCostUsd)} failed`, tone: 'error' },
          ]"
          data-testid="trigger-cost"
        />
      </div>

      <ui-card title="Match rules" flush>
        <ui-table :columns="RULE_COLUMNS">
          <ui-table-head>
            <span>Rule</span>
            <span>Value</span>
          </ui-table-head>

          <ui-table-row v-for="rule of rules" :key="rule.key" data-testid="trigger-rule">
            <div class="min-w-0">
              <div class="font-medium text-header">{{ rule.label }}</div>
              <div class="mt-0.5 truncate font-mono text-xs text-muted">{{ rule.key }}</div>
            </div>

            <div class="min-w-0">
              <span v-if="rule.values.length > 0" class="flex flex-wrap gap-1.5">
                <ui-code v-for="value of rule.values" :key="value" emphasis>{{ value }}</ui-code>
              </span>
              <div v-if="rule.note" class="text-xs text-muted" :class="{ 'mt-1': rule.values.length > 0 }">
                {{ rule.note }}
              </div>
            </div>
          </ui-table-row>
        </ui-table>
      </ui-card>

      <ui-card title="Tasks" flush>
        <task-table :tasks="taskList" :show-trigger="false" />

        <ui-empty v-if="!loading && taskList.length === 0">No tasks for this trigger yet.</ui-empty>

        <div class="flex items-center justify-between gap-3 border-t border-divider px-4 py-2.5 text-xs text-muted">
          <span data-testid="task-count">{{ formatTaskCount(page, pages, taskList.length, total) }}</span>

          <ui-pagination v-if="pages > 1" v-model:page="page" :page-count="pages" />
        </div>
      </ui-card>
    </template>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import IconPayments from '~icons/material-symbols/payments-outline-rounded';
import IconPendingActions from '~icons/material-symbols/pending-actions-outline-rounded';
import IconTaskAlt from '~icons/material-symbols/task-alt-outline-rounded';
import IconTimer from '~icons/material-symbols/timer-outline-rounded';

import { useBackLink } from '@/composables/useBackLink';
import { usePagedList } from '@/composables/usePagedList';
import { useResource } from '@/composables/useResource';

import { formatCompactDuration } from '@/utils/format/date';
import { formatUsd } from '@/utils/format/number';
import { formatTaskCount } from '@/utils/task';
import { formatSuccessRate, triggerRules, triggerSummary } from '@/utils/trigger';

import { useTaskAdminService } from '@/services/api/admin/TaskAdminService';
import { useTriggerAdminService } from '@/services/api/admin/TriggerAdminService';

import TaskTable from '@/components/task/TaskTable.vue';
import {
  type IKpiBand,
  UiBackLink,
  UiCard,
  UiCode,
  UiEmpty,
  UiKpiTile,
  UiNotice,
  UiPageContainer,
  UiPageHeading,
  UiPagination,
  UiTable,
  UiTableHead,
  UiTableRow,
} from '@/components/ui';

const RULE_COLUMNS = '14rem minmax(0, 1fr)';

const route = useRoute();

const backLink = useBackLink({ to: '/triggers', label: 'Triggers' });

const triggerAdminService = useTriggerAdminService();
const taskAdminService = useTaskAdminService();

const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''));

const { data: triggers } = useResource({
  request: {},
  fetch: () => triggerAdminService.getTriggerList().then(response => response.triggerList),
  live: true,
});

const trigger = computed(() => triggers.value?.find(listed => listed.name === name.value) ?? null);

const rules = computed(() => (trigger.value === null ? [] : triggerRules(trigger.value)));

const {
  list: taskList,
  page,
  pages,
  total,
  loading,
} = usePagedList({
  request: computed(() => (trigger.value === null ? null : { trigger: trigger.value.name })),
  debounceRequest: false,
  fetch: (request, listPage) =>
    taskAdminService
      .getTaskList(request, listPage)
      .then(response => ({ list: response.taskList, pages: Math.max(response.pages, 1), total: response.total })),
  live: true,
});

const formatOptionalDuration = (milliseconds: number | null): string =>
  milliseconds === null ? '-' : formatCompactDuration(milliseconds);

const failedCount = computed(() =>
  trigger.value === null ? 0 : trigger.value.stats.finishedCount - trigger.value.stats.succeededCount
);

const agentTimeoutMs = computed(() =>
  (trigger.value?.steps ?? []).reduce((total, step) => total + (step.kind === 'agent' ? step.timeoutMs : 0), 0)
);

const durationBands = computed<IKpiBand[]>(() => {
  const medianMs = trigger.value?.stats.medianDurationMs ?? null;

  if (medianMs === null || agentTimeoutMs.value === 0) {
    return [];
  }

  return [
    { tone: 'primary', weight: Math.max(1, medianMs) },
    { tone: 'muted', weight: Math.max(0, agentTimeoutMs.value - medianMs) },
  ];
});
</script>
