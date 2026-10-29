<template>
  <router-link
    :to="props.to"
    class="my-px flex h-9 min-h-8 shrink items-center gap-2.5 rounded-lg px-2.5 text-sm outline-hidden transition-colors duration-150"
    :class="
      props.active ? 'bg-emphasis text-header' : 'text-normal hover:bg-inset hover:text-header focus-visible:bg-inset'
    "
    :aria-current="props.active ? 'page' : undefined"
  >
    <component :is="props.icon" v-if="props.icon" class="size-5" :class="props.active ? 'text-accent' : 'text-muted'" />
    {{ props.label }}
  </router-link>
</template>

<script setup lang="ts">
import { type Component, PropType } from 'vue';

const props = defineProps({
  to: {
    type: String,
    required: true,
  },
  label: {
    type: String,
    required: true,
  },
  icon: {
    type: [Object, Function] as PropType<Component>,
    default: undefined,
  },
  active: {
    type: Boolean,
    default: false,
  },
});
</script>
