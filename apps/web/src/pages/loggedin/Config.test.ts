import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import Config from './Config.vue';

const getConfig = vi.fn();

vi.mock('@/services/api/admin/ConfigAdminService', () => ({
  useConfigAdminService: () => ({ getConfig }),
}));

vi.mock('@/services/api/admin/TriggerAdminService', () => ({
  useTriggerAdminService: () => ({
    getTriggerList: () => Promise.resolve({ triggerList: [{ name: 'implement' }] }),
  }),
}));

const CONFIG_FILE = `triggers:
  implement:
    steps:
      - agent:
          prompt: ./prompts/implement/prompt.md`;

const mountPage = async (path: string) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)*', component: { template: '<div />' } }],
  });
  await router.push(path);

  const wrapper = mount(Config, { global: { plugins: [router] } });
  await flushPromises();

  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());

  getConfig.mockResolvedValue({
    sha: 'a41c9e2f00000000000000000000000000000000',
    currentDate: new Date(2026, 9, 25, 14, 0),
    files: [
      { path: 'swarmfoundry.yaml', content: CONFIG_FILE },
      { path: 'prompts/implement/prompt.md', content: 'Implement {{issue.title}}.' },
    ],
  });
});

describe('Config page', () => {
  it('shows the config read-only at the running revision, linking each trigger and referenced file', async () => {
    const wrapper = await mountPage('/config');

    expect(wrapper.text()).toContain('Read-only');
    expect(wrapper.text()).toContain('Revision a41c9e2f · 25 Oct, 14:00');

    const file = wrapper.get('[data-testid="config-file"]');
    const links = file.findAll('a').map(link => [link.text(), link.attributes('href')]);

    expect(links).toEqual([
      ['implement', '/triggers/implement'],
      ['./prompts/implement/prompt.md', '/config?file=prompts%2Fimplement%2Fprompt.md'],
    ]);
    expect(wrapper.findAll('[data-testid="config-referenced-file"]').map(row => row.text())).toEqual([
      'prompts/implement/prompt.md',
    ]);
  });

  it('shows a referenced file by the path in its URL', async () => {
    const wrapper = await mountPage('/config?file=prompts%2Fimplement%2Fprompt.md');

    expect(wrapper.get('[data-testid="config-selected-file"]').text()).toContain('Implement {{issue.title}}.');
  });

  it('says when the URL names a file the config does not serve', async () => {
    const wrapper = await mountPage('/config?file=.env');

    expect(wrapper.find('[data-testid="config-file-missing"]').exists()).toBe(true);
  });

  it('says a local config file was loaded at startup', async () => {
    getConfig.mockResolvedValue({ sha: null, currentDate: null, files: [{ path: 'swarmfoundry.yaml', content: '' }] });

    const wrapper = await mountPage('/config');

    expect(wrapper.text()).toContain('Local file');
  });
});
