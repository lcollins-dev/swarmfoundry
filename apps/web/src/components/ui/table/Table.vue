<template>
  <div class="overflow-x-auto">
    <div class="min-w-160" :style="{ '--table-columns': props.columns }">
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
});
</script>
