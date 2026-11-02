import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sourceWith } from '../../../test/factories/trigger.factory';
import SourcePollStatus from './SourcePollStatus.vue';

describe('SourcePollStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T14:32:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the host, when the last poll ended and when the next is due', () => {
    const source = sourceWith({
      url: 'https://gitlab.example.com',
      lastPoll: { endDate: new Date('2026-10-25T14:31:52Z'), succeeded: true, error: null, failedProjects: [] },
      nextPollDate: new Date('2026-10-25T14:32:52Z'),
    });

    const wrapper = mount(SourcePollStatus, { props: { source } });

    expect(wrapper.text()).toContain('gitlab.example.com');
    expect(wrapper.text()).not.toContain('https://');
    expect(wrapper.get('[data-testid="source-last-poll"]').text()).toMatch(/\d\d:31:52 · 8s ago$/);
    expect(wrapper.get('[data-testid="source-next-poll"]').text()).toContain('in 52s');
  });
});
