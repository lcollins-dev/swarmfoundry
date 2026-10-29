<template>
  <div>
    <label class="block text-sm font-medium text-highlight" :for="props.for">{{ props.label }}</label>
    <div v-if="props.help" :id="props.helpId" class="mt-0.5 text-xs leading-snug text-muted">{{ props.help }}</div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps({
  label: {
    type: String,
    required: true,
  },
  help: {
    type: String,
    default: undefined,
  },
  for: {
    type: String,
    default: undefined,
  },
  helpId: {
    type: String,
    default: undefined,
  },
});
</script>
