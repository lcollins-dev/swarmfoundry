import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListUserDto } from '@libs/dto';

import Index from './Index.vue';

const mocks = vi.hoisted(() => ({
  getUserList: vi.fn(),
  getUserStats: vi.fn(),
}));

vi.mock('@/services/api/admin/UserAdminService', () => ({
  useUserAdminService: () => mocks,
}));

const buildUser = (overrides: Partial<ListUserDto> = {}): ListUserDto => ({
  id: 1,
  name: 'Casey',
  email: 'casey@example.com',
  enabled: true,
  invited: false,
  userRoleIds: [],
  lastAccess: new Date('2026-10-25T11:32:00Z'),
  createdDate: new Date('2026-09-14T09:00:00Z'),
  ...overrides,
});

const mountPage = async () => {
  const wrapper = mount(Index, {
    global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } },
  });

  await flushPromises();

  return wrapper;
};

describe('Users page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());

    mocks.getUserStats.mockResolvedValue({ total: 2, enabled: 2, disabled: 0 });
    mocks.getUserList.mockResolvedValue({
      userList: [buildUser(), buildUser({ id: 2, email: 'drew@example.com', invited: true })],
      pages: 1,
      total: 2,
    });
  });

  it('leads to the invite page', async () => {
    const wrapper = await mountPage();

    expect(wrapper.find('a[href="/users/invite"]').text()).toContain('Invite User');
  });

  it('marks only the users still to choose a password', async () => {
    const wrapper = await mountPage();

    const rows = wrapper.findAll('[data-testid="user-row"]');

    expect(rows[0].find('[data-testid="user-invited"]').exists()).toBe(false);
    expect(rows[1].find('[data-testid="user-invited"]').text()).toBe('Invited');
  });
});
