<template>
  <div :class="{ 'overflow-x-auto': props.scroll }">
    <div :style="{ '--table-columns': props.columns, minWidth: `${props.minWidth}px` }">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
/** `columns` is a `grid-template-columns` value that UiTableHead and UiTableRow lay their cells out on. */
const props = defineProps({
  columns: {
    type: String,
    required: true,
  },
  minWidth: {
    type: Number,
    default: 640,
  },
  /** False leaves scrolling to a parent, so a sticky head sticks to that parent. */
  scroll: {
    type: Boolean,
    default: true,
  },
});
</script>
