import { BadRequestException, Logger, MessageEvent } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Subscription } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunOutcome, TranscriptEventType } from '@libs/dto';

import { TRANSCRIPT_PAGE_EVENTS, TRANSCRIPT_PAGE_LINES } from '@/api/v1/task/task-admin.service';
import {
  TRANSCRIPT_POLL_MS,
  TRANSCRIPT_STREAM_MAX_MS,
  TranscriptStreamAdminService,
} from '@/api/v1/task/transcript-stream-admin.service';
import { TaskReadService } from '@/core/task/task-read.service';

import type { ITranscriptPage, TranscriptEvent } from '@/core/task/types/transcript.types';

const STORED = new Date('2026-10-31T09:00:00Z');

const textEvent = (lineNumber: number, index = 0): TranscriptEvent => ({
  type: TranscriptEventType.ASSISTANT_TEXT,
  text: `Line ${lineNumber}`,
  parentToolUseId: null,
  lineNumber,
  index,
  storedDate: STORED,
});

const page = (events: TranscriptEvent[], nextLine: number, hasMore = false): ITranscriptPage => ({
  events,
  firstLine: 1,
  hasEarlier: false,
  nextLine,
  hasMore,
});

const running = { outcome: null };
const judged = { outcome: RunOutcome.SUCCEEDED };

describe('TranscriptStreamAdminService', () => {
  let service: TranscriptStreamAdminService;
  let findRunMock: ReturnType<typeof vi.fn>;
  let readTranscriptMock: ReturnType<typeof vi.fn>;

  let seen: MessageEvent[];
  let completed: boolean;
  let subscription: Subscription | null;

  const follow = async (afterLine = 0, types?: TranscriptEventType[]) => {
    const stream = await service.followTranscript({ runId: 40, afterLine, types });

    subscription = stream.subscribe({
      next: message => seen.push(message),
      complete: () => (completed = true),
    });

    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(async () => {
    vi.useFakeTimers();

    findRunMock = vi.fn().mockResolvedValue(running);
    readTranscriptMock = vi.fn().mockResolvedValue(page([], 1));

    seen = [];
    completed = false;
    subscription = null;

    const moduleRef = await Test.createTestingModule({
      providers: [
        TranscriptStreamAdminService,
        { provide: TaskReadService, useValue: { findRunWithThrow: findRunMock, readTranscript: readTranscriptMock } },
      ],
    }).compile();

    service = moduleRef.get(TranscriptStreamAdminService);
  });

  afterEach(() => {
    subscription?.unsubscribe();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('refuses a run that does not exist before the stream opens', async () => {
    findRunMock.mockRejectedValue(new BadRequestException("This run doesn't exist."));

    await expect(service.followTranscript({ runId: 40, afterLine: 0, types: undefined })).rejects.toThrow(
      BadRequestException
    );
  });

  it('sends each line after the one the client holds, with its events and its number as the id', async () => {
    readTranscriptMock.mockResolvedValueOnce(page([textEvent(4), textEvent(4, 1), textEvent(6)], 7));

    await follow(3, [TranscriptEventType.ASSISTANT_TEXT]);

    expect(readTranscriptMock).toHaveBeenCalledWith(40, {
      fromLine: 4,
      types: [TranscriptEventType.ASSISTANT_TEXT],
      eventLimit: TRANSCRIPT_PAGE_EVENTS,
      lineLimit: TRANSCRIPT_PAGE_LINES,
    });
    expect(seen).toEqual([
      { id: '4', data: { type: 'line', lineNumber: 4, events: [textEvent(4), textEvent(4, 1)] } },
      { id: '6', data: { type: 'line', lineNumber: 6, events: [textEvent(6)] } },
    ]);
  });

  it('reads every page stored so far before waiting', async () => {
    readTranscriptMock
      .mockResolvedValueOnce(page([textEvent(1)], 2, true))
      .mockResolvedValueOnce(page([textEvent(2)], 3));

    await follow();

    expect(seen.map(message => message.id)).toEqual(['1', '2']);
    expect(readTranscriptMock).toHaveBeenLastCalledWith(40, expect.objectContaining({ fromLine: 2 }));
  });

  it('picks up lines stored later from past the last one read, filtered out or not', async () => {
    readTranscriptMock.mockResolvedValueOnce(page([textEvent(1)], 3));

    await follow();

    readTranscriptMock.mockResolvedValueOnce(page([textEvent(3)], 4));
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_POLL_MS);

    expect(readTranscriptMock).toHaveBeenLastCalledWith(40, expect.objectContaining({ fromLine: 3 }));
    expect(seen.map(message => message.id)).toEqual(['1', '3']);
    expect(completed).toBe(false);
  });

  it('sends the last lines and then the end once the run is judged, and closes', async () => {
    readTranscriptMock.mockResolvedValueOnce(page([textEvent(1)], 2));

    await follow();

    findRunMock.mockResolvedValue(judged);
    readTranscriptMock.mockResolvedValueOnce(page([textEvent(2)], 3));
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_POLL_MS);

    expect(seen.map(message => message.data)).toEqual([
      expect.objectContaining({ lineNumber: 1 }),
      expect.objectContaining({ lineNumber: 2 }),
      { type: 'end' },
    ]);
    expect(seen.at(-1)?.id).toBeUndefined();
    expect(completed).toBe(true);
  });

  it('checks the run before reading lines, so a line stored as it is judged is never left behind', async () => {
    await follow();

    expect(findRunMock.mock.invocationCallOrder[1]).toBeLessThan(readTranscriptMock.mock.invocationCallOrder[0]);
  });

  it('closes a judged run at once after its remaining lines', async () => {
    findRunMock.mockResolvedValue(judged);

    await follow(5);

    expect(seen).toEqual([{ data: { type: 'end' } }]);
    expect(completed).toBe(true);
  });

  it('ends a stream after its age without an end message, so the client reconnects through the guard', async () => {
    await follow();

    await vi.advanceTimersByTimeAsync(TRANSCRIPT_STREAM_MAX_MS);

    expect(completed).toBe(true);
    expect(seen).toEqual([]);
  });

  it('ends quietly when a read fails, so the client reconnects and no error detail reaches it', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    readTranscriptMock.mockRejectedValueOnce(new Error('connection terminated'));

    await follow();

    expect(completed).toBe(true);
    expect(seen).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
  });

  it('stops polling once the client leaves', async () => {
    await follow();

    subscription?.unsubscribe();
    const reads = readTranscriptMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_POLL_MS * 10);

    expect(readTranscriptMock.mock.calls.length).toBe(reads);
  });
});
