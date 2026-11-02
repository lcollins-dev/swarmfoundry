import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, Ref, ref } from 'vue';

import {
  TranscriptEventType,
  type TranscriptEventDto,
  type TranscriptResponseDto,
  type TranscriptStreamMessageDto,
} from '@libs/dto';

import { ITranscriptFollowHandlers, ITranscriptRequest, useTranscript } from './useTranscript';

const textAt = (lineNumber: number): TranscriptEventDto => ({
  type: TranscriptEventType.ASSISTANT_TEXT,
  lineNumber,
  index: 0,
  storedDate: new Date('2026-10-25T09:03:00Z'),
  parentToolUseId: null,
  text: `line ${lineNumber}`,
});

/** A page covering the lines from `firstLine` up to `nextLine`, with an event on each line listed. */
const pageOf = (lineNumbers: number[], firstLine: number, nextLine: number): TranscriptResponseDto => ({
  events: lineNumbers.map(textAt),
  firstLine,
  hasEarlier: firstLine > 1,
  nextLine,
  hasMore: false,
});

type FetchPage = (request: ITranscriptRequest, beforeLine: number | null) => Promise<TranscriptResponseDto>;

describe('useTranscript', () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchPage>>;

  const mountTranscript = (request: Ref<ITranscriptRequest | null>) => {
    let transcript: ReturnType<typeof useTranscript> | undefined;

    mount(
      defineComponent({
        setup() {
          transcript = useTranscript({ request, fetch: fetchMock });

          return () => null;
        },
      })
    );

    return transcript!;
  };

  beforeEach(() => {
    fetchMock = vi.fn<FetchPage>();
  });

  it('reads the last page on mount, then prepends each page before the earliest line held', async () => {
    fetchMock.mockResolvedValueOnce(pageOf([3, 4], 3, 5)).mockResolvedValueOnce(pageOf([1, 2], 1, 3));

    const transcript = mountTranscript(ref({ runId: 9, types: [] }));
    await flushPromises();

    expect(fetchMock).toHaveBeenLastCalledWith({ runId: 9, types: [] }, null);
    expect(transcript.loaded.value).toBe(true);
    expect(transcript.hasEarlier.value).toBe(true);

    await transcript.loadEarlier();

    expect(fetchMock).toHaveBeenLastCalledWith({ runId: 9, types: [] }, 3);
    expect(transcript.events.value.map(event => event.lineNumber)).toEqual([1, 2, 3, 4]);
    expect(transcript.hasEarlier.value).toBe(false);
  });

  it('reads nothing more once it holds the first line', async () => {
    fetchMock.mockResolvedValueOnce(pageOf([1], 1, 2));

    const transcript = mountTranscript(ref({ runId: 9, types: [] }));
    await flushPromises();

    await transcript.loadEarlier();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('starts again from the last page when the filter changes, dropping a page still in flight', async () => {
    let resolveStale: (page: TranscriptResponseDto) => void = () => undefined;

    fetchMock
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveStale = resolve;
        })
      )
      .mockResolvedValueOnce(pageOf([5], 1, 6));

    const request = ref<ITranscriptRequest | null>({ runId: 9, types: [] });
    const transcript = mountTranscript(request);

    request.value = { runId: 9, types: [TranscriptEventType.TOOL_CALL] };
    await nextTick();

    resolveStale(pageOf([1, 2], 1, 3));
    await flushPromises();

    expect(fetchMock).toHaveBeenLastCalledWith({ runId: 9, types: [TranscriptEventType.TOOL_CALL] }, null);
    expect(transcript.events.value.map(event => event.lineNumber)).toEqual([5]);
    expect(transcript.loading.value).toBe(false);
  });

  it('marks a failed page and keeps what it had, so a retry reads the same line', async () => {
    fetchMock.mockResolvedValueOnce(pageOf([4], 4, 5)).mockRejectedValueOnce(new Error('offline'));

    const transcript = mountTranscript(ref({ runId: 9, types: [] }));
    await flushPromises();

    await transcript.loadEarlier();

    expect(transcript.failed.value).toBe(true);
    expect(transcript.events.value).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(pageOf([3], 3, 4));
    await transcript.loadEarlier();

    expect(fetchMock).toHaveBeenLastCalledWith({ runId: 9, types: [] }, 4);
    expect(transcript.failed.value).toBe(false);
  });

  it('asks for the last page again when the first read fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(pageOf([1], 1, 2));

    const transcript = mountTranscript(ref({ runId: 9, types: [] }));
    await flushPromises();

    expect(transcript.failed.value).toBe(true);
    expect(transcript.loaded.value).toBe(false);

    await transcript.loadEarlier();

    expect(fetchMock).toHaveBeenLastCalledWith({ runId: 9, types: [] }, null);
    expect(transcript.loaded.value).toBe(true);
  });

  it('reads nothing for a null request', async () => {
    mountTranscript(ref(null));
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('following a live run', () => {
    let followMock: ReturnType<
      typeof vi.fn<(request: ITranscriptRequest, afterLine: number, handlers: ITranscriptFollowHandlers) => void>
    >;
    let closeMock: ReturnType<typeof vi.fn<() => void>>;
    let onEnd: ReturnType<typeof vi.fn<() => void>>;

    const handlers = (): ITranscriptFollowHandlers => {
      const lastCall = followMock.mock.lastCall;

      if (lastCall === undefined) {
        throw new Error('Not following');
      }

      return lastCall[2];
    };

    const lineMessage = (lineNumber: number): TranscriptStreamMessageDto => ({
      type: 'line',
      lineNumber,
      events: [textAt(lineNumber)],
    });

    const mountLive = (request: Ref<ITranscriptRequest | null>, live: Ref<boolean>) => {
      let transcript: ReturnType<typeof useTranscript> | undefined;

      const wrapper = mount(
        defineComponent({
          setup() {
            transcript = useTranscript({
              request,
              fetch: fetchMock,
              live,
              follow: (followRequest, afterLine, followHandlers) => {
                followMock(followRequest, afterLine, followHandlers);

                return { close: closeMock };
              },
              onEnd,
            });

            return () => null;
          },
        })
      );

      return { transcript: transcript!, wrapper };
    };

    beforeEach(() => {
      followMock = vi.fn();
      closeMock = vi.fn<() => void>();
      onEnd = vi.fn<() => void>();
    });

    it('follows after the last line the last page covers, once it has loaded', async () => {
      let resolvePage: (page: TranscriptResponseDto) => void = () => undefined;

      fetchMock
        .mockReturnValueOnce(
          new Promise(resolve => {
            resolvePage = resolve;
          })
        )
        .mockResolvedValueOnce(pageOf([1], 1, 2));

      const { transcript } = mountLive(ref({ runId: 9, types: [] }), ref(true));
      await flushPromises();

      expect(followMock).not.toHaveBeenCalled();

      resolvePage(pageOf([2], 2, 4));
      await flushPromises();

      expect(followMock).toHaveBeenCalledExactlyOnceWith({ runId: 9, types: [] }, 3, expect.anything());
      expect(transcript.following.value).toBe(true);

      await transcript.loadEarlier();

      expect(followMock).toHaveBeenCalledOnce();
      expect(transcript.events.value.map(event => event.lineNumber)).toEqual([1, 2]);
    });

    it('appends each streamed line once, dropping one it already holds', async () => {
      fetchMock.mockResolvedValueOnce(pageOf([1, 2], 1, 3));

      const { transcript } = mountLive(ref({ runId: 9, types: [] }), ref(true));
      await flushPromises();

      handlers().onMessage(lineMessage(2));
      handlers().onMessage(lineMessage(3));
      handlers().onMessage(lineMessage(3));
      handlers().onMessage(lineMessage(5));

      expect(transcript.events.value.map(event => event.lineNumber)).toEqual([1, 2, 3, 5]);
    });

    it('closes on the end message and hands it on, following no more while the run still reads live', async () => {
      fetchMock.mockResolvedValueOnce(pageOf([], 1, 1));

      const { transcript } = mountLive(ref({ runId: 9, types: [] }), ref(true));
      await flushPromises();

      handlers().onMessage({ type: 'end' });
      await flushPromises();

      expect(closeMock).toHaveBeenCalledOnce();
      expect(onEnd).toHaveBeenCalledOnce();
      expect(followMock).toHaveBeenCalledOnce();
      expect(transcript.following.value).toBe(false);
    });

    it('follows again with the new filter after reading its last page', async () => {
      fetchMock.mockResolvedValueOnce(pageOf([1], 1, 2)).mockResolvedValueOnce(pageOf([], 1, 2));

      const request = ref<ITranscriptRequest | null>({ runId: 9, types: [] });
      mountLive(request, ref(true));
      await flushPromises();

      request.value = { runId: 9, types: [TranscriptEventType.TOOL_CALL] };
      await flushPromises();

      expect(closeMock).toHaveBeenCalledOnce();
      expect(followMock).toHaveBeenLastCalledWith(
        { runId: 9, types: [TranscriptEventType.TOOL_CALL] },
        1,
        expect.anything()
      );
      expect(fetchMock).toHaveBeenLastCalledWith({ runId: 9, types: [TranscriptEventType.TOOL_CALL] }, null);
    });

    it('never follows a run that has ended, and stops once one does', async () => {
      fetchMock.mockResolvedValue(pageOf([], 1, 1));

      mountLive(ref({ runId: 9, types: [] }), ref(false));
      await flushPromises();

      expect(followMock).not.toHaveBeenCalled();

      const live = ref(true);
      mountLive(ref({ runId: 9, types: [] }), live);
      await flushPromises();

      live.value = false;
      await flushPromises();

      expect(closeMock).toHaveBeenCalledOnce();
    });

    it('marks a refused stream failed, and follows again on request after the last line held', async () => {
      fetchMock.mockResolvedValue(pageOf([1], 1, 2));

      const { transcript } = mountLive(ref({ runId: 9, types: [] }), ref(true));
      await flushPromises();

      handlers().onMessage(lineMessage(2));
      handlers().onStop();
      await flushPromises();

      expect(transcript.followFailed.value).toBe(true);
      expect(transcript.failed.value).toBe(false);
      expect(transcript.following.value).toBe(false);

      transcript.follow();
      await flushPromises();

      expect(followMock).toHaveBeenCalledTimes(2);
      expect(followMock).toHaveBeenLastCalledWith({ runId: 9, types: [] }, 2, expect.anything());
      expect(transcript.followFailed.value).toBe(false);
    });

    it('closes the stream when the page goes', async () => {
      fetchMock.mockResolvedValue(pageOf([], 1, 1));

      const { wrapper } = mountLive(ref({ runId: 9, types: [] }), ref(true));
      await flushPromises();

      wrapper.unmount();

      expect(closeMock).toHaveBeenCalledOnce();
    });
  });
});
