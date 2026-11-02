import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { sourceWith } from '../../../test/factories/trigger.factory';
import SourcePollFailure from './SourcePollFailure.vue';

const lastPoll = { endDate: new Date('2026-10-25T14:31:52Z'), error: null, failedProjects: [] };

describe('SourcePollFailure', () => {
  it('names the source and each project a failed poll could not read', () => {
    const source = sourceWith({
      name: 'gitlab',
      lastPoll: { ...lastPoll, succeeded: false, failedProjects: [{ project: 'group/gone', error: '404 Not Found' }] },
    });

    const failure = mount(SourcePollFailure, { props: { source } }).get('[data-testid="source-poll-failure"]');

    expect(failure.text()).toContain('Last poll failed · gitlab');
    expect(failure.text()).toContain('group/gone: 404 Not Found');
  });

  it('shows nothing after a poll that succeeded, or before the first', () => {
    const succeeded = sourceWith({ lastPoll: { ...lastPoll, succeeded: true } });
    const unpolled = sourceWith({ lastPoll: null });

    expect(mount(SourcePollFailure, { props: { source: succeeded } }).html()).toBe('<!--v-if-->');
    expect(mount(SourcePollFailure, { props: { source: unpolled } }).html()).toBe('<!--v-if-->');
  });
});
