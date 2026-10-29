<template>
  <ui-page-container wide>
    <ui-page-heading title="Users" subtitle="Everyone with an account on this system.">
      <ui-link to="/admin/users/create" unstyled>
        <ui-button type="primary">
          <template #icon>
            <icon-add class="size-4" />
          </template>
          New User
        </ui-button>
      </ui-link>
    </ui-page-heading>

    <ui-card flush>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-divider px-4 py-3">
        <div class="max-w-xs shrink grow basis-56">
          <ui-input
            v-model:value="search"
            placeholder="Search name or email"
            aria-label="Search name or email"
            clearable
          />
        </div>

        <div class="grow"></div>

        <ui-segmented-control v-model:value="status" :options="STATUS_OPTIONS" />
      </div>

      <ui-table :columns="TABLE_COLUMNS">
        <ui-table-head>
          <span>Account</span>
          <span>Access</span>
          <span>Created</span>
          <span>Last active</span>
          <span></span>
        </ui-table-head>

        <ui-table-row v-for="user of userList" :key="user.id" :to="`/admin/users/${user.id}`" data-testid="user-row">
          <div class="flex min-w-0 items-center gap-3">
            <user-avatar :user="user" />

            <div class="min-w-0">
              <div class="truncate font-medium text-header">{{ user.name }}</div>
              <div class="truncate text-xs text-muted">{{ user.email }}</div>
            </div>
          </div>

          <div class="flex gap-1.5">
            <user-access-tag :user="user" />
            <ui-tag :type="user.enabled ? 'success' : 'error'">{{ user.enabled ? 'Enabled' : 'Disabled' }}</ui-tag>
          </div>

          <span class="text-xs">{{ formatDay(user.createdDate) }}</span>
          <span class="text-xs">{{ formatDay(user.lastAccess) }}</span>

          <icon-chevron-right class="size-4 text-muted" />
        </ui-table-row>
      </ui-table>

      <ui-empty v-if="!loading && userList.length === 0">No accounts match your search.</ui-empty>

      <div class="flex items-center justify-between gap-3 border-t border-divider px-4 py-2.5 text-xs text-muted">
        <span data-testid="user-count">Showing {{ total }} of {{ allAccounts }} accounts</span>

        <ui-pagination v-if="pages > 1" v-model:page="page" :page-count="pages" />
      </div>
    </ui-card>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import IconAdd from '~icons/material-symbols/add-rounded';
import IconChevronRight from '~icons/material-symbols/chevron-right-rounded';

import type { UserListRequestDto } from '@libs/dto';
import { UserListStatus } from '@libs/dto';

import { usePagedList } from '@/composables/usePagedList';

import { formatDay } from '@/utils/format/date';

import { useLogService } from '@/services/LogService';
import { useUserAdminService } from '@/services/api/admin/UserAdminService';

import {
  type ISegmentedControlOption,
  UiButton,
  UiCard,
  UiEmpty,
  UiInput,
  UiLink,
  UiPageContainer,
  UiPageHeading,
  UiPagination,
  UiSegmentedControl,
  UiTable,
  UiTableHead,
  UiTableRow,
  UiTag,
} from '@/components/ui';
import UserAccessTag from '@/components/user/UserAccessTag.vue';
import UserAvatar from '@/components/user/UserAvatar.vue';

const TABLE_COLUMNS = 'minmax(0, 1fr) 9rem 7rem 7rem 1.25rem';

const STATUS_OPTIONS: ISegmentedControlOption<UserListStatus>[] = [
  { value: UserListStatus.ALL, label: 'Any state' },
  { value: UserListStatus.ENABLED, label: 'Enabled' },
  { value: UserListStatus.DISABLED, label: 'Disabled' },
];

const logService = useLogService();
const logger = logService.createLogger('pages/loggedin/admin/users/Index');

const userAdminService = useUserAdminService();

const search = ref('');
const status = ref(UserListStatus.ALL);
const allAccounts = ref(0);

const listRequest = computed<UserListRequestDto>(() => ({ search: search.value.trim(), status: status.value }));

const {
  list: userList,
  page,
  pages,
  total,
  loading,
} = usePagedList({
  request: listRequest,
  fetch: (request, listPage) =>
    userAdminService
      .getUserList(request, listPage)
      .then(response => ({ list: response.userList, pages: Math.max(response.pages, 1), total: response.total })),
});

const doGetStats = () => {
  userAdminService
    .getUserStats()
    .then(stats => {
      allAccounts.value = stats.total;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doGetStats(): Failed to read the user stats');
    });
};

doGetStats();
</script>
