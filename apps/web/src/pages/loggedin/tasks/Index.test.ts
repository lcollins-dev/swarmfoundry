import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { TaskStatus } from '@libs/dto';

import { listTaskWith } from '../../../../test/factories/task.factory';
import Index from './Index.vue';

const getTaskList = vi.fn();

vi.mock('@/services/api/admin/TaskAdminService', () => ({
  useTaskAdminService: () => ({ getTaskList }),
}));

vi.mock('@/services/api/admin/TriggerAdminService', () => ({
  useTriggerAdminService: () => ({
    getTriggerList: () => Promise.resolve({ triggerList: [{ name: 'implement' }, { name: 'review' }] }),
    getSourceList: () =>
      Promise.resolve({ sourceList: [{ projects: ['group/web', 'group/api'] }, { projects: ['group/api'] }] }),
  }),
}));

const mountPage = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/tasks');

  const wrapper = mount(Index, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();

  return wrapper;
};

type Wrapper = Awaited<ReturnType<typeof mountPage>>;

const pick = async (wrapper: Wrapper, filterLabel: string, optionLabel: string) => {
  await wrapper.get(`[aria-label="${filterLabel}"]`).trigger('click');

  const options = wrapper.findAll('[role="option"]');
  await options.find(option => option.text() === optionLabel)!.trigger('click');
  await flushPromises();

  return options.map(option => option.text());
};

beforeEach(() => {
  setActivePinia(createPinia());

  getTaskList.mockReset().mockResolvedValue({
    taskList: [
      listTaskWith({ status: TaskStatus.FAILED, runCount: 3, endDate: new Date('2026-10-25T09:27:00Z') }),
      listTaskWith({
        id: 1076,
        kind: 'schedule',
        issue: null,
        triggerName: 'dependency-audit',
        status: TaskStatus.QUEUED,
        runCount: 0,
        startDate: null,
        totalTokens: null,
        costUsd: null,
      }),
    ],
    pages: 1,
    total: 2,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Tasks page', () => {
  it("shows each task's subject, trigger, status, step, duration, tokens and cost", async () => {
    const wrapper = await mountPage();

    const rows = wrapper.findAll('[data-testid="task-row"]');

    expect(rows[0].attributes('href')).toBe('/tasks/1080');
    expect(rows[0].text()).toContain('Relabel drops scoped labels');
    expect(rows[0].text()).toContain('group/project#214');
    expect(rows[0].text()).toContain('implement');
    expect(rows[0].text()).toContain('Failed');
    expect(rows[0].text()).toContain('Step 1');
    expect(rows[0].text()).toContain('24 min 0 s');
    expect(rows[0].text()).toContain('1.7M');
    expect(rows[0].text()).toContain('$13.04');

    expect(rows[1].text()).toContain('Scheduled · dependency-audit');
    expect(rows[1].text()).toContain('Scheduled');
    expect(rows[1].text()).toContain('Not started');

    expect(wrapper.get('[data-testid="task-count"]').text()).toBe('2 tasks');
  });

  it('filters by status, trigger and project from the first page', async () => {
    const wrapper = await mountPage();

    expect(getTaskList).toHaveBeenLastCalledWith({}, 1);

    await pick(wrapper, 'Status', 'Failed');

    expect(getTaskList).toHaveBeenLastCalledWith({ status: TaskStatus.FAILED }, 1);

    expect(await pick(wrapper, 'Trigger', 'review')).toEqual(['All triggers', 'implement', 'review']);
    expect(await pick(wrapper, 'Project', 'group/web')).toEqual(['All projects', 'group/api', 'group/web']);

    expect(getTaskList).toHaveBeenLastCalledWith(
      { status: TaskStatus.FAILED, trigger: 'review', project: 'group/web' },
      1
    );
  });
});
