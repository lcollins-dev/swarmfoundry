import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { Config } from '@/Config';

import { useTelemetryStore } from '@/stores/telemetry';

import LiveUpdatesTag from './LiveUpdatesTag.vue';

const tagText = (wrapper: { get: (selector: string) => { text: () => string } }) =>
  wrapper.get('[data-testid="live-updates-tag"]').text();

describe('LiveUpdatesTag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T14:32:00Z'));
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads as idle where nothing on the page updates live', () => {
    const wrapper = mount(LiveUpdatesTag);

    expect(tagText(wrapper)).toBe('Live updates · idle');
  });

  it('gives the age of the live data, then turns stale once it stops arriving', async () => {
    useTelemetryStore().register({ connected: ref(true), lastActivityDate: ref(new Date()) });
    const wrapper = mount(LiveUpdatesTag);

    vi.advanceTimersByTime(3000);
    await nextTick();

    expect(tagText(wrapper)).toBe('Live updates · 3s');
    expect(wrapper.find('.bg-success-soft').exists()).toBe(true);

    vi.advanceTimersByTime(Config.LIVE_STALE_MS);
    await nextTick();

    expect(tagText(wrapper)).toBe('Live updates · 18s old');
    expect(wrapper.find('.bg-warning-soft').exists()).toBe(true);
  });
});
