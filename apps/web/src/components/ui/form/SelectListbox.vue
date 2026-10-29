<template>
  <ui-popover
    :id="props.id"
    role="listbox"
    class="absolute inset-x-0 top-[calc(100%+4px)] z-50 max-h-66 overflow-y-auto"
    :aria-multiselectable="props.multiple || undefined"
  >
    <div
      v-for="(section, sectionIndex) of sections"
      :key="sectionIndex"
      :role="section.group === null ? 'none' : 'group'"
      :aria-labelledby="section.group === null ? undefined : `${props.id}-group-${sectionIndex}`"
    >
      <div
        v-if="section.group !== null"
        :id="`${props.id}-group-${sectionIndex}`"
        class="select-none px-2.5 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-muted"
        :class="{ 'mt-1 border-t border-divider pt-3': sectionIndex > 0 }"
      >
        {{ section.group }}
      </div>

      <div
        v-for="{ option, index } of section.options"
        :id="optionId(props.id, index)"
        :key="option.value"
        role="option"
        class="flex cursor-pointer select-none gap-2.5 rounded-md px-2.5 py-2 text-sm"
        :class="[
          option.description ? 'items-start' : 'items-center',
          index === props.activeIndex ? 'bg-inset' : undefined,
          isSelected(option) ? 'text-header' : 'text-highlight',
          option.disabled ? 'cursor-not-allowed opacity-40' : undefined,
        ]"
        :aria-selected="isSelected(option)"
        :aria-disabled="option.disabled || undefined"
        @mouseenter="onHover(option, index)"
        @mousedown.prevent
        @click="emit('pick', index)"
      >
        <checkbox-box
          v-if="props.multiple"
          :checked="isSelected(option)"
          :highlighted="index === props.activeIndex && !option.disabled"
          :class="{ 'mt-0.5': option.description }"
        />

        <component
          :is="option.icon"
          v-if="option.icon"
          class="size-4 text-muted"
          :class="{ 'mt-0.5': option.description }"
        />

        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate">{{ option.label }}</span>
          <span v-if="option.description" class="mt-0.5 text-xs leading-snug text-muted">
            {{ option.description }}
          </span>
        </span>

        <icon-check
          v-if="!props.multiple && isSelected(option)"
          class="size-4 text-accent"
          :class="{ 'mt-0.5': option.description }"
        />
      </div>
    </div>

    <div v-if="props.options.length === 0" class="px-2.5 py-2 text-sm text-muted">{{ props.emptyText }}</div>
  </ui-popover>
</template>

<script setup lang="ts" generic="TValue extends string">
import { computed, watch } from 'vue';
import IconCheck from '~icons/material-symbols/check-rounded';

import UiPopover from '../navigation/Popover.vue';
import CheckboxBox from './CheckboxBox.vue';
import { IFlatOption, optionId, sectionsOf } from './selectOptions';

const props = withDefaults(
  defineProps<{
    id: string;
    options: IFlatOption<TValue>[];
    selected: TValue[];
    activeIndex: number;
    multiple?: boolean;
    emptyText?: string;
  }>(),
  {
    multiple: false,
    emptyText: 'No matches',
  }
);

const emit = defineEmits<{
  pick: [index: number];
  activate: [index: number];
}>();

const sections = computed(() => sectionsOf(props.options));

const isSelected = (option: IFlatOption<TValue>) => props.selected.includes(option.value);

const onHover = (option: IFlatOption<TValue>, index: number) => {
  if (option.disabled !== true) {
    emit('activate', index);
  }
};

watch(
  () => props.activeIndex,
  index => {
    document.getElementById(optionId(props.id, index))?.scrollIntoView({ block: 'nearest' });
  },
  { immediate: true, flush: 'post' }
);
</script>
