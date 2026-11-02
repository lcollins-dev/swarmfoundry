import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

import { RunOutcome, TaskStatus } from '@libs/dto';

import { listTaskWith, runWith, taskWith } from '../../test/factories/task.factory';
import { useRunningTasks } from './useRunningTasks';

const getTaskList = vi.fn();
const getTask = vi.fn();

vi.mock('@/services/api/admin/TaskAdminService', () => ({
  useTaskAdminService: () => ({ getTaskList, getTask }),
}));

beforeEach(() => {
  setActivePinia(createPinia());
  getTaskList.mockReset();
  getTask.mockReset();
});

describe('useRunningTasks', () => {
  it('reads every page of running tasks, and each task for its run in progress', async () => {
    getTaskList
      .mockResolvedValueOnce({ taskList: [listTaskWith({ id: 1 })], pages: 2, total: 2 })
      .mockResolvedValueOnce({ taskList: [listTaskWith({ id: 2 })], pages: 2, total: 2 });

    const finished = runWith({ id: 10, outcome: RunOutcome.FAILED, endDate: new Date('2026-10-25T09:10:00Z') });
    const current = runWith({ id: 11, number: 2 });

    getTask.mockImplementation((taskId: number) =>
      Promise.resolve(taskWith({ id: taskId, runs: taskId === 1 ? [finished, current] : [finished] }))
    );

    const scope = effectScope();
    const { data } = scope.run(() => useRunningTasks())!;
    await flushPromises();

    expect(getTaskList).toHaveBeenCalledWith({ status: TaskStatus.RUNNING }, 1);
    expect(getTaskList).toHaveBeenCalledWith({ status: TaskStatus.RUNNING }, 2);
    expect(data.value?.map(({ task, run }) => [task.id, run?.id ?? null])).toEqual([
      [1, 11],
      [2, null],
    ]);

    scope.stop();

    scope.stop();
  });
});
