<template>
  <ui-table-row :class="{ 'cursor-pointer': expandable }" data-testid="job-run" @click="toggle">
    <span class="font-mono text-xs">{{ formatDayTime(props.batchJobRun.startDate) }}</span>

    <span class="font-mono text-xs">{{ duration }}</span>

    <div>
      <ui-tag :type="JOB_RUN_RESULT_TAG_TYPES[props.batchJobRun.result]">
        {{ JOB_RUN_RESULT_LABELS[props.batchJobRun.result] }}
      </ui-tag>
    </div>

    <button
      v-if="expandable"
      type="button"
      class="inline-flex text-muted"
      :aria-expanded="expanded"
      aria-label="Show the error"
      @click.stop="toggle"
    >
      <icon-expand-more v-if="expanded" class="size-4" />
      <icon-chevron-right v-else class="size-4" />
    </button>

    <span v-else></span>

    <div v-if="expanded" class="col-span-full -mx-4 -mb-3 cursor-text border-t border-divider" @click.stop>
      <ui-code block tone="error" data-testid="job-run-error">{{ props.batchJobRun.error }}</ui-code>
    </div>
  </ui-table-row>
</template>

<script setup lang="ts">
import { computed, PropType, ref } from 'vue';
import IconChevronRight from '~icons/material-symbols/chevron-right-rounded';
import IconExpandMore from '~icons/material-symbols/expand-more-rounded';

import type { BatchJobRunDto } from '@libs/dto';

import { formatDayTime, formatDuration } from '@/utils/format/date';
import { JOB_RUN_RESULT_LABELS, JOB_RUN_RESULT_TAG_TYPES } from '@/utils/jobResult';

import { UiCode, UiTableRow, UiTag } from '@/components/ui';

/** Place inside a UiTable with four columns: Started, Duration, Result and the toggle. */
const props = defineProps({
  batchJobRun: {
    type: Object as PropType<BatchJobRunDto>,
    required: true,
  },
});

const expanded = ref(false);

const expandable = computed(() => props.batchJobRun.error !== null);

const duration = computed(() =>
  props.batchJobRun.endDate === null
    ? '-'
    : formatDuration(props.batchJobRun.endDate.getTime() - props.batchJobRun.startDate.getTime())
);

const toggle = () => {
  if (expandable.value) {
    expanded.value = !expanded.value;
  }
};
</script>
