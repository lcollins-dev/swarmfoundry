<template>
  <ui-card title="Transcript" subtitle="Agent messages, tool calls and results." flush>
    <template #header-extra>
      <div class="w-49 shrink-0">
        <ui-select v-model:value="filter" :options="FILTER_OPTIONS" aria-label="Event type" />
      </div>
    </template>

    <div class="relative">
      <div
        ref="scrollBox"
        class="max-h-[min(720px,calc(100vh-160px))] overflow-auto overscroll-contain [overflow-anchor:none]"
        data-testid="transcript-scroll"
        @scroll="onScroll"
      >
        <div
          v-if="failed"
          class="flex items-center justify-center gap-2 px-6 py-2.5 text-[13px] text-muted"
          data-testid="transcript-load-failed"
        >
          <span>Could not load transcript events.</span>

          <ui-button type="text" data-testid="transcript-retry" @click="doLoadEarlier">Try again</ui-button>
        </div>

        <div
          v-else-if="loading || hasEarlier"
          class="flex items-center justify-center gap-2 px-6 py-3.5 text-[13px] text-muted"
          data-testid="transcript-loading"
        >
          <ui-spinner :size="16" />

          <span>{{ loaded ? 'Loading earlier events...' : 'Loading events...' }}</span>
        </div>

        <div
          v-else-if="events.length > 0"
          class="px-6 py-3 text-center text-xs text-muted"
          data-testid="transcript-start"
        >
          Start of transcript
        </div>

        <ui-table :columns="COLUMNS" :min-width="820" :scroll="false">
          <ui-table-head sticky>
            <span>When</span>
            <span>Event</span>
            <span>Summary</span>
            <span>Tool</span>
            <span>Agent</span>
            <span></span>
          </ui-table-head>

          <transcript-event-row
            v-for="event of events"
            :key="`${event.lineNumber}-${event.index}`"
            :event="event"
            :start-date="props.run.startDate"
            :tool-name="toolName(event)"
            :agent-name="agentName(event)"
          />
        </ui-table>

        <ui-empty v-if="loaded && !loading && !failed && !hasEarlier && events.length === 0">
          {{ emptyText }}
        </ui-empty>

        <div
          v-if="followFailed"
          class="flex items-center justify-center gap-2 border-t border-divider px-6 py-2.5 text-[13px] text-muted"
          data-testid="transcript-follow-failed"
        >
          <span>Live transcript updates stopped.</span>

          <ui-button type="text" data-testid="transcript-follow-retry" @click="follow">Try again</ui-button>
        </div>

        <div
          v-else-if="!live && loaded && events.length > 0"
          class="border-t border-divider px-6 py-3.5 text-center text-xs text-muted"
          data-testid="transcript-end"
        >
          {{ endText }}
        </div>
      </div>

      <div v-if="awayFromLatest" class="absolute bottom-4 left-1/2 z-3 -translate-x-1/2 rounded-lg bg-popover">
        <ui-button data-testid="transcript-jump" @click="jumpToLatest">
          <template #icon>
            <icon-arrow-downward class="size-4" />
          </template>
          Jump to latest
        </ui-button>
      </div>
    </div>
  </ui-card>
</template>

<script setup lang="ts">
import { computed, PropType, ref, useTemplateRef, watch } from 'vue';
import IconArrowDownward from '~icons/material-symbols/arrow-downward-outline-rounded';

import { RunEndReason, TranscriptEventType, type RunDto, type TranscriptEventDto } from '@libs/dto';

import { type ITranscriptRequest, useTranscript } from '@/composables/useTranscript';

import { subagentName, TRANSCRIPT_EVENT_LABELS } from '@/utils/transcript';

import { useLogService } from '@/services/LogService';
import { useTaskAdminService } from '@/services/api/admin/TaskAdminService';

import TranscriptEventRow from '@/components/transcript/TranscriptEventRow.vue';
import {
  type ISelectOption,
  UiButton,
  UiCard,
  UiEmpty,
  UiSelect,
  UiSpinner,
  UiTable,
  UiTableHead,
} from '@/components/ui';

const ALL_EVENTS = 'all';

type Filter = TranscriptEventType | typeof ALL_EVENTS;

const FILTER_OPTIONS: ISelectOption<Filter>[] = [
  { value: ALL_EVENTS, label: 'All events' },
  ...Object.values(TranscriptEventType).map(type => ({ value: type, label: TRANSCRIPT_EVENT_LABELS[type] })),
];

const COLUMNS = '4.5rem 7.5rem minmax(0, 1fr) 5.5rem 7.5rem 1.25rem';

const NEAR_TOP_PX = 160;
const NEAR_BOTTOM_PX = 80;

const props = defineProps({
  run: {
    type: Object as PropType<RunDto>,
    required: true,
  },
});

