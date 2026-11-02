<template>
  <ui-table-row :to="`/runs/${props.run.id}`" data-testid="task-run">
    <div class="min-w-0">
      <div class="font-medium text-header">Try {{ props.run.number }}</div>
      <div v-if="props.run.agent !== null" class="mt-0.5 truncate font-mono text-xs text-muted">
        {{ props.run.agent.name }}
      </div>
    </div>

    <div>
      <ui-tag :type="RUN_STATUS_TAG_TYPES[status]">{{ RUN_STATUS_LABELS[status] }}</ui-tag>
      <div v-if="props.run.endReason !== null" class="mt-0.5 text-xs text-muted">
        {{ RUN_END_REASON_LABELS[props.run.endReason] }}
      </div>
    </div>

    <span class="font-mono text-xs">{{ formatDayTime(props.run.startDate) }}</span>

    <span class="font-mono text-xs">{{ formatDuration(spanMs(props.run.startDate, props.run.endDate) ?? 0) }}</span>

    <div>
      <div class="text-highlight">{{ props.run.costUsd === null ? '-' : formatUsd(props.run.costUsd) }}</div>
      <div v-if="tokens !== null" class="font-mono text-xs text-muted">
        {{ formatNumberAbbreviated(tokens) }} tokens
      </div>
    </div>

    <icon-chevron-right class="size-4 text-muted" />
  </ui-table-row>
</template>

<script setup lang="ts">
import { computed, PropType } from 'vue';
import IconChevronRight from '~icons/material-symbols/chevron-right-rounded';

import type { RunDto } from '@libs/dto';

import { formatDayTime, formatDuration } from '@/utils/format/date';
import { formatNumberAbbreviated, formatUsd } from '@/utils/format/number';
import {
  RUN_END_REASON_LABELS,
  RUN_STATUS_LABELS,
  RUN_STATUS_TAG_TYPES,
  runStatus,
  runTotalTokens,
  spanMs,
} from '@/utils/task';

import { UiTableRow, UiTag } from '@/components/ui';

/** Place inside a UiTable with six columns: Try, Outcome, Started, Duration, Usage and the chevron. */
const props = defineProps({
  run: {
    type: Object as PropType<RunDto>,
    required: true,
  },
});

const status = computed(() => runStatus(props.run));

const tokens = computed(() => runTotalTokens(props.run));
</script>
