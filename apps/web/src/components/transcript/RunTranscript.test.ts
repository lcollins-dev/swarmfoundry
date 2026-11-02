import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RunEndReason,
  RunOutcome,
  TranscriptEventType,
  type TranscriptEventDto,
  type TranscriptResponseDto,
  type TranscriptStreamMessageDto,
} from '@libs/dto';

import { runWith } from '../../../test/factories/task.factory';
import RunTranscript from './RunTranscript.vue';

const getTranscript =
  vi.fn<(runId: number, beforeLine: number | null, types?: TranscriptEventType[]) => Promise<TranscriptResponseDto>>();

const followTranscript =
  vi.fn<
    (
      runId: number,
      afterLine: number,
      types: TranscriptEventType[],
      onMessage: (message: TranscriptStreamMessageDto) => void,
      onRefusal: (refusal: unknown) => void
    ) => { close: () => void }
  >();

vi.mock('@/services/api/admin/TaskAdminService', () => ({
  useTaskAdminService: () => ({ getTranscript, followTranscript }),
}));

const EVENT_BASE = { index: 0, storedDate: new Date('2026-10-25T09:04:00Z'), parentToolUseId: null };

const toolCall = (lineNumber: number): TranscriptEventDto => ({
  ...EVENT_BASE,
  lineNumber,
  type: TranscriptEventType.TOOL_CALL,
  toolUseId: `toolu_${lineNumber}`,
  name: 'Grep',
  input: { pattern: 'TranscriptEvent' },
});

const toolResult = (lineNumber: number, toolUseId: string): TranscriptEventDto => ({
  ...EVENT_BASE,
  lineNumber,
  type: TranscriptEventType.TOOL_RESULT,
  toolUseId,
  content: 'src/steps/relabel.ts',
  isError: false,
});

const callsOn = (first: number, last: number): TranscriptEventDto[] =>
  Array.from({ length: last - first + 1 }, (_unused, offset) => toolCall(first + offset));

const pageOf = (events: TranscriptEventDto[], firstLine: number, nextLine: number): TranscriptResponseDto => ({
  events,
  firstLine,
  hasEarlier: firstLine > 1,
  nextLine,
  hasMore: false,
});

const ROW_HEIGHT = 100;
const VIEW_HEIGHT = 400;

/** Lays the scroll box out as a browser would: each row adds its height, and the top stays where it is put. */
const layOut = (box: HTMLElement) => {
  let top = 0;

  Object.defineProperty(box, 'clientHeight', { get: () => VIEW_HEIGHT });
  Object.defineProperty(box, 'scrollHeight', {
    get: () => box.querySelectorAll('[data-testid="transcript-event"]').length * ROW_HEIGHT,
  });
  Object.defineProperty(box, 'scrollTop', {
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, box.scrollHeight - VIEW_HEIGHT));
    },
  });

  const scrollTo = vi.fn();
  box.scrollTo = scrollTo;

  return { scrollTo };
};

const mountTranscript = (outcome: RunOutcome | null = RunOutcome.SUCCEEDED, endReason: RunEndReason | null = null) => {
  const wrapper = mount(RunTranscript, {
    props: { run: runWith({ id: 9, outcome, endReason }) },
    attachTo: document.body,
  });
  const box = wrapper.get<HTMLElement>('[data-testid="transcript-scroll"]');

  return { wrapper, box, ...layOut(box.element) };
};

