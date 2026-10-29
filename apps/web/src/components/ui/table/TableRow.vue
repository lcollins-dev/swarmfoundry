<template>
  <ui-link
    v-if="props.to !== undefined"
    :to="props.to"
    :class="[ROW_CLASS, 'text-normal transition-colors duration-150 hover:bg-inset hover:text-normal']"
    unstyled
  >
    <slot />
  </ui-link>

  <div v-else :class="ROW_CLASS">
    <slot />
  </div>
</template>

<script setup lang="ts">
import UiLink from '../navigation/Link.vue';

const ROW_CLASS =
  'grid grid-cols-(--table-columns) items-center gap-4 border-b border-divider px-4 py-3 last:border-b-0';

const props = defineProps({
  to: {
    type: String,
    default: undefined,
  },
});
</script>
