import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { NotificationDto, NotificationSeverity } from '@libs/dto';

import NotificationsMenu from './NotificationsMenu.vue';

const getNotificationList = vi.fn();

vi.mock('@/services/api/NotificationService', () => ({
  useNotificationService: () => ({ getNotificationList, clearNotification: vi.fn() }),
}));

const NOTIFICATION: NotificationDto = {
  id: 1,
  notificationType: { id: 1, name: 'Export ready', severity: NotificationSeverity.SUCCESS },
  desc: 'Your export has finished.',
  createdDate: new Date(),
};

const mountMenu = async (notificationList: NotificationDto[]) => {
  getNotificationList.mockResolvedValue({ notificationList });

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  });
  await router.push('/');

  const wrapper = mount(NotificationsMenu, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();

  return wrapper;
};

const trigger = (wrapper: Awaited<ReturnType<typeof mountMenu>>) => wrapper.get('button[aria-label="Notifications"]');

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('NotificationsMenu', () => {
  it('shows the unread count on its trigger', async () => {
    const wrapper = await mountMenu([NOTIFICATION]);

    expect(wrapper.get('[data-testid="notifications-count"]').text()).toBe('1');
  });

  it('lists the notifications in its panel', async () => {
    const wrapper = await mountMenu([NOTIFICATION]);

    await trigger(wrapper).trigger('click');

    expect(trigger(wrapper).attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-testid="notifications-panel"]').text()).toContain('Export ready');
  });

  it('says when nothing is waiting and shows no count', async () => {
    const wrapper = await mountMenu([]);

    await trigger(wrapper).trigger('click');

    expect(wrapper.find('[data-testid="notifications-count"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="notifications-panel"]').text()).toContain('No new notifications');
  });

  it('closes on Escape and returns focus to its trigger', async () => {
    const wrapper = await mountMenu([]);

    await trigger(wrapper).trigger('click');
    await wrapper.get('[data-testid="notifications-panel"]').trigger('keydown', { key: 'Escape' });

    expect(wrapper.find('[data-testid="notifications-panel"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger(wrapper).element);
  });
});
