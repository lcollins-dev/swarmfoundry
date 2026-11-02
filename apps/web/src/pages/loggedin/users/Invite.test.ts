import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserRoleId } from '@libs/dto';

import Invite from './Invite.vue';

const mocks = vi.hoisted(() => ({
  inviteUser: vi.fn(),
}));

vi.mock('vue-router', async importOriginal => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRoute: () => ({ params: {}, fullPath: '/users/invite' }),
  useRouter: () => ({ options: { history: { state: {} } }, resolve: (to: string) => ({ href: to }) }),
}));

vi.mock('@/services/api/admin/UserAdminService', () => ({
  useUserAdminService: () => mocks,
}));

const LINK = `https://example.com/set-password#${'ab'.repeat(32)}`;

const invited = (emailed: boolean) => ({
  userId: 42,
  passwordLink: { link: LINK, expiresAt: new Date('2026-11-08T12:00:00Z'), emailed },
});

const mountPage = async () => {
  const wrapper = mount(Invite, {
    global: {
      stubs: {
        RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        RoleSelect: {
          props: ['value'],
          emits: ['update:value'],
          template: `<button type="button" data-testid="role-stub" @click="$emit('update:value', [${UserRoleId.SYSTEM_ADMIN}])" />`,
        },
      },
    },
  });

  await flushPromises();

  return wrapper;
};

type PageWrapper = Awaited<ReturnType<typeof mountPage>>;

const sendInvite = async (wrapper: PageWrapper) => {
  await wrapper.find('input[name="name"]').setValue(' Casey ');
  await wrapper.find('input[name="email"]').setValue(' casey@example.com ');
  await wrapper.find('[data-testid="role-stub"]').trigger('click');
  await wrapper.find('form').trigger('submit');
  await flushPromises();
};

describe('Invite user page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  it('sends the invite with no password', async () => {
    mocks.inviteUser.mockResolvedValue(invited(true));
    const wrapper = await mountPage();

    await sendInvite(wrapper);

    expect(mocks.inviteUser).toHaveBeenCalledWith(
      { name: 'Casey', email: 'casey@example.com', userRoleIds: [UserRoleId.SYSTEM_ADMIN] },
      'invite-user'
    );
  });

  it('shows the link once it is sent, with a way to the new user', async () => {
    mocks.inviteUser.mockResolvedValue(invited(true));
    const wrapper = await mountPage();

    await sendInvite(wrapper);

    expect(wrapper.text()).toContain('Invite sent');
    expect(wrapper.text()).toContain('Emailed to casey@example.com');
    expect(wrapper.find('[data-testid="password-link-value"]').text()).toBe(LINK);
    expect(wrapper.find('a[href="/users/42"]').exists()).toBe(true);
  });

  it('warns when the email did not send, so the admin hands the link over', async () => {
    mocks.inviteUser.mockResolvedValue(invited(false));
    const wrapper = await mountPage();

    await sendInvite(wrapper);

    expect(wrapper.text()).toContain('Invite created');
    expect(wrapper.text()).toContain('Email not sent');
  });

  it('starts a blank form for the next invite', async () => {
    mocks.inviteUser.mockResolvedValue(invited(true));
    const wrapper = await mountPage();

    await sendInvite(wrapper);

    const another = wrapper.findAll('button').find(button => button.text() === 'Invite Another');
    await another?.trigger('click');

    expect(wrapper.find('[data-testid="password-link"]').exists()).toBe(false);
    expect(wrapper.find<HTMLInputElement>('input[name="email"]').element.value).toBe('');
  });

  it('keeps the form when the invite is refused', async () => {
    mocks.inviteUser.mockRejectedValue(new Error('Refused'));
    const wrapper = await mountPage();

    await sendInvite(wrapper);

    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.find('[data-testid="password-link"]').exists()).toBe(false);
  });
});
