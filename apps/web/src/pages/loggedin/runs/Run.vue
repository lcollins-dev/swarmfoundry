<template>
  <ui-page-container>
    <ui-page-heading v-if="run" :title="`Run ${run.id}`" :back-to="backLink.to" :back-label="backLink.label">
      <template #tags>
        <ui-tag :type="RUN_STATUS_TAG_TYPES[status]" data-testid="run-status">{{ RUN_STATUS_LABELS[status] }}</ui-tag>
      </template>

      <template #subtitle>
        {{ stepLabel(run.list, run.step) }} · Try {{ run.number
        }}<template v-if="subject"> · {{ subject.title }}</template>
      </template>
    </ui-page-heading>

    <ui-back-link v-else :to="backLink.to" :label="backLink.label" />

    <template v-if="run">
      <ui-notice v-if="run.error !== null" type="error" title="Error" data-testid="run-error">
        <span class="whitespace-pre-wrap break-words">{{ run.error }}</span>
      </ui-notice>

      <ui-card title="Outcome">
        <ui-stat-grid>
          <ui-stat label="Outcome">
            <ui-tag :type="RUN_STATUS_TAG_TYPES[status]">{{ RUN_STATUS_LABELS[status] }}</ui-tag>
          </ui-stat>
          <ui-stat label="End reason" data-testid="run-end-reason">
            {{ run.endReason === null ? '-' : RUN_END_REASON_LABELS[run.endReason] }}
          </ui-stat>
          <ui-stat label="Exit code" mono>{{ run.exitCode ?? '-' }}</ui-stat>

          <ui-stat label="Try" mono>{{ run.number }}</ui-stat>
          <ui-stat label="Started" mono>{{ formatDayTime(run.startDate) }}</ui-stat>
          <ui-stat label="Duration" mono>{{ formatDuration(spanMs(run.startDate, run.endDate) ?? 0) }}</ui-stat>

          <ui-stat label="Config revision" mono>{{ run.configSha?.slice(0, 8) ?? '-' }}</ui-stat>
          <ui-stat label="Agent" mono>{{ run.agent ? `${run.agent.name} · ${run.agent.model}` : '-' }}</ui-stat>
          <ui-stat label="Turns" mono>{{ run.turns ?? '-' }}</ui-stat>

          <ui-stat label="Input tokens" mono>{{ formatOptionalCount(run.inputTokens) }}</ui-stat>
          <ui-stat label="Output tokens" mono>{{ formatOptionalCount(run.outputTokens) }}</ui-stat>
          <ui-stat label="Cache read" mono>{{ formatOptionalCount(run.cacheReadTokens) }}</ui-stat>

          <ui-stat label="Cache write" mono>{{ formatOptionalCount(run.cacheWriteTokens) }}</ui-stat>
          <ui-stat label="Total tokens" mono data-testid="run-tokens">
            {{ tokens === null ? '-' : formatNumber(tokens) }}
          </ui-stat>
          <ui-stat label="API cost" mono data-testid="run-cost">
            {{ run.costUsd === null ? '-' : formatUsd(run.costUsd) }}
          </ui-stat>
        </ui-stat-grid>
      </ui-card>

      <run-transcript :run="run" @ended="doReloadRun" />
    </template>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import { useBackLink } from '@/composables/useBackLink';
import { useResource } from '@/composables/useResource';

import { formatDayTime, formatDuration } from '@/utils/format/date';
import { formatNumber, formatNumberAbbreviated, formatUsd } from '@/utils/format/number';
import {
  RUN_END_REASON_LABELS,
  RUN_STATUS_LABELS,
  RUN_STATUS_TAG_TYPES,
  runStatus,
  runTotalTokens,
  spanMs,
  stepLabel,
  taskSubject,
} from '@/utils/task';

import { useTaskAdminService } from '@/services/api/admin/TaskAdminService';

import RunTranscript from '@/components/transcript/RunTranscript.vue';
import {
  UiBackLink,
  UiCard,
  UiNotice,
  UiPageContainer,
  UiPageHeading,
  UiStat,
  UiStatGrid,
  UiTag,
} from '@/components/ui';

const route = useRoute();

const taskAdminService = useTaskAdminService();

const runId = computed(() => (typeof route.params.runId === 'string' ? parseInt(route.params.runId, 10) : null));

const { data: run, reload: reloadRun } = useResource({
  request: runId,
  fetch: (targetId: number) => taskAdminService.getRun(targetId),
});

const { data: task } = useResource({
  request: () => run.value?.taskId ?? null,
  fetch: (targetId: number) => taskAdminService.getTask(targetId),
});

const subject = computed(() => (task.value === null ? null : taskSubject(task.value)));

const taskPath = computed(() => (run.value === null ? '/tasks' : `/tasks/${run.value.taskId}`));

const backLabel = computed(() => {
  if (subject.value !== null && task.value !== null) {
    return `${subject.value.reference} · ${task.value.triggerName} · Task ${task.value.id}`;
  }

  return run.value === null ? 'Tasks' : `Task ${run.value.taskId}`;
});

const backLink = useBackLink(() => ({ to: taskPath.value, label: backLabel.value }));

const status = computed(() => (run.value === null ? 'running' : runStatus(run.value)));

const tokens = computed(() => (run.value === null ? null : runTotalTokens(run.value)));

const doReloadRun = () => {
  void reloadRun();
};

const formatOptionalCount = (count: number | null): string => (count === null ? '-' : formatNumberAbbreviated(count));
</script>
