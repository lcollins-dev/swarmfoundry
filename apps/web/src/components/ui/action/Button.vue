<template>
  <button
    :type="props.nativeType"
    class="relative h-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border text-sm font-medium leading-none outline-hidden transition-colors duration-300 disabled:cursor-not-allowed disabled:opacity-40"
    :class="[TYPE_CLASSES[props.type], props.block ? 'flex w-full' : 'inline-flex', props.square ? 'w-8' : 'px-3']"
    :disabled="props.disabled"
    :aria-busy="props.loading || undefined"
    @click="onClick"
  >
    <span v-if="props.loading || $slots.icon" class="mr-1.5 flex size-4 items-center justify-center">
      <ui-spinner v-if="props.loading" :size="16" type="current" aria-hidden="true" />
      <slot v-else name="icon" />
    </span>

    <slot />
  </button>
</template>

<script setup lang="ts">
import { PropType } from 'vue';

import UiSpinner from '../feedback/Spinner.vue';

type ButtonType = 'primary' | 'outline' | 'text' | 'danger' | 'danger-outline';

const TYPE_CLASSES: Record<ButtonType, string> = {
  outline:
    'border-line bg-transparent text-highlight enabled:hover:border-line-strong enabled:hover:bg-inset enabled:hover:text-header enabled:focus:border-line-strong enabled:focus:bg-inset enabled:focus:text-header enabled:active:bg-emphasis',
  primary:
    'border-primary bg-primary text-on-primary enabled:hover:border-primary-hover enabled:hover:bg-primary-hover enabled:focus:border-primary-hover enabled:focus:bg-primary-hover enabled:active:border-primary-pressed enabled:active:bg-primary-pressed',
  text: 'border-transparent bg-transparent text-highlight enabled:hover:bg-inset enabled:focus:bg-inset enabled:active:bg-emphasis',
  danger:
    'border-error bg-error text-on-danger enabled:hover:brightness-110 enabled:focus-visible:brightness-110 enabled:active:brightness-95',
  'danger-outline':
    'border-error-line bg-transparent text-error enabled:hover:bg-error-soft enabled:focus-visible:bg-error-soft',
};

const props = defineProps({
  type: {
    type: String as PropType<ButtonType>,
    default: 'outline',
  },
  nativeType: {
    type: String as PropType<'button' | 'submit'>,
    default: 'button',
  },
  loading: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  block: {
    type: Boolean,
    default: false,
  },
  square: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

// A loading submit button still submits its form, so submit handlers keep their own loading guard.
const onClick = (event: MouseEvent) => {
  if (!props.loading) {
    emit('click', event);
  }
};
</script>
