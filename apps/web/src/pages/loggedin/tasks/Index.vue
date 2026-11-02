<template>
  <ui-page-container wide>
    <ui-page-heading title="Tasks" subtitle="Work started by your triggers." />

    <ui-card flush>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-divider px-4 py-3">
        <div class="w-48">
          <ui-select v-model:value="trigger" :options="triggerOptions" aria-label="Trigger" />
        </div>

        <div class="w-40">
          <ui-select v-model:value="status" :options="STATUS_OPTIONS" aria-label="Status" />
        </div>

        <div class="w-56">
          <ui-select v-model:value="project" :options="projectOptions" aria-label="Project" />
        </div>
      </div>

      <task-table :tasks="taskList" />

      <ui-empty v-if="!loading && taskList.length === 0">No tasks match these filters.</ui-empty>

      <div class="flex items-center justify-between gap-3 border-t border-divider px-4 py-2.5 text-xs text-muted">
        <span data-testid="task-count">{{ formatTaskCount(page, pages, taskList.length, total) }}</span>

        <ui-pagination v-if="pages > 1" v-model:page="page" :page-count="pages" />
      </div>
    </ui-card>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { TaskStatus } from '@libs/dto';

import { usePagedList } from '@/composables/usePagedList';
import { useResource } from '@/composables/useResource';

import { TASK_STATUS_LABELS, formatTaskCount } from '@/utils/task';

import { type TaskListFilter, useTaskAdminService } from '@/services/api/admin/TaskAdminService';
import { useTriggerAdminService } from '@/services/api/admin/TriggerAdminService';

import TaskTable from '@/components/task/TaskTable.vue';
import {
  type ISelectOption,
  UiCard,
  UiEmpty,
  UiPageContainer,
  UiPageHeading,
  UiPagination,
  UiSelect,
} from '@/components/ui';

// A select needs a string for its "any" choice, and no trigger, status or project path is empty.
const ANY = '';

const STATUS_OPTIONS: ISelectOption<TaskStatus | typeof ANY>[] = [
  { value: ANY, label: 'Any status' },
  ...Object.values(TaskStatus).map(value => ({ value, label: TASK_STATUS_LABELS[value] })),
];

const taskAdminService = useTaskAdminService();
const triggerAdminService = useTriggerAdminService();

const trigger = ref<string>(ANY);
const status = ref<TaskStatus | typeof ANY>(ANY);
const project = ref<string>(ANY);

const { data: triggerNames } = useResource({
  request: {},
  fetch: () => triggerAdminService.getTriggerList().then(response => response.triggerList.map(listed => listed.name)),
});

const { data: projectPaths } = useResource({
  request: {},
  fetch: () =>
    triggerAdminService
      .getSourceList()
      .then(response => [...new Set(response.sourceList.flatMap(source => source.projects))].sort()),
});

const triggerOptions = computed<ISelectOption<string>[]>(() => [
  { value: ANY, label: 'All triggers' },
  ...(triggerNames.value ?? []).map(name => ({ value: name, label: name })),
]);

const projectOptions = computed<ISelectOption<string>[]>(() => [
  { value: ANY, label: 'All projects' },
  ...(projectPaths.value ?? []).map(path => ({ value: path, label: path })),
]);

const filter = computed<TaskListFilter>(() => ({
  trigger: trigger.value === ANY ? undefined : trigger.value,
  status: status.value === ANY ? undefined : status.value,
  project: project.value === ANY ? undefined : project.value,
}));

const {
  list: taskList,
  page,
  pages,
  total,
  loading,
} = usePagedList({
  request: filter,
  debounceRequest: false,
  fetch: (request, listPage) =>
    taskAdminService
      .getTaskList(request, listPage)
      .then(response => ({ list: response.taskList, pages: Math.max(response.pages, 1), total: response.total })),
  live: true,
});
</script>
