<template>
  <ui-link
    v-if="props.to !== undefined"
    :to="props.to"
    :class="[ROW_CLASS, 'text-normal transition-colors duration-150 hover:bg-inset hover:text-normal']"
    unstyled
  >
    <slot />
  </ui-link>

  <div v-else-if="$slots.detail" class="border-b border-divider last:border-b-0">
    <div
      :class="[CELLS_CLASS, 'cursor-pointer transition-colors duration-150 hover:bg-inset']"
      role="button"
      tabindex="0"
      :aria-expanded="expanded"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <slot />
    </div>

    <div v-if="expanded" class="border-t border-divider bg-inset" data-testid="table-row-detail">
      <slot name="detail" />
    </div>
  </div>

  <div v-else :class="ROW_CLASS">
    <slot />
  </div>
</template>

<script setup lang="ts">
import UiLink from '../navigation/Link.vue';

const CELLS_CLASS = 'grid grid-cols-(--table-columns) items-center gap-4 px-6 py-3';
const ROW_CLASS = `${CELLS_CLASS} border-b border-divider last:border-b-0`;

const props = defineProps({
  to: {
    type: String,
    default: undefined,
  },
});

/** With a `detail` slot, a click on the row toggles the detail open beneath it. */
const expanded = defineModel<boolean>('expanded', { default: false });

const toggle = () => {
  expanded.value = !expanded.value;
};
</script>
