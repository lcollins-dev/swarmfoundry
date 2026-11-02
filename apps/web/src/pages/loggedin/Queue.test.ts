import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { StepList } from '@libs/dto';

import { START_DATE, listTaskWith, runWith, taskWith } from '../../../test/factories/task.factory';
import { queuedTaskWith, triggerWith } from '../../../test/factories/trigger.factory';
import Queue from './Queue.vue';

const getTaskList = vi.fn();
const getTask = vi.fn();
const getQueue = vi.fn();
const getTriggerList = vi.fn();

vi.mock('@/services/api/admin/TaskAdminService', () => ({
  useTaskAdminService: () => ({ getTaskList, getTask }),
}));

vi.mock('@/services/api/admin/TriggerAdminService', () => ({
  useTriggerAdminService: () => ({
    getTriggerList,
    getQueue,
  }),
}));

const mountPage = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/queue');

  const wrapper = mount(Queue, { global: { plugins: [router] } });
  await flushPromises();

  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(START_DATE.getTime() + 38 * 60_000 + 11_000));

  getTriggerList.mockResolvedValue({ triggerList: [triggerWith()], configSha: taskWith().configSha });
  getTaskList.mockResolvedValue({ taskList: [listTaskWith(), listTaskWith({ id: 1081 })], pages: 1, total: 2 });
  getTask.mockImplementation((taskId: number) =>
    Promise.resolve(
      taskId === 1080
        ? taskWith({ step: 1, runs: [runWith({ step: 1 })] })
        : taskWith({ id: 1081, list: StepList.FAILURE_STEPS, step: 0, runs: [] })
    )
  );
  getQueue.mockResolvedValue({
    queue: [
      queuedTaskWith({ id: 1090 }),
      queuedTaskWith({ id: 1091, wait: { reason: 'heldBack', until: new Date(2026, 9, 25, 14, 5) } }),
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Queue page', () => {
  it("shows each running task's current run against its step's timeout, linked to its task", async () => {
    const wrapper = await mountPage();

    const rows = wrapper.findAll('[data-testid="running-task-row"]');

    expect(rows[0].attributes('href')).toBe('/tasks/1080');
    expect(rows[0].text()).toContain('Step 2 · Agent');
    expect(rows[0].get('[data-testid="running-task-elapsed"]').text()).toBe('38 min 11 s / 2 h 0 min');
    expect(rows[0].get('[role="meter"]').attributes('aria-valuenow')).toBe(String((38 * 60 + 11) / 7200));

    expect(rows[1].attributes('href')).toBe('/tasks/1081');
    expect(rows[1].text()).toContain('Failure step 1 · Comment');
    expect(rows[1].get('[data-testid="running-task-elapsed"]').text()).toBe('Between runs');
  });

  it('reports an overdue run as full on its meter', async () => {
    vi.setSystemTime(new Date(START_DATE.getTime() + 3 * 3_600_000));

    const wrapper = await mountPage();

    const row = wrapper.findAll('[data-testid="running-task-row"]')[0];

    expect(row.get('[role="meter"]').attributes('aria-valuenow')).toBe('1');
  });

  it('leaves out the step kind and timeout for a task pinned to an older config revision', async () => {
    getTriggerList.mockResolvedValue({ triggerList: [triggerWith()], configSha: 'b52d0f3e'.padEnd(40, '0') });

    const wrapper = await mountPage();

    const row = wrapper.findAll('[data-testid="running-task-row"]')[0];

    expect(row.text()).toContain('Step 2');
    expect(row.text()).not.toContain('Agent');
    expect(row.get('[data-testid="running-task-elapsed"]').text()).toBe('38 min 11 s · older config');
    expect(row.find('[role="meter"]').exists()).toBe(false);
  });

  it('shows each queued task with what it waits for, in start order', async () => {
    const wrapper = await mountPage();

    const rows = wrapper.findAll('[data-testid="queued-task-row"]');

    expect(rows.map(row => row.attributes('href'))).toEqual(['/tasks/1090', '/tasks/1091']);
    expect(rows.map(row => row.get('[data-testid="queued-task-wait"]').text())).toEqual([
      'No free slot · implement 2/2',
      'Held back · 25 Oct, 14:05',
    ]);
    expect(wrapper.findAll('[data-testid="running-task-row"]')).toHaveLength(2);
  });
});
