import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiKeyDto } from '@libs/dto';

import { formatShortDayTime } from '@/utils/format/date';

import { useDialogStore } from '@/stores/dialog';

import ApiKeys from './ApiKeys.vue';

const mocks = vi.hoisted(() => ({
  getApiKeyList: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock('@/services/api/admin/ApiKeyAdminService', () => ({
  useApiKeyAdminService: () => mocks,
}));

const buildApiKey = (overrides: Partial<ApiKeyDto> = {}): ApiKeyDto => ({
  id: 7,
  name: 'Laptop',
  lastUsedDate: null,
  createdDate: new Date('2026-10-04T15:32:00Z'),
  ...overrides,
});

const TOKEN = `sfk_${'a'.repeat(24)}_secret`;

const mountPage = async () => {
  const wrapper = mount(ApiKeys);

  await flushPromises();

  return wrapper;
};

type PageWrapper = Awaited<ReturnType<typeof mountPage>>;

const buttonByText = (wrapper: PageWrapper, text: string) => {
  const button = wrapper.findAll('button').find(candidate => candidate.text() === text);

  if (button === undefined) {
    throw new Error(`No ${text} button`);
  }

  return button;
};

describe('API keys page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());

    // jsdom's HTMLDialogElement has neither showModal nor close.
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };

    mocks.getApiKeyList.mockResolvedValue([buildApiKey()]);
    mocks.createApiKey.mockResolvedValue({ apiKey: buildApiKey({ id: 8, name: 'Agent' }), token: TOKEN });
    mocks.revokeApiKey.mockResolvedValue(undefined);
  });

  it('lists each key with when it was created and last used', async () => {
    const unused = buildApiKey();
    const used = buildApiKey({ id: 8, name: 'Agent', lastUsedDate: new Date(Date.now() - 3 * 60 * 1000) });
    mocks.getApiKeyList.mockResolvedValue([unused, used]);

    const wrapper = await mountPage();

    const cells = (testId: string) => wrapper.findAll(`[data-testid="${testId}"]`).map(cell => cell.text());

    expect(cells('api-key-name')).toEqual(['Laptop', 'Agent']);
    expect(cells('api-key-created')).toEqual([
      formatShortDayTime(unused.createdDate),
      formatShortDayTime(used.createdDate),
    ]);
    expect(cells('api-key-last-used')).toEqual(['Never', '3 minutes ago']);
  });

  it('says so when there are no keys', async () => {
    mocks.getApiKeyList.mockResolvedValue([]);

    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('No API keys yet');
  });

  it('offers a setup prompt by default, keeping the key out of it', async () => {
    const wrapper = await mountPage();
    const prompt = wrapper.get('[data-testid="mcp-setup-text"]').text();

    expect(prompt).toContain(`- URL: ${window.location.origin}/mcp`);
    expect(prompt).toContain('Bearer <your-key>');
  });

  it('switches to the Claude Code command, or the server details', async () => {
    const wrapper = await mountPage();
    const serverUrl = `${window.location.origin}/mcp`;

    await buttonByText(wrapper, 'Claude Code').trigger('click');

    expect(wrapper.get('[data-testid="mcp-setup-text"]').text()).toContain(
      `claude mcp add --scope user --transport http swarmfoundry ${serverUrl}`
    );

    await buttonByText(wrapper, 'Server details').trigger('click');

    expect(wrapper.find('[data-testid="mcp-setup-text"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="mcp-server-url"]').text()).toBe(serverUrl);
  });

  it('creates a key and shows it once', async () => {
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="create-api-key"]').trigger('click');
    await wrapper.find('input[name="api-key-name"]').setValue('  Agent ');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(mocks.createApiKey).toHaveBeenCalledWith({ name: 'Agent' }, 'create-api-key');
    expect(wrapper.find('[data-testid="api-key-token"]').text()).toBe(TOKEN);
    expect(mocks.getApiKeyList).toHaveBeenCalledTimes(2);

    await wrapper.get('dialog').trigger('cancel');
    await wrapper.get('dialog').trigger('mousedown');
    await wrapper.get('dialog').trigger('click');

    expect(wrapper.find('[data-testid="api-key-token"]').exists()).toBe(true);

    await buttonByText(wrapper, 'Done').trigger('click');

    expect(wrapper.find('[data-testid="api-key-token"]').exists()).toBe(false);

    await wrapper.find('[data-testid="create-api-key"]').trigger('click');

    expect(wrapper.find('[data-testid="api-key-token"]').exists()).toBe(false);
    expect(wrapper.find('input[name="api-key-name"]').exists()).toBe(true);
  });

  it('revokes a key only once confirmed', async () => {
    const wrapper = await mountPage();

    await buttonByText(wrapper, 'Revoke').trigger('click');

    const dialogStore = useDialogStore();

    expect(dialogStore.top?.options.title).toBe('Revoke Laptop?');
    expect(mocks.revokeApiKey).not.toHaveBeenCalled();

    await dialogStore.top?.options.action?.();
    await flushPromises();

    expect(mocks.revokeApiKey).toHaveBeenCalledWith(7);
    expect(mocks.getApiKeyList).toHaveBeenCalledTimes(2);
  });
});
