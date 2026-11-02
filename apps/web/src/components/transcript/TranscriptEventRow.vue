<template>
  <ui-table-row v-model:expanded="expanded" data-testid="transcript-event">
    <span class="font-mono text-xs text-muted" :title="formatDayTime(props.event.storedDate)">{{ offset }}</span>

    <span class="flex">
      <ui-tag :type="eventTagType(props.event)">{{ eventLabel(props.event) }}</ui-tag>
    </span>

    <div
      class="min-w-0 truncate text-[13px] leading-5 text-highlight"
      :class="{ 'font-mono': summary.mono }"
      data-testid="event-summary"
    >
      {{ summary.text }}
    </div>

    <span class="truncate font-mono text-xs text-normal">{{ props.toolName ?? '-' }}</span>

    <span v-if="props.agentName !== null" class="flex min-w-0">
      <ui-tag type="primary">{{ props.agentName }}</ui-tag>
    </span>
    <span v-else class="text-xs text-muted">main</span>

    <span class="flex text-muted">
      <template v-if="expandable">
        <icon-expand-less v-if="expanded" class="size-5" />
        <icon-expand-more v-else class="size-5" />
      </template>
    </span>

    <template v-if="expandable" #detail>
      <div data-testid="event-detail">
        <div
          v-if="detail.prose !== null"
          class="whitespace-pre-wrap wrap-anywhere px-6 py-3 text-sm leading-relaxed text-highlight"
          :class="{ 'border-b border-divider': detail.fields.length > 0 }"
          data-testid="event-prose"
        >
          {{ detail.prose }}
        </div>

        <dl
          v-if="detail.fields.length > 0"
          class="m-0 grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 px-6 py-3"
        >
          <template v-for="[name, value] of detail.fields" :key="name">
            <dt class="text-[13px] leading-5 text-muted">{{ name }}</dt>
            <dd class="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-highlight">{{ value }}</dd>
          </template>
        </dl>

        <ui-code
          v-if="detail.block !== null"
          block
          class="max-h-120 overflow-y-auto"
          :class="{ 'border-t border-divider': detail.prose !== null || detail.fields.length > 0 }"
          :tone="eventErrored(props.event) ? 'error' : 'default'"
        >
          {{ detail.block }}
        </ui-code>
      </div>
    </template>
  </ui-table-row>
</template>

<script setup lang="ts">
import { computed, PropType, ref } from 'vue';
import IconExpandLess from '~icons/material-symbols/expand-less-rounded';
import IconExpandMore from '~icons/material-symbols/expand-more-rounded';

import type { TranscriptEventDto } from '@libs/dto';

import { formatCompactDuration, formatDayTime } from '@/utils/format/date';
import { eventDetail, eventErrored, eventLabel, eventSummary, eventTagType, hasDetail } from '@/utils/transcript';

import { UiCode, UiTableRow, UiTag } from '@/components/ui';

const props = defineProps({
  event: {
    type: Object as PropType<TranscriptEventDto>,
    required: true,
  },
  /** The run's start, which each event's time counts from. */
  startDate: {
    type: Date,
    required: true,
  },
  /** The tool a call uses or a result answers. Null when unknown, such as a result whose call has not loaded. */
  toolName: {
    type: String as PropType<string | null>,
    default: null,
  },
  /** Null for the main agent's event. */
  agentName: {
    type: String as PropType<string | null>,
    default: null,
  },
});

const expanded = ref(false);

const offset = computed(() => formatCompactDuration(props.event.storedDate.getTime() - props.startDate.getTime()));

const summary = computed(() => eventSummary(props.event));

const detail = computed(() => eventDetail(props.event));

const expandable = computed(() => hasDetail(detail.value));
</script>
