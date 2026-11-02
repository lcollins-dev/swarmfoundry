import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

import { useBackLink } from '@/composables/useBackLink';

import BackLink from './BackLink.vue';

const backLinkPage = defineComponent({
  setup() {
    const backLink = useBackLink({ to: '/tasks', label: 'Tasks' });

    return () => h(BackLink, { to: backLink.value.to, label: backLink.value.label });
  },
});

const mountAt = async (paths: string[]) => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/tasks/:taskId', component: backLinkPage },
      { path: '/:path(.*)*', component: { template: '<div />' } },
    ],
  });

  for (const path of paths) {
    await router.push(path);
  }

  const wrapper = mount({ template: '<router-view />' }, { global: { plugins: [router] } });
  await flushPromises();

  return { router, wrapper };
};

describe('UiBackLink with useBackLink', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('returns to the page the user came from, stepping back through history', async () => {
    const { router, wrapper } = await mountAt(['/queue', '/tasks/1080']);

    const link = wrapper.get('a');

    expect(link.text()).toBe('Queue');
    expect(link.attributes('href')).toBe('/queue');

    await link.trigger('click');

    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/queue'));
  });

  it("falls back to the page's parent when nothing in the console led there", async () => {
    const { router, wrapper } = await mountAt(['/tasks/1080']);

    const link = wrapper.get('a');

    expect(link.text()).toBe('Tasks');

    await link.trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.fullPath).toBe('/tasks');
  });
});
