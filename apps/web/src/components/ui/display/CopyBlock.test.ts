import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CopyBlock from './CopyBlock.vue';

describe('CopyBlock', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    vi.restoreAllMocks();
  });

  it('selects the text to copy by hand when the browser blocks the clipboard', async () => {
    const selectAllChildren = vi.fn();
    vi.spyOn(window, 'getSelection').mockReturnValue({ selectAllChildren } as unknown as Selection);
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

    const wrapper = mount(CopyBlock, { props: { label: 'Command', value: 'claude mcp add', valueTestId: 'block' } });

    await wrapper.find('button').trigger('click');
    await flushPromises();

    expect(selectAllChildren).toHaveBeenCalledOnce();
    expect((selectAllChildren.mock.calls[0][0] as HTMLElement).textContent).toBe('claude mcp add');
  });
});
