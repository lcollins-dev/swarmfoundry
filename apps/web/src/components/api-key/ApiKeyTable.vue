<template>
  <ui-table :columns="TABLE_COLUMNS" :min-width="520">
    <ui-table-head>
      <span>Name</span>
      <span>Created</span>
      <span>Last used</span>
      <span></span>
    </ui-table-head>

    <ui-table-row v-for="apiKey of props.apiKeys" :key="apiKey.id" data-testid="api-key-row">
      <span class="truncate font-medium text-header" data-testid="api-key-name">{{ apiKey.name }}</span>

      <span class="font-mono text-xs" data-testid="api-key-created">{{ formatShortDayTime(apiKey.createdDate) }}</span>

      <span class="font-mono text-xs" data-testid="api-key-last-used">{{
        apiKey.lastUsedDate === null ? 'Never' : formatRelativeDate(apiKey.lastUsedDate)
      }}</span>

      <div class="flex justify-end">
        <ui-button
          type="danger-outline"
          :disabled="props.revokingId !== null && props.revokingId !== apiKey.id"
          :loading="props.revokingId === apiKey.id"
          @click="emit('revoke', apiKey)"
        >
          Revoke
        </ui-button>
      </div>
    </ui-table-row>
  </ui-table>

  <ui-empty v-if="!props.loading && props.apiKeys.length === 0">{{ props.emptyText }}</ui-empty>
</template>

<script setup lang="ts">
import { PropType } from 'vue';

import type { ApiKeyDto } from '@libs/dto';

import { formatRelativeDate, formatShortDayTime } from '@/utils/format/date';

import { UiButton, UiEmpty, UiTable, UiTableHead, UiTableRow } from '@/components/ui';

const TABLE_COLUMNS = 'minmax(0, 1fr) 8rem 7rem 6rem';

const props = defineProps({
  apiKeys: {
    type: Array as PropType<ApiKeyDto[]>,
    required: true,
  },
  loading: {
    type: Boolean,
    default: false,
  },
  revokingId: {
    type: Number as PropType<number | null>,
    default: null,
  },
  emptyText: {
    type: String,
    required: true,
  },
});

const emit = defineEmits<{
  revoke: [apiKey: ApiKeyDto];
}>();
</script>
