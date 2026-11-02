<template>
  <div class="overflow-hidden rounded-lg border border-divider bg-inset">
    <div class="flex items-center gap-3 border-b border-divider py-1.5 pl-3 pr-1.5">
      <span class="min-w-0 flex-1 text-xs font-medium uppercase tracking-wider text-muted">{{ props.label }}</span>

      <ui-copy-button
        :value="props.value"
        failure-content="Your browser blocked clipboard access. The text is selected for you to copy by hand."
        @failed="selectValue"
      />
    </div>

    <div ref="valueElement">
      <ui-code block :data-testid="props.valueTestId">{{ props.value }}</ui-code>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useTemplateRef } from 'vue';

import UiCopyButton from '../action/CopyButton.vue';
import UiCode from './Code.vue';

const props = defineProps({
  value: {
    type: String,
    required: true,
  },
  label: {
    type: String,
    required: true,
  },
  valueTestId: {
    type: String,
    default: undefined,
  },
});

const valueElement = useTemplateRef('valueElement');

const selectValue = () => {
  if (valueElement.value !== null) {
    window.getSelection()?.selectAllChildren(valueElement.value);
  }
};
</script>
