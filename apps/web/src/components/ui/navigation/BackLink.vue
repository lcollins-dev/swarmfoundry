<template>
  <a
    class="-ml-1.5 -mt-1.5 mb-3.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-inset hover:text-highlight"
    :href="href"
    @click="onClick"
  >
    <icon-arrow-back class="size-4" />
    {{ props.label }}
  </a>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import IconArrowBack from '~icons/material-symbols/arrow-back-rounded';

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

const router = useRouter();

const href = computed(() => router.resolve(props.to).href);

// Steps back through history when the link leads to the previous page, so that page keeps its scroll and no loop
// of entries builds up. A modified click is left to the browser, to open a new tab.
const onClick = (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }

  event.preventDefault();

  if (router.options.history.state.back === props.to) {
    router.back();

    return;
  }

  router.push(props.to).catch(() => undefined);
};
</script>
