import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { TranscriptEventType, type TranscriptEventDto } from '@libs/dto';

import TranscriptEventRow from './TranscriptEventRow.vue';

const START_DATE = new Date('2026-10-25T09:00:00Z');

const EVENT_BASE = {
  lineNumber: 4,
  index: 0,
  storedDate: new Date('2026-10-25T09:01:05Z'),
  parentToolUseId: null,
};

const mountEvent = (
  event: TranscriptEventDto,
  { toolName = null, agentName = null }: { toolName?: string | null; agentName?: string | null } = {}
) => mount(TranscriptEventRow, { props: { event, startDate: START_DATE, toolName, agentName } });

describe('TranscriptEventRow', () => {
  it("shows assistant text as its summary, timed from the run's start, by the main agent", async () => {
    const wrapper = mountEvent({
      ...EVENT_BASE,
      type: TranscriptEventType.ASSISTANT_TEXT,
      text: 'First line.\nSecond line.',
    });

    expect(wrapper.text()).toContain('1m 05s');
    expect(wrapper.get('[data-testid="event-summary"]').text()).toBe('First line.\nSecond line.');
    expect(wrapper.text()).toContain('main');
    expect(wrapper.find('[data-testid="event-detail"]').exists()).toBe(false);

    await wrapper.get('[role="button"]').trigger('click');

    expect(wrapper.get('[data-testid="event-prose"]').text()).toBe('First line.\nSecond line.');
  });

  it("shows a tool call's tool and what it acts on, and each input field once opened", async () => {
    const wrapper = mountEvent(
      {
        ...EVENT_BASE,
        type: TranscriptEventType.TOOL_CALL,
        toolUseId: 'toolu_1',
        name: 'Bash',
        input: { command: 'npm test', timeout: 600000 },
      },
      { toolName: 'Bash' }
    );

    expect(wrapper.get('[data-testid="event-summary"]').text()).toBe('npm test');
    expect(wrapper.text()).toContain('Bash');

    await wrapper.get('[role="button"]').trigger('click');

    const detail = wrapper.get('[data-testid="event-detail"]');

    expect(detail.findAll('dt').map(term => term.text())).toEqual(['command', 'timeout']);
    expect(detail.findAll('dd').map(value => value.text())).toEqual(['npm test', '600000']);
  });

  it('toggles a tool result open and shut, marking one that errored', async () => {
    const wrapper = mountEvent({
      ...EVENT_BASE,
      type: TranscriptEventType.TOOL_RESULT,
      toolUseId: 'toolu_1',
      content: 'error TS2322\nmore detail',
      isError: true,
    });

    expect(wrapper.text()).toContain('Tool error');
    expect(wrapper.get('[data-testid="event-summary"]').text()).toBe('error TS2322');
    expect(wrapper.text()).toContain('-');

    const row = wrapper.get('[role="button"]');

    await row.trigger('click');

    expect(row.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('pre').text()).toBe('error TS2322\nmore detail');
    expect(wrapper.get('pre').classes()).toContain('text-error');

    await row.trigger('keydown', { key: 'Enter' });

    expect(wrapper.find('[data-testid="event-detail"]').exists()).toBe(false);
  });

  it("names a subagent's event by its agent", () => {
    const wrapper = mountEvent(
      { ...EVENT_BASE, type: TranscriptEventType.ASSISTANT_TEXT, text: 'Searching.', parentToolUseId: 'toolu_9' },
      { agentName: 'Explore' }
    );

    expect(wrapper.text()).toContain('Explore');
    expect(wrapper.text()).not.toContain('main');
  });

  it('offers nothing to open for a tool call with no input', () => {
    const wrapper = mountEvent({
      ...EVENT_BASE,
      type: TranscriptEventType.TOOL_CALL,
      toolUseId: 'toolu_1',
      name: 'TodoRead',
      input: {},
    });

    expect(wrapper.find('[role="button"]').exists()).toBe(false);
    expect(wrapper.find('svg').exists()).toBe(false);
    expect(wrapper.get('[data-testid="event-summary"]').text()).toBe('{}');
  });
});