const streamed = (): ((message: TranscriptStreamMessageDto) => void) => {
  const lastCall = followTranscript.mock.lastCall;

  if (lastCall === undefined) {
    throw new Error('Not following');
  }

  return lastCall[3];
};

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  getTranscript.mockReset();
  followTranscript.mockReset().mockReturnValue({ close: () => undefined });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('RunTranscript', () => {
  it("opens a finished run's last page at the newest event, between the start and the end", async () => {
    getTranscript.mockResolvedValueOnce(pageOf([toolCall(1), toolResult(2, 'toolu_1')], 1, 3));

    const { wrapper, box } = mountTranscript();
    await flushPromises();

    expect(getTranscript).toHaveBeenCalledExactlyOnceWith(9, null, []);
    expect(box.element.scrollTop).toBe(0);

    const rows = wrapper.findAll('[data-testid="transcript-event"]');

    expect(rows).toHaveLength(2);
    expect(rows[1].text()).toContain('Grep');
    expect(wrapper.find('[data-testid="transcript-start"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="transcript-end"]').text()).toBe('End of transcript.');
    expect(wrapper.text()).toContain('Agent messages, tool calls and results.');
    expect(followTranscript).not.toHaveBeenCalled();
  });

  it('opens and shuts an event on a click', async () => {
    getTranscript.mockResolvedValueOnce(pageOf([toolCall(1)], 1, 2));

    const { wrapper } = mountTranscript();
    await flushPromises();

    await wrapper.get('[role="button"]').trigger('click');

    expect(wrapper.get('[data-testid="event-detail"]').text()).toContain('TranscriptEvent');

    await wrapper.get('[role="button"]').trigger('click');

    expect(wrapper.find('[data-testid="event-detail"]').exists()).toBe(false);
  });

  it('says why a run that timed out ends where it does', async () => {
    getTranscript.mockResolvedValueOnce(pageOf([toolCall(1)], 1, 2));

    const { wrapper } = mountTranscript(RunOutcome.FAILED, RunEndReason.TIMEOUT);
    await flushPromises();

    expect(wrapper.get('[data-testid="transcript-end"]').text()).toContain('reaching its time limit');
  });

  it('reads the last page again of the type picked', async () => {
    getTranscript.mockResolvedValue(pageOf([], 1, 1));

    const { wrapper } = mountTranscript();
    await flushPromises();

    expect(wrapper.text()).toContain('No transcript was recorded for this run.');

    await wrapper.get('[role="combobox"]').trigger('click');
    const option = wrapper.findAll('[role="option"]').find(listed => listed.text() === 'Tool result');
    await option!.trigger('click');
    await flushPromises();

    expect(getTranscript).toHaveBeenLastCalledWith(9, null, [TranscriptEventType.TOOL_RESULT]);
    expect(wrapper.text()).toContain('No events match this filter.');
    expect(wrapper.find('[data-testid="transcript-start"]').exists()).toBe(false);
  });

  it('loads earlier events near the top, keeping the events in view where they were', async () => {
    getTranscript.mockResolvedValueOnce(pageOf(callsOn(11, 20), 11, 21));

    const { wrapper, box } = mountTranscript();
    await flushPromises();

    expect(box.element.scrollTop).toBe(600);
    expect(wrapper.get('[data-testid="transcript-loading"]').text()).toBe('Loading earlier events...');
    expect(getTranscript).toHaveBeenCalledOnce();

    getTranscript.mockResolvedValueOnce(pageOf(callsOn(1, 10), 1, 11));
    box.element.scrollTop = 50;
    await box.trigger('scroll');
    await flushPromises();

    expect(getTranscript).toHaveBeenLastCalledWith(9, 11, []);
    expect(wrapper.findAll('[data-testid="transcript-event"]')).toHaveLength(20);
    expect(box.element.scrollTop).toBe(1050);
    expect(wrapper.find('[data-testid="transcript-start"]').exists()).toBe(true);
  });

  it('keeps reading earlier pages while the top stays in view', async () => {
    getTranscript
      .mockResolvedValueOnce(pageOf([toolCall(30)], 30, 31))
      .mockResolvedValueOnce(pageOf([], 10, 30))
      .mockResolvedValueOnce(pageOf([toolCall(2)], 1, 10));

    const { wrapper } = mountTranscript();
    await flushPromises();

    expect(getTranscript.mock.calls.map(call => call[1])).toEqual([null, 30, 10]);
    expect(wrapper.findAll('[data-testid="transcript-event"]')).toHaveLength(2);
  });

  it('offers to jump to the latest event while scrolled away from it', async () => {
    getTranscript.mockResolvedValueOnce(pageOf(callsOn(1, 10), 1, 11));

    const { wrapper, box, scrollTo } = mountTranscript();
    await flushPromises();

    expect(wrapper.find('[data-testid="transcript-jump"]').exists()).toBe(false);

    box.element.scrollTop = 200;
    await box.trigger('scroll');

    await wrapper.get('[data-testid="transcript-jump"]').trigger('click');

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });

    box.element.scrollTop = 600;
    await box.trigger('scroll');

    expect(wrapper.find('[data-testid="transcript-jump"]').exists()).toBe(false);
  });

  it('offers a retry when a page fails, reading the same page again', async () => {
    getTranscript.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(pageOf([toolCall(1)], 1, 2));

    const { wrapper } = mountTranscript();
    await flushPromises();

    expect(getTranscript).toHaveBeenCalledOnce();

    await wrapper.get('[data-testid="transcript-retry"]').trigger('click');
    await flushPromises();

    expect(getTranscript).toHaveBeenLastCalledWith(9, null, []);
    expect(wrapper.findAll('[data-testid="transcript-event"]')).toHaveLength(1);
  });

  describe('a live run', () => {
    it('follows after the last page, waiting for the first event', async () => {
      getTranscript.mockResolvedValueOnce(pageOf([], 1, 1));

      const { wrapper } = mountTranscript(null);
      await flushPromises();

      expect(wrapper.text()).toContain('Agent messages, tool calls and results.');
      expect(wrapper.text()).toContain('Waiting for the first event.');
      expect(followTranscript).toHaveBeenCalledExactlyOnceWith(9, 0, [], expect.any(Function), expect.any(Function));
      expect(wrapper.find('[data-testid="transcript-end"]').exists()).toBe(false);
    });

    it('stays at the bottom for new events only while the view is there', async () => {
      getTranscript.mockResolvedValueOnce(pageOf(callsOn(1, 10), 1, 11));

      const { wrapper, box } = mountTranscript(null);
      await flushPromises();

      streamed()({ type: 'line', lineNumber: 11, events: [toolCall(11)] });
      await flushPromises();

      expect(box.element.scrollTop).toBe(700);

      box.element.scrollTop = 100;
      await box.trigger('scroll');

      streamed()({ type: 'line', lineNumber: 12, events: [toolCall(12)] });
      await flushPromises();

      expect(wrapper.findAll('[data-testid="transcript-event"]')).toHaveLength(12);
      expect(box.element.scrollTop).toBe(100);
      expect(wrapper.find('[data-testid="transcript-jump"]').exists()).toBe(true);
    });

    it('hands on the end of the run', async () => {
      getTranscript.mockResolvedValueOnce(pageOf([toolCall(1)], 1, 2));

      const { wrapper } = mountTranscript(null);
      await flushPromises();

      streamed()({ type: 'end' });

      expect(wrapper.emitted('ended')).toHaveLength(1);
    });

    it('shows the end of the transcript only once the run has ended', async () => {
      getTranscript.mockResolvedValueOnce(pageOf([toolCall(1), toolResult(2, 'toolu_1')], 1, 3));

      const { wrapper } = mountTranscript(null);
      await flushPromises();

      expect(wrapper.findAll('[data-testid="transcript-event"]')).toHaveLength(2);
      expect(wrapper.find('[data-testid="transcript-end"]').exists()).toBe(false);

      await wrapper.setProps({ run: runWith({ id: 9, outcome: RunOutcome.SUCCEEDED, endReason: null }) });
      await flushPromises();

      expect(wrapper.get('[data-testid="transcript-end"]').text()).toBe('End of transcript.');
    });

    it('offers to follow again after the stream is refused', async () => {
      getTranscript.mockResolvedValueOnce(pageOf([toolCall(1)], 1, 2));

      const { wrapper } = mountTranscript(null);
      await flushPromises();

      const refuse = followTranscript.mock.lastCall![4];
      refuse({ status: 403 });
      await flushPromises();

      await wrapper.get('[data-testid="transcript-follow-retry"]').trigger('click');
      await flushPromises();

      expect(followTranscript).toHaveBeenCalledTimes(2);
      expect(followTranscript).toHaveBeenLastCalledWith(9, 1, [], expect.any(Function), expect.any(Function));
      expect(wrapper.find('[data-testid="transcript-follow-failed"]').exists()).toBe(false);
    });
  });
});