const emit = defineEmits<{
  /** The run has ended, so its outcome is ready to read. */
  ended: [];
}>();

const logService = useLogService();
const logger = logService.createLogger('components/transcript/RunTranscript');

const taskAdminService = useTaskAdminService();

const filter = ref<Filter>(ALL_EVENTS);

const live = computed(() => props.run.outcome === null);

// Kept apart from the run, so a refetched run with the same id does not restart the transcript.
const runId = computed(() => props.run.id);

const request = computed<ITranscriptRequest>(() => ({
  runId: runId.value,
  types: filter.value === ALL_EVENTS ? [] : [filter.value],
}));

const { events, loaded, hasEarlier, loading, failed, followFailed, loadEarlier, follow } = useTranscript({
  request,
  fetch: (transcriptRequest, beforeLine) =>
    taskAdminService.getTranscript(transcriptRequest.runId, beforeLine, transcriptRequest.types),
  live,
  follow: (transcriptRequest, afterLine, { onMessage, onStop }) =>
    taskAdminService.followTranscript(
      transcriptRequest.runId,
      afterLine,
      transcriptRequest.types,
      onMessage,
      refusal => {
        logger.error({ refusal }, 'follow(): The transcript stream was refused');
        onStop();
      }
    ),
  onEnd: () => emit('ended'),
});

const toolCalls = computed(
  () =>
    new Map(
      events.value.flatMap((event): [string, { name: string; input: Record<string, unknown> }][] =>
        event.type === TranscriptEventType.TOOL_CALL ? [[event.toolUseId, event]] : []
      )
    )
);

const toolName = (event: TranscriptEventDto): string | null => {
  if (event.type === TranscriptEventType.TOOL_CALL) {
    return event.name;
  }

  return event.type === TranscriptEventType.TOOL_RESULT ? (toolCalls.value.get(event.toolUseId)?.name ?? null) : null;
};

const agentName = (event: TranscriptEventDto): string | null =>
  event.parentToolUseId === null ? null : subagentName(toolCalls.value.get(event.parentToolUseId)?.input);

const emptyText = computed(() => {
  if (filter.value !== ALL_EVENTS) {
    return 'No events match this filter.';
  }

  return live.value ? 'Waiting for the first event.' : 'No transcript was recorded for this run.';
});

const endText = computed(() => {
  switch (props.run.endReason) {
    case RunEndReason.TIMEOUT:
      return 'End of transcript. The step was stopped after reaching its time limit.';
    case RunEndReason.RUNNER_ERROR:
      return 'End of transcript. The runner failed.';
    default:
      return 'End of transcript.';
  }
});

const doLoadEarlier = () => {
  void loadEarlier();
};

const scrollBox = useTemplateRef('scrollBox');

const awayFromLatest = ref(false);

const isAtBottom = (box: HTMLElement): boolean => box.scrollTop + box.clientHeight >= box.scrollHeight - NEAR_BOTTOM_PX;

// Keeps reading while the top stays in view, since a filtered page can hold few events or none.
const loadEarlierNearTop = () => {
  const box = scrollBox.value;

  if (
    box !== null &&
    box.scrollTop < NEAR_TOP_PX &&
    loaded.value &&
    hasEarlier.value &&
    !loading.value &&
    !failed.value
  ) {
    doLoadEarlier();
  }
};

const onScroll = () => {
  if (scrollBox.value !== null) {
    awayFromLatest.value = !isAtBottom(scrollBox.value);
  }

  loadEarlierNearTop();
};

const jumpToLatest = () => {
  scrollBox.value?.scrollTo({ top: scrollBox.value.scrollHeight, behavior: 'smooth' });
};

// Read before the DOM updates, so the post-render watcher can put the view back.
let placement: { scrollHeight: number; scrollTop: number; prepended: boolean; pinned: boolean } | null = null;

watch(
  events,
  (next, previous) => {
    const box = scrollBox.value;

    placement =
      box === null
        ? null
        : {
            scrollHeight: box.scrollHeight,
            scrollTop: box.scrollTop,
            prepended: previous.length > 0 && next.length > 0 && next[0] !== previous[0],
            pinned: previous.length === 0 || isAtBottom(box),
          };
  },
  { flush: 'pre' }
);

// The scroll box turns off the browser's own scroll anchoring, which would shift it a second time.
watch(
  [events, loading],
  () => {
    const box = scrollBox.value;

    if (box === null) {
      return;
    }

    if (placement?.prepended === true) {
      box.scrollTop = box.scrollHeight - placement.scrollHeight + placement.scrollTop;
    } else if (placement?.pinned === true) {
      box.scrollTop = box.scrollHeight;
    }

    placement = null;
    awayFromLatest.value = !isAtBottom(box);

    loadEarlierNearTop();
  },
  { flush: 'post' }
);
</script>
