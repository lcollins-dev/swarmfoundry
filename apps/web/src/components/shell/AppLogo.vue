<template>
  <span class="inline-flex items-center gap-2 text-header">
    <img src="/favicon.svg" alt="" class="shrink-0" :class="props.size === 'lg' ? 'size-10' : 'size-6'" />

    <span class="font-semibold" :class="props.size === 'lg' ? 'text-xl' : 'text-base'">{{ Config.APP_NAME }}</span>
  </span>
</template>

<script setup lang="ts">
import { PropType } from 'vue';

import { Config } from '@/Config';

const props = defineProps({
  size: {
    type: String as PropType<'md' | 'lg'>,
    default: 'md',
  },
});
</script>
