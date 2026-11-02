<template>
  <ui-page-container>
    <ui-page-heading v-if="task && subject" :title="subject.title" :back-to="backLink.to" :back-label="backLink.label">
      <template #tags>
        <ui-tag :type="TASK_STATUS_TAG_TYPES[task.status]" data-testid="task-status">
          {{ TASK_STATUS_LABELS[task.status] }}
        </ui-tag>
      </template>

      <template #subtitle>{{ subject.reference }} · Task {{ task.id }}</template>

      <ui-link v-if="subject.url !== null" :to="subject.url" external target="_blank" unstyled>
        <ui-button>
          <template #icon>
            <icon-open-in-new class="size-4" />
          </template>
          Open in GitLab
        </ui-button>
      </ui-link>
    </ui-page-heading>

    <ui-back-link v-else :to="backLink.to" :label="backLink.label" />

    <template v-if="task">
      <ui-notice v-if="task.status === TaskStatus.FAILED" type="error" title="Task failed" data-testid="task-failure">
        {{ failedRun?.error ?? 'No run recorded an error.' }}
      </ui-notice>

      <ui-notice v-else-if="task.status === TaskStatus.CANCELLED" type="warning" title="Cancelled">
        {{ task.cancelReason ?? 'No reason was recorded.' }}
      </ui-notice>

      <ui-card title="Triggered by">
        <ui-stat-grid v-if="task.kind === 'issue'">
          <ui-stat label="Issue" mono>
            <ui-link v-if="task.issue" :to="task.issue.url" external target="_blank">#{{ task.issue.iid }}</ui-link>
            <span v-else>-</span>
          </ui-stat>
          <ui-stat label="Author" mono>{{ task.matchedIssue?.author ?? '-' }}</ui-stat>
          <ui-stat label="Assignees" mono>{{ formatList(task.matchedIssue?.assignees) }}</ui-stat>

          <ui-stat label="Change">{{ task.change ? CHANGE_LABELS[task.change.kind] : '-' }}</ui-stat>
          <ui-stat label="Changed by" mono>{{ task.change?.actor ?? '-' }}</ui-stat>
          <ui-stat label="Matched" mono>{{ task.change ? formatDayTime(task.change.date) : '-' }}</ui-stat>

          <ui-stat label="Labels when matched">
            <span v-if="task.matchedIssue && task.matchedIssue.labels.length > 0" class="flex flex-wrap gap-1.5">
              <ui-code v-for="label of task.matchedIssue.labels" :key="label" emphasis>{{ label }}</ui-code>
            </span>
            <span v-else class="font-mono">-</span>
          </ui-stat>
          <ui-stat label="Project" mono>
            <ui-link :to="task.projectUrl" external target="_blank">{{ task.projectPath }}</ui-link>
          </ui-stat>
        </ui-stat-grid>

        <ui-stat-grid v-else-if="task.kind === 'mergeRequest'">
          <ui-stat label="Merge request" mono>
            <ui-link v-if="task.mergeRequest" :to="task.mergeRequest.url" external target="_blank">
              !{{ task.mergeRequest.iid }}
            </ui-link>
            <span v-else>-</span>
          </ui-stat>
          <ui-stat label="Event">
            {{ task.mergeRequest ? MERGE_REQUEST_EVENT_LABELS[task.mergeRequest.event] : '-' }}
          </ui-stat>
          <ui-stat label="Branches" mono>
            {{ task.mergeRequest ? `${task.mergeRequest.sourceBranch} → ${task.mergeRequest.targetBranch}` : '-' }}
          </ui-stat>

          <ui-stat label="Related issue" mono>
            <ui-link v-if="task.issue" :to="task.issue.url" external target="_blank">#{{ task.issue.iid }}</ui-link>
            <span v-else>None</span>
          </ui-stat>
          <ui-stat label="Matched" mono>{{ formatDayTime(task.queuedDate) }}</ui-stat>
          <ui-stat label="Project" mono>
            <ui-link :to="task.projectUrl" external target="_blank">{{ task.projectPath }}</ui-link>
          </ui-stat>
        </ui-stat-grid>

        <ui-stat-grid v-else>
          <ui-stat label="Schedule" mono>{{ task.cron ?? '-' }}</ui-stat>
          <ui-stat label="Fired" mono>{{ task.fireTime ? formatDayTime(task.fireTime) : '-' }}</ui-stat>
          <ui-stat label="Project" mono>
            <ui-link :to="task.projectUrl" external target="_blank">{{ task.projectPath }}</ui-link>
          </ui-stat>
        </ui-stat-grid>
      </ui-card>

      <ui-card title="Task">
        <ui-stat-grid>
          <ui-stat label="Trigger" mono>{{ task.triggerName }}</ui-stat>
          <ui-stat label="Queued" mono>{{ formatDayTime(task.queuedDate) }}</ui-stat>
          <ui-stat label="Started" mono>{{ task.startDate ? formatDayTime(task.startDate) : 'Not started' }}</ui-stat>

          <ui-stat label="Duration" mono>{{ duration }}</ui-stat>
          <ui-stat label="Config revision" mono>{{ task.configSha?.slice(0, 8) ?? '-' }}</ui-stat>
          <ui-stat label="Tokens" mono>
            {{ task.totalTokens === null ? '-' : formatNumberAbbreviated(task.totalTokens) }}
          </ui-stat>

          <ui-stat label="API cost" mono>{{ task.costUsd === null ? '-' : formatUsd(task.costUsd) }}</ui-stat>
        </ui-stat-grid>
      </ui-card>

      <ui-card title="Runs" flush>
        <ui-table :columns="RUN_TABLE_COLUMNS">
          <ui-table-head>
            <span>Try</span>
            <span>Outcome</span>
            <span>Started</span>
            <span>Duration</span>
            <span>Usage</span>
            <span></span>
          </ui-table-head>

          <template v-for="group of stepGroups" :key="`${group.list}-${group.step}`">
            <div
              class="border-b border-divider bg-inset px-4 py-1.5 text-xs font-medium text-highlight"
              data-testid="step-group"
            >
              {{ stepLabel(group.list, group.step) }}
            </div>

            <task-run-row v-for="run of group.runs" :key="run.id" :run="run" />
          </template>
        </ui-table>

        <ui-empty v-if="task.runs.length === 0">This task hasn't run yet.</ui-empty>
      </ui-card>
    </template>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import IconOpenInNew from '~icons/material-symbols/open-in-new-outline-rounded';

