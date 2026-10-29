<template>
  <ui-link
    class="-ml-1.5 -mt-1.5 mb-3.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-inset hover:text-highlight"
    :to="props.to"
    unstyled
  >
    <icon-arrow-back class="size-4" />
    {{ props.label }}
  </ui-link>
</template>

<script setup lang="ts">
import IconArrowBack from '~icons/material-symbols/arrow-back-rounded';

import UiLink from './Link.vue';

const props = defineProps({
  to: {
    type: String,
    required: true,
  },
  label: {
    type: String,
    required: true,
  },
});
</script>
