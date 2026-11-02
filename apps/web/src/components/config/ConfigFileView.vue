<template>
  <div class="overflow-x-auto bg-inset py-3 font-mono text-xs leading-relaxed" data-testid="config-file">
    <div v-for="(segments, index) of lines" :key="index" class="flex">
      <span class="w-12 shrink-0 select-none pr-4 text-right text-muted">{{ index + 1 }}</span>

      <span class="min-w-0 whitespace-pre-wrap wrap-anywhere pr-4 text-highlight">
        <template v-for="(segment, segmentIndex) of segments" :key="segmentIndex">
          <ui-link v-if="segment.to !== null" :to="segment.to">{{ segment.text }}</ui-link>
          <template v-else>{{ segment.text }}</template>
        </template>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, PropType } from 'vue';

import { type IConfigSegment, configFilePath, configLineSegments } from '@/utils/configFile';
import { triggerPath } from '@/utils/trigger';

import { UiLink } from '@/components/ui';

/** Links each trigger in `triggerNames` to its page, and each path in `filePaths` to the file on this page. */
const props = defineProps({
  content: {
    type: String,
    required: true,
  },
  triggerNames: {
    type: Array as PropType<string[]>,
    default: () => [],
  },
  filePaths: {
    type: Array as PropType<string[]>,
    default: () => [],
  },
});

const lines = computed(() =>
  configLineSegments(props.content, new Set(props.triggerNames), new Set(props.filePaths)).map(segments =>
    // A space keeps a blank line its height.
    segments.length === 0
      ? [{ text: ' ', to: null }]
      : segments.map(segment => ({ text: segment.text, to: segmentTarget(segment) }))
  )
);

function segmentTarget(segment: IConfigSegment): string | null {
  if (segment.trigger !== undefined) {
    return triggerPath(segment.trigger);
  }

  return segment.file === undefined ? null : configFilePath(segment.file);
}
</script>