import { RunOutcome, StepList, TaskStatus } from '@libs/dto';

import { useBackLink } from '@/composables/useBackLink';
import { useResource } from '@/composables/useResource';

import { formatDayTime, formatDuration } from '@/utils/format/date';
import { formatNumberAbbreviated, formatUsd } from '@/utils/format/number';
import {
  TASK_STATUS_LABELS,
  TASK_STATUS_TAG_TYPES,
  groupRunsByStep,
  spanMs,
  stepLabel,
  taskSubject,
} from '@/utils/task';

import { useTaskAdminService } from '@/services/api/admin/TaskAdminService';

import TaskRunRow from '@/components/task/TaskRunRow.vue';
import {
  UiBackLink,
  UiButton,
  UiCard,
  UiCode,
  UiEmpty,
  UiLink,
  UiNotice,
  UiPageContainer,
  UiPageHeading,
  UiStat,
  UiStatGrid,
  UiTable,
  UiTableHead,
  UiTag,
} from '@/components/ui';

const RUN_TABLE_COLUMNS = 'minmax(0, 1fr) 7rem 9.5rem 6rem 8rem 1.25rem';

const CHANGE_LABELS: Record<'label' | 'assignment', string> = { label: 'Labelled', assignment: 'Assigned' };

const MERGE_REQUEST_EVENT_LABELS: Record<'opened' | 'merged', string> = { opened: 'Opened', merged: 'Merged' };

const route = useRoute();

const backLink = useBackLink({ to: '/tasks', label: 'Tasks' });

const taskAdminService = useTaskAdminService();

const taskId = computed(() => (typeof route.params.taskId === 'string' ? parseInt(route.params.taskId, 10) : null));

const { data: task } = useResource({
  request: taskId,
  fetch: (targetId: number) => taskAdminService.getTask(targetId),
  live: true,
});

const subject = computed(() => (task.value === null ? null : taskSubject(task.value)));

const stepGroups = computed(() => groupRunsByStep(task.value?.runs ?? []));

const duration = computed(() => {
  const span = task.value === null ? null : spanMs(task.value.startDate, task.value.endDate);

  return span === null ? '-' : formatDuration(span);
});

/** The last try of a main step that failed, which failed the task. */
const failedRun = computed(() =>
  [...(task.value?.runs ?? [])].reverse().find(run => run.list === StepList.STEPS && run.outcome === RunOutcome.FAILED)
);

const formatList = (values: string[] | undefined): string =>
  values === undefined || values.length === 0 ? '-' : values.join(', ');
</script>
