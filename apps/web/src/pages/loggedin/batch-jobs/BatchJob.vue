<template>
  <ui-page-container>
    <ui-page-heading
      v-if="batchJob"
      :title="batchJob.name"
      :subtitle="batchJob.desc"
      :back-to="backLink.to"
      :back-label="backLink.label"
    >
      <ui-switch-label
        :value="batchJob.enabled"
        :aria-label="`Run ${batchJob.name} on its schedule`"
        :loading="pending === 'state'"
        :disabled="pending === 'run'"
        label-first
        @update:value="doSetEnabled"
      >
        <span data-testid="job-state">{{ batchJob.enabled ? 'Enabled' : 'Disabled' }}</span>
      </ui-switch-label>
    </ui-page-heading>

    <ui-back-link v-else :to="backLink.to" :label="backLink.label" />

    <ui-card v-if="batchJob" title="Schedule" subtitle="When this job runs.">
      <ui-stat-grid>
        <ui-stat label="Cron" mono>{{ batchJob.cronExpression ?? 'Not scheduled' }}</ui-stat>
        <ui-stat label="Last success" mono>{{ formatOptional(batchJob.lastSuccessDate) }}</ui-stat>
        <ui-stat label="Last failure" mono>{{ formatOptional(batchJob.lastFailDate) }}</ui-stat>
      </ui-stat-grid>
    </ui-card>

    <ui-card v-if="batchJob" title="Recent runs" subtitle="Execution history and results for this job." flush>
      <template #header-extra>
        <ui-button
          type="primary"
          :disabled="!runnable || running || pending === 'state'"
          :loading="pending === 'run'"
          @click="doRunNow"
        >
          <template #icon>
            <icon-play-arrow class="size-4" />
          </template>
          Run Now
        </ui-button>
      </template>

      <ui-table :columns="RUN_TABLE_COLUMNS">
        <ui-table-head>
          <span>Started</span>
          <span>Duration</span>
          <span>Result</span>
          <span></span>
        </ui-table-head>

        <batch-job-run-row v-for="batchJobRun of runList" :key="batchJobRun.id" :batch-job-run="batchJobRun" />
      </ui-table>

      <ui-empty v-if="!runsLoading && runList.length === 0">This job hasn't run yet.</ui-empty>

      <div v-if="pages > 1" class="flex justify-end border-t border-divider px-4 py-2.5">
        <ui-pagination v-model:page="page" :page-count="pages" />
      </div>
    </ui-card>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import IconPlayArrow from '~icons/material-symbols/play-arrow-rounded';

import { BatchJobRunResult } from '@libs/dto';

import { DialogType } from '@/types/dialog';

import { useBackLink } from '@/composables/useBackLink';
import { usePagedList } from '@/composables/usePagedList';
import { useResource } from '@/composables/useResource';

import { formatDayTime } from '@/utils/format/date';

import { useLogService } from '@/services/LogService';
import { useBatchJobAdminService } from '@/services/api/admin/BatchJobAdminService';
import { useDialogStore } from '@/stores/dialog';
import { useNotificationStore } from '@/stores/notification';

import BatchJobRunRow from '@/components/batch-job/BatchJobRunRow.vue';
import {
  UiBackLink,
  UiButton,
  UiCard,
  UiEmpty,
  UiPageContainer,
  UiPageHeading,
  UiPagination,
  UiStat,
  UiStatGrid,
  UiSwitchLabel,
  UiTable,
  UiTableHead,
} from '@/components/ui';

type Action = 'state' | 'run';

const RUN_TABLE_COLUMNS = 'minmax(0, 1fr) 7rem 6rem 1.25rem';
const RUN_POLL_MS = 2000;

const logService = useLogService();
const logger = logService.createLogger('pages/loggedin/batch-jobs/BatchJob');

const route = useRoute();

const backLink = useBackLink({ to: '/batch-jobs', label: 'Batch jobs' });

const batchJobAdminService = useBatchJobAdminService();
const dialogStore = useDialogStore();
const notificationStore = useNotificationStore();

const batchJobId = computed(() =>
  typeof route.params.batchJobId === 'string' ? parseInt(route.params.batchJobId, 10) : null
);

const { data: batchJob, reload: reloadBatchJob } = useResource({
  request: batchJobId,
  fetch: (targetId: number) => batchJobAdminService.getBatchJob(targetId),
});

const {
  list: runList,
  page,
  pages,
  loading: runsLoading,
  load: loadRuns,
} = usePagedList({
  request: batchJobId,
  debounceRequest: false,
  fetch: (targetId: number, runPage) =>
    batchJobAdminService
      .getBatchJobRunList(targetId, runPage)
      .then(response => ({ list: response.batchJobRunList, pages: Math.max(response.pages, 1) })),
});

const pending = ref<Action | null>(null);

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let unmounted = false;

const formatOptional = (date: Date | null): string => (date === null ? 'Never' : formatDayTime(date));

// The server only runs a job it registered against a schedule, so Run Now is refused for any other.
const runnable = computed(() => batchJob.value !== null && batchJob.value.cronExpression !== null);

const running = computed(() => runList.value.some(batchJobRun => batchJobRun.result === BatchJobRunResult.RUNNING));

const stopPolling = () => {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
};

const pollWhileRunning = () => {
  stopPolling();

  if (unmounted || !running.value) {
    return;
  }

  pollTimer = setTimeout(() => {
    pollTimer = null;

    void loadRuns().then(pollWhileRunning);
  }, RUN_POLL_MS);
};

// A finished run changes the job's last success or failure, and a failure turns the job off.
watch(running, (isRunning, wasRunning) => {
  if (isRunning) {
    pollWhileRunning();
  } else if (wasRunning) {
    void reloadBatchJob();
  }
});

onUnmounted(() => {
  unmounted = true;
  stopPolling();
});

const doSetEnabled = (enabled: boolean) => {
  if (batchJob.value === null || pending.value !== null) {
    return;
  }

  pending.value = 'state';

  batchJobAdminService
    .updateBatchJobState({ enabled }, batchJob.value.id)
    .then(async () => {
      notificationStore.addToast(enabled ? 'Job enabled' : 'Job disabled');

      await reloadBatchJob();
    })
    .finally(() => {
      pending.value = null;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doSetEnabled(): Failed to change the batch job state');
    });
};

const doRunNow = () => {
  if (batchJob.value === null || pending.value !== null) {
    return;
  }

  const target = batchJob.value;

  void dialogStore.confirm({
    type: DialogType.INFO,
    title: 'Run this job now?',
    message: 'This starts a single run without changing the schedule. Follow its progress under Recent runs.',
    confirmLabel: 'Run Now',
    action: async () => {
      pending.value = 'run';

      try {
        await batchJobAdminService.runBatchJob(target.id);
      } finally {
        pending.value = null;
      }

      await reloadBatchJob();

      if (page.value === 1) {
        await loadRuns();
      } else {
        page.value = 1;
      }
    },
  });
};
</script>
