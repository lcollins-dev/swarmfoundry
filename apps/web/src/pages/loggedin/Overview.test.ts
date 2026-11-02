import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { listTaskWith, runWith, taskWith } from '../../../test/factories/task.factory';
import { queuedTaskWith, sourceWith, triggerWith } from '../../../test/factories/trigger.factory';
import Overview from './Overview.vue';

vi.mock('@/services/api/admin/TaskAdminService', () => ({
  useTaskAdminService: () => ({
    getTaskList: () => Promise.resolve({ taskList: [listTaskWith()], pages: 1, total: 1 }),
    getTask: () => Promise.resolve(taskWith({ step: 1, runs: [runWith({ step: 1 })] })),
  }),
}));

const review = triggerWith({
  name: 'review',
  stats: { ...triggerWith().stats, finishedCount: 2, succeededCount: 2, succeededCostUsd: 1, failedCostUsd: 0 },
});

vi.mock('@/services/api/admin/TriggerAdminService', () => ({
  useTriggerAdminService: () => ({
    getTriggerList: () => Promise.resolve({ triggerList: [triggerWith(), review], configSha: taskWith().configSha }),
    getSourceList: () =>
      Promise.resolve({
        sourceList: [
          sourceWith({
            lastPoll: {
              endDate: new Date('2026-10-25T14:31:52Z'),
              succeeded: false,
              error: null,
              failedProjects: [{ project: 'group/gone', error: '404 Not Found' }],
            },
          }),
        ],
      }),
    getQueue: () => Promise.resolve({ queue: [queuedTaskWith(), queuedTaskWith({ id: 1091 })] }),
  }),
}));

const mountPage = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/overview');

  const wrapper = mount(Overview, { global: { plugins: [router] } });
  await flushPromises();

  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('Overview page', () => {
  it('shows running tasks against the slots, with the queue', async () => {
    const wrapper = await mountPage();

    const active = wrapper.get('[data-testid="overview-active"]');

    expect(active.get('[data-testid="kpi-value"]').text()).toBe('1of 4 slots');
    expect(active.text()).toContain('1 running');
    expect(active.text()).toContain('2 queued');
  });

  it('shows 7-day success and cost across triggers', async () => {
    const wrapper = await mountPage();

    const success = wrapper.get('[data-testid="overview-success"]');
    const cost = wrapper.get('[data-testid="overview-cost"]');

    expect(success.get('[data-testid="kpi-value"]').text()).toBe('80%of 10');
    expect(success.text()).toContain('8 succeeded');
    expect(success.text()).toContain('2 failed');
    expect(cost.get('[data-testid="kpi-value"]').text()).toBe('$133.97all triggers');
    expect(cost.text()).toContain('$62.61 ok');
    expect(cost.text()).toContain('$71.36 failed');
  });

  it('counts the triggers', async () => {
    const wrapper = await mountPage();

    expect(wrapper.get('[data-testid="overview-triggers"] [data-testid="kpi-value"]').text()).toBe('2configured');
  });

  it('lists the running tasks and each trigger, linked to their pages', async () => {
    const wrapper = await mountPage();

    expect(wrapper.findAll('[data-testid="running-task-row"]').map(row => row.attributes('href'))).toEqual([
      '/tasks/1080',
    ]);
    expect(wrapper.findAll('[data-testid="overview-trigger"]').map(row => row.attributes('href'))).toEqual([
      '/triggers/implement',
      '/triggers/review',
    ]);
  });
});
