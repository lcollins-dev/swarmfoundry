<template>
  <div :class="{ 'sticky top-0 z-2 bg-surface': props.sticky }">
    <div
      class="grid grid-cols-(--table-columns) items-center gap-4 border-b border-divider bg-inset px-6 py-2 text-xs font-medium uppercase tracking-wider text-muted"
    >
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps({
  /** Sticks to the top of a scrolling parent. The table needs `scroll` off for it to reach that parent. */
  sticky: {
    type: Boolean,
    default: false,
  },
});
</script>
