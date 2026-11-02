import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { listTaskWith } from '../../../../test/factories/task.factory';
import { triggerWith } from '../../../../test/factories/trigger.factory';
import Trigger from './Trigger.vue';

const getTaskList = vi.fn();

vi.mock('@/services/api/admin/TaskAdminService', () => ({
  useTaskAdminService: () => ({ getTaskList }),
}));

const getTriggerList = vi.fn();

vi.mock('@/services/api/admin/TriggerAdminService', () => ({
  useTriggerAdminService: () => ({ getTriggerList }),
}));

const mountPage = async (name: string) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/triggers/:name', component: { template: '<div />' } },
      { path: '/:path(.*)*', component: { template: '<div />' } },
    ],
  });
  await router.push(`/triggers/${name}`);

  const wrapper = mount(Trigger, { global: { plugins: [router] } });
  await flushPromises();

  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());

  getTaskList.mockReset().mockResolvedValue({ taskList: [listTaskWith()], pages: 1, total: 1 });
  getTriggerList.mockResolvedValue({
    triggerList: [
      triggerWith({
        failureSteps: [
          { kind: 'comment', body: 'Deploy with Sup3rDeployPw' },
          { kind: 'relabel', add: ['foundry::failed'], remove: ['foundry::running'] },
          { kind: 'assign', usernames: ['ann'] },
        ],
      }),
    ],
  });
});

describe('Trigger page', () => {
  it('shows its 7-day success, slots, duration and cost as tiles', async () => {
    const wrapper = await mountPage('implement');

    const tile = (testId: string) => wrapper.get(`[data-testid="${testId}"]`).text();

    expect(tile('trigger-success')).toContain('75%');
    expect(tile('trigger-success')).toContain('6 succeeded');
    expect(tile('trigger-success')).toContain('2 failed');
    expect(tile('trigger-running')).toContain('of 2 slots');
    expect(tile('trigger-running')).toContain('1 queued');
    expect(tile('trigger-duration')).toContain('15m 52s');
    expect(tile('trigger-duration')).toContain('/ 2h');
    expect(tile('trigger-duration')).toContain('p90 2h 25m');
    expect(tile('trigger-cost')).toContain('$132.97');
    expect(tile('trigger-cost')).toContain('$71.36 failed');
  });

  it('shows its match rules in plain words', async () => {
    const wrapper = await mountPage('implement');

    const rules = wrapper.findAll('[data-testid="trigger-rule"]').map(rule => rule.text());

    expect(rules).toContain('Has all labelsissue.labelsworkflow::ready');
    expect(rules).toContain('Has none ofissue.notLabelsfoundry::failed');
    expect(rules).toContain('Assigned to any ofissue.anyAssigneefoundry-bot');
  });

  it('lists its recent tasks', async () => {
    const wrapper = await mountPage('implement');

    expect(getTaskList).toHaveBeenCalledWith({ trigger: 'implement' }, 1);
    expect(wrapper.findAll('[data-testid="task-row"]')).toHaveLength(1);
  });

  it('says when the running config has no such trigger', async () => {
    const wrapper = await mountPage('removed');

    expect(wrapper.find('[data-testid="trigger-missing"]').exists()).toBe(true);
    expect(getTaskList).not.toHaveBeenCalled();
  });
});
