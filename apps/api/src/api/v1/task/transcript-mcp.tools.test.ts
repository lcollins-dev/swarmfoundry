import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepList, TranscriptDirection, TranscriptEventType } from '@libs/dto';

import { Run } from '@/core/task/entities/run.entity';
import { Task } from '@/core/task/entities/task.entity';

import type { TaskAdminService } from './task-admin.service';
import type { TranscriptSearchService } from '@/core/task/transcript-search.service';

import { EVENT_MISSING_MESSAGE, TranscriptMcpTools } from './transcript-mcp.tools';
import { connectTestClient, type IMcpTestClient } from '@/api/mcp/utils/mcp-test-client.util';

const STARTED = new Date('2026-10-26T09:00:00Z');

const taskAdminService = { getTranscript: vi.fn() };
const transcriptSearchService = { search: vi.fn(), hasMatchAfter: vi.fn() };

const searchRun = (): Run => {
  const run = new Run({
    taskId: 4,
    list: StepList.STEPS,
    step: 0,
    number: 1,
    startDate: STARTED,
    configId: null,
    agent: null,
  });
  run.id = 9;
  run.task = { triggerName: 'implement', projectPath: 'group/project' } as Task;

  return run;
};

describe('TranscriptMcpTools', () => {
  let mcp: IMcpTestClient;

  beforeEach(async () => {
    vi.clearAllMocks();

    mcp = await connectTestClient([
      new TranscriptMcpTools(
        taskAdminService as unknown as TaskAdminService,
        transcriptSearchService as unknown as TranscriptSearchService
      ),
    ]);
  });

  describe('get_transcript', () => {
    it('reads a page of 50 events unless asked for more', async () => {
      taskAdminService.getTranscript.mockResolvedValue({ events: [] });

      await mcp.call('get_transcript', { runId: 9, types: [TranscriptEventType.TOOL_CALL] });
      await mcp.call('get_transcript', {
        runId: 9,
        direction: TranscriptDirection.BACKWARD,
        beforeLine: 40,
        limit: 200,
      });

      expect(taskAdminService.getTranscript.mock.calls).toEqual([
        [9, { direction: TranscriptDirection.FORWARD, types: [TranscriptEventType.TOOL_CALL] }, 50],
        [9, { direction: TranscriptDirection.BACKWARD, beforeLine: 40 }, 200],
      ]);
    });

    it('reads forward from the line asked for', async () => {
      taskAdminService.getTranscript.mockResolvedValue({ events: [] });

      await mcp.call('get_transcript', { runId: 9, fromLine: 40 });

      expect(taskAdminService.getTranscript).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ direction: TranscriptDirection.FORWARD, fromLine: 40 }),
        50
      );
    });

    it("cuts each event's long fields", async () => {
      taskAdminService.getTranscript.mockResolvedValue({
        events: [{ type: TranscriptEventType.TOOL_RESULT, content: 'x'.repeat(2500), lineNumber: 4, index: 0 }],
        hasMore: false,
      });

      const { result } = await mcp.call('get_transcript', { runId: 9 });

      expect(result).toMatchObject({
        hasMore: false,
        events: [
          {
            lineNumber: 4,
            content: 'x'.repeat(2000),
            truncated: [{ field: 'content', from: 0, to: 2000, length: 2500 }],
          },
        ],
      });
    });

    it.each([
      ['beforeLine read forward', { runId: 9, beforeLine: 4 }],
      ['fromLine read backward', { runId: 9, direction: TranscriptDirection.BACKWARD, fromLine: 4 }],
    ])('refuses %s', async (_name, args) => {
      expect(await mcp.call('get_transcript', args)).toEqual({
        error: 'Give fromLine to read forward, or beforeLine to read backward.',
      });
      expect(taskAdminService.getTranscript).not.toHaveBeenCalled();
    });

    it('refuses a page over 200 events before reading', async () => {
      expect((await mcp.call('get_transcript', { runId: 9, limit: 201 })).error).toBeDefined();
      expect(taskAdminService.getTranscript).not.toHaveBeenCalled();
    });
  });

  describe('get_event', () => {
    it('reads one event of a line from an offset', async () => {
      taskAdminService.getTranscript.mockResolvedValue({
        events: [
          { type: TranscriptEventType.ASSISTANT_TEXT, text: 'Reading', lineNumber: 4, index: 0 },
          { type: TranscriptEventType.TOOL_RESULT, content: 'abcdef', lineNumber: 4, index: 1 },
        ],
      });

      const { result } = await mcp.call('get_event', { runId: 9, lineNumber: 4, index: 1, offset: 2 });

      expect(taskAdminService.getTranscript).toHaveBeenCalledWith(
        9,
        { direction: TranscriptDirection.FORWARD, fromLine: 4 },
        1
      );
      expect(result).toMatchObject({
        index: 1,
        content: 'cdef',
        truncated: [{ field: 'content', from: 2, to: 6, length: 6 }],
      });
    });

    it('reads up to 40,000 characters of each field', async () => {
      taskAdminService.getTranscript.mockResolvedValue({
        events: [{ type: TranscriptEventType.TOOL_RESULT, content: 'x'.repeat(50_000), lineNumber: 4, index: 0 }],
      });

      const { result } = await mcp.call('get_event', { runId: 9, lineNumber: 4 });

      expect(result).toMatchObject({
        content: 'x'.repeat(40_000),
        truncated: [{ field: 'content', from: 0, to: 40_000, length: 50_000 }],
      });
    });

    it('refuses an event that does not exist', async () => {
      taskAdminService.getTranscript.mockResolvedValue({
        events: [{ type: TranscriptEventType.ASSISTANT_TEXT, text: 'Reading', lineNumber: 5, index: 0 }],
      });

      expect(await mcp.call('get_event', { runId: 9, lineNumber: 4 })).toEqual({ error: EVENT_MISSING_MESSAGE });
    });
  });

  describe('search_transcripts', () => {
    it('searches with the scope and cursor given, and answers each run with its events and the next cursor', async () => {
      transcriptSearchService.search.mockResolvedValue({
        runs: [
          {
            run: searchRun(),
            events: [{ type: TranscriptEventType.ASSISTANT_TEXT, text: 'coupon', lineNumber: 3, match: true }],
          },
        ],
        next: { runId: 9, lineNumber: 3 },
      });

      const { result } = await mcp.call('search_transcripts', {
        query: 'coupon',
        trigger: 'implement',
        since: '2026-10-01',
        cursor: '12:40',
      });

      expect(transcriptSearchService.search.mock.calls[0][0]).toMatchObject({
        query: 'coupon',
        scope: { triggerName: 'implement', since: new Date('2026-10-01') },
        after: { runId: 12, lineNumber: 40 },
        eventLimit: 50,
        contextLines: 0,
      });
      expect(result).toMatchObject({
        runs: [
          {
            run: { id: 9, taskId: 4 },
            triggerName: 'implement',
            projectPath: 'group/project',
            events: [{ lineNumber: 3 }],
          },
        ],
        cursor: '9:3',
      });
    });

    it('lists only the matching runs with their match counts, reading every match on the page', async () => {
      const coupon = { type: TranscriptEventType.ASSISTANT_TEXT, text: 'coupon', match: true };
      transcriptSearchService.search.mockResolvedValue({
        runs: [{ run: searchRun(), events: [coupon, coupon] }],
        next: null,
      });

      const { result } = await mcp.call('search_transcripts', {
        query: 'coupon',
        runId: 9,
        output: 'runs',
        context: 2,
      });

      expect(transcriptSearchService.search.mock.calls[0][0]).toMatchObject({
        scope: { runId: 9 },
        eventLimit: Number.POSITIVE_INFINITY,
        lineLimit: 2000,
        contextLines: 0,
      });
      expect(result).toMatchObject({
        runs: [{ run: { id: 9 }, matchCount: 2, continuesOnNextPage: false }],
        cursor: null,
      });
      expect((result as { runs: object[] }).runs[0]).not.toHaveProperty('events');
    });

    it('marks a run as continuing only when a match lies past the cursor', async () => {
      const coupon = { type: TranscriptEventType.ASSISTANT_TEXT, text: 'coupon', match: true };
      transcriptSearchService.search.mockResolvedValue({
        runs: [{ run: searchRun(), events: [coupon] }],
        next: { runId: 9, lineNumber: 2400 },
      });

      transcriptSearchService.hasMatchAfter.mockResolvedValue(true);
      const continuing = await mcp.call('search_transcripts', { query: 'coupon', taskId: 4, output: 'runs' });

      transcriptSearchService.hasMatchAfter.mockResolvedValue(false);
      const ended = await mcp.call('search_transcripts', { query: 'coupon', taskId: 4, output: 'runs' });

      expect(continuing.result).toMatchObject({ runs: [{ continuesOnNextPage: true }], cursor: '9:2400' });
      expect(ended.result).toMatchObject({ runs: [{ continuesOnNextPage: false }] });
      expect(transcriptSearchService.hasMatchAfter.mock.calls[0][1]).toEqual({ runId: 9, lineNumber: 2400 });
    });

    it('passes the types asked for, and round-trips a cursor holding where a window ended', async () => {
      transcriptSearchService.search.mockResolvedValue({
        runs: [],
        next: { runId: 9, lineNumber: 40, returnedThrough: 35 },
      });

      const { result } = await mcp.call('search_transcripts', {
        query: 'coupon',
        taskId: 4,
        types: [TranscriptEventType.TOOL_RESULT],
        cursor: '12:30:28',
      });

      expect(transcriptSearchService.search.mock.calls[0][0]).toMatchObject({
        types: [TranscriptEventType.TOOL_RESULT],
        after: { runId: 12, lineNumber: 30, returnedThrough: 28 },
      });
      expect(result).toMatchObject({ cursor: '9:40:35' });
    });

    it('reads each page to at most 2000 matching lines', async () => {
      transcriptSearchService.search.mockResolvedValue({ runs: [], next: null });

      await mcp.call('search_transcripts', { query: 'coupon', taskId: 4 });

      expect(transcriptSearchService.search.mock.calls[0][0]).toMatchObject({ lineLimit: 2000 });
    });

    it('refuses a cursor past the largest id before searching', async () => {
      expect(
        (await mcp.call('search_transcripts', { query: 'coupon', taskId: 4, cursor: '99999999999:1' })).error
      ).toBeDefined();
      expect(transcriptSearchService.search).not.toHaveBeenCalled();
    });

    it('passes the context lines asked for', async () => {
      transcriptSearchService.search.mockResolvedValue({ runs: [], next: null });

      await mcp.call('search_transcripts', { query: 'coupon', taskId: 4, context: 2 });

      expect(transcriptSearchService.search.mock.calls[0][0]).toMatchObject({ contextLines: 2 });
    });
  });
});
