<template>
  <span
    class="flex size-4 shrink-0 items-center justify-center rounded-md border transition-colors duration-300 group-hover:border-primary peer-focus-visible:border-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary-soft"
    :class="
      props.checked ? 'border-primary bg-primary text-surface' : props.highlighted ? 'border-primary' : 'border-line'
    "
    aria-hidden="true"
  >
    <icon-check v-if="props.checked" class="size-4" />
  </span>
</template>

<script setup lang="ts">
import IconCheck from '~icons/material-symbols/check-rounded';

const props = withDefaults(
  defineProps<{
    checked: boolean;
    highlighted?: boolean;
  }>(),
  {
    highlighted: false,
  }
);
</script>
