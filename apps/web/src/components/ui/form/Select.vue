<template>
  <div ref="root" class="relative w-full" :class="$attrs.class">
    <input-box :active="open" :disabled="props.disabled" chevron>
      <!-- The after: overlay spreads the button's hit area over the box's padding and chevron. -->
      <button
        v-bind="triggerAttrs"
        type="button"
        role="combobox"
        class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch bg-transparent text-left outline-hidden after:absolute after:inset-0 disabled:cursor-not-allowed"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :aria-controls="open ? listboxId : undefined"
        :aria-activedescendant="open && activeIndex !== -1 ? optionId(listboxId, activeIndex) : undefined"
        :disabled="props.disabled"
        @click="toggle"
        @keydown="onKeydown"
      >
        <component :is="selected.icon" v-if="selected?.icon" class="size-4 text-muted" />

        <span class="min-w-0 flex-1 truncate" :class="{ 'text-muted': selected === undefined }">
          {{ selected?.label ?? props.placeholder }}
        </span>
      </button>
    </input-box>

    <input v-if="props.name" type="hidden" :name="props.name" :value="value ?? ''" />

    <select-listbox
      v-if="open"
      :id="listboxId"
      :options="options"
      :selected="value === null ? [] : [value]"
      :active-index="activeIndex"
      @pick="pick"
      @activate="activeIndex = $event"
    />
  </div>
</template>

<script setup lang="ts" generic="TValue extends string">
import { computed, useAttrs, useId, useTemplateRef } from 'vue';

import InputBox from './InputBox.vue';
import SelectListbox from './SelectListbox.vue';
import { inputAttrsOf } from './fieldInput';
import { firstEnabledIndex, flattenOptions, optionAt, optionId, SelectOptions } from './selectOptions';
import { useListbox } from './useListbox';

defineOptions({ inheritAttrs: false });

const value = defineModel<TValue | null>('value', { default: null });

const props = withDefaults(
  defineProps<{
    options: SelectOptions<TValue>;
    placeholder?: string;
    disabled?: boolean;
    /** Posts the value with a native form through a hidden input. */
    name?: string;
  }>(),
  {
    placeholder: 'Select...',
    disabled: false,
    name: undefined,
  }
);

const attrs = useAttrs();

const triggerAttrs = computed(() => inputAttrsOf(attrs));

const listboxId = `${useId()}-listbox`;

const options = computed(() => flattenOptions(props.options));

const selectedIndex = computed(() => options.value.findIndex(option => option.value === value.value));

const selected = computed(() => optionAt(options.value, selectedIndex.value));

const pick = (index: number) => {
  const option = optionAt(options.value, index);

  if (option === undefined || option.disabled === true) {
    return;
  }

  value.value = option.value;
  close();
};

const { open, activeIndex, close, toggle, onKeydown } = useListbox({
  root: useTemplateRef('root'),
  options,
  pick,
  startIndex: () =>
    selectedIndex.value !== -1 && options.value[selectedIndex.value].disabled !== true
      ? selectedIndex.value
      : firstEnabledIndex(options.value),
});
</script>
