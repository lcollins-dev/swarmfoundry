import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { sourceWith, triggerWith } from '../../../../test/factories/trigger.factory';
import Index from './Index.vue';

vi.mock('@/services/api/admin/TriggerAdminService', () => ({
  useTriggerAdminService: () => ({
    getTriggerList: () =>
      Promise.resolve({
        triggerList: [
          triggerWith(),
          triggerWith({
            name: 'dependency-audit',
            kind: 'schedule',
            issue: null,
            schedule: { cron: '0 3 * * 1', project: 'group/project' },
            concurrency: 1,
            runningCount: 0,
            queuedCount: 0,
            lastFiredDate: null,
            stats: { ...triggerWith().stats, finishedCount: 1, succeededCount: 1, successRate: 1 },
          }),
        ],
      }),
    getSourceList: () => Promise.resolve({ sourceList: [sourceWith({ lastPoll: null, nextPollDate: null })] }),
  }),
}));

const mountPage = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/triggers');

  const wrapper = mount(Index, { global: { plugins: [router] } });
  await flushPromises();

  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('Triggers page', () => {
  it("shows each trigger's kind, rules, slots, last fire and 7-day success, linked to its page", async () => {
    const wrapper = await mountPage();

    const rows = wrapper.findAll('[data-testid="trigger-row"]');

    expect(rows[0].attributes('href')).toBe('/triggers/implement');
    expect(rows[0].text()).toContain('Issue · workflow::ready');
    expect(rows[0].text()).toContain('1 / 2');
    expect(rows[0].text()).toContain('25 Oct, 14:20');
    expect(rows[0].text()).toContain('75%');
    expect(rows[0].text()).toContain('8 tasks');

    expect(rows[1].text()).toContain('Cron · 0 3 * * 1');
    expect(rows[1].text()).toContain('Never');
    expect(rows[1].text()).toContain('100%');
    expect(rows[1].text()).toContain('1 task');
  });

  it("shows a source that hasn't polled yet", async () => {
    const wrapper = await mountPage();

    expect(wrapper.get('[data-testid="source-last-poll"]').text()).toContain('None since startup');
    expect(wrapper.get('[data-testid="source-next-poll"]').text()).toContain('Polling now');
  });
});
