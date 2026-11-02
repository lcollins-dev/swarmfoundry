import { BadRequestException } from '@nestjs/common';
import type { FindManyOptions, FindOperator, Repository } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscriptEventType } from '@libs/dto';

import { RunTranscriptLine } from './entities/run-transcript-line.entity';
import type { Run } from './entities/run.entity';
import type { Task } from './entities/task.entity';

import { percentile, TaskReadService } from './task-read.service';

const STORED = new Date('2026-10-26T10:00:00Z');

const text = (value: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: value }] } });

const textAndCall = (value: string) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: value },
        { type: 'tool_use', id: `toolu_${value}`, name: 'Bash', input: {} },
      ],
    },
  });

const toolResult = (id: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

/** The repository's `find` over `lines`, numbered from 1. */
const transcriptRepository = (lines: string[]) => {
  const rows = lines.map((line, index) => {
    const row = new RunTranscriptLine({ runId: 9, lineNumber: index + 1, line });
    row.createdDate = STORED;

    return row;
  });

  return {
    find: vi.fn((options: FindManyOptions<RunTranscriptLine>) => {
      const where = options.where as { lineNumber?: FindOperator<number> };
      const order = options.order as { lineNumber: 'ASC' | 'DESC' };

      if (order.lineNumber === 'DESC') {
        const before = where.lineNumber?.value ?? Infinity;

        return Promise.resolve(
          rows
            .filter(row => row.lineNumber < before)
            .reverse()
            .slice(0, options.take)
        );
      }

      const from = where.lineNumber?.value ?? 1;

      return Promise.resolve(rows.filter(row => row.lineNumber >= from).slice(0, options.take));
    }),
    maximum: vi.fn(() => Promise.resolve(rows.length === 0 ? null : rows.length)),
  };
};

describe('TaskReadService', () => {
  let runRepository: { existsBy: ReturnType<typeof vi.fn> };

  const serviceOver = (lines: string[]) => {
    const repository = transcriptRepository(lines);
    const service = new TaskReadService(
      {} as Repository<Task>,
      runRepository as unknown as Repository<Run>,
      repository as unknown as Repository<RunTranscriptLine>
    );

    return { service, repository };
  };

  const read = { fromLine: 1, types: undefined, eventLimit: 100, lineLimit: 1000 };

  beforeEach(() => {
    runRepository = { existsBy: vi.fn().mockResolvedValue(true) };
  });

  describe('readTranscript', () => {
    it('keys each event by its line, its place in the line and when the line was stored', async () => {
      const { service } = serviceOver([textAndCall('a')]);

      const page = await service.readTranscript(9, read);

      expect(page.events).toEqual([
        expect.objectContaining({
          type: TranscriptEventType.ASSISTANT_TEXT,
          lineNumber: 1,
          index: 0,
          storedDate: STORED,
        }),
        expect.objectContaining({ type: TranscriptEventType.TOOL_CALL, lineNumber: 1, index: 1, storedDate: STORED }),
      ]);
      expect(page).toMatchObject({ firstLine: 1, hasEarlier: false, nextLine: 2, hasMore: false });
    });

    it('reads from the line asked for', async () => {
      const { service } = serviceOver([text('a'), text('b'), text('c')]);

      const page = await service.readTranscript(9, { ...read, fromLine: 2 });

      expect(page.events.map(event => event.lineNumber)).toEqual([2, 3]);
      expect(page).toMatchObject({ firstLine: 2, hasEarlier: true });
    });

    it('stops at the first whole line that reaches the event limit, and says where to go on', async () => {
      const { service } = serviceOver([text('a'), textAndCall('b'), text('c')]);

      const page = await service.readTranscript(9, { ...read, eventLimit: 2 });

      expect(page.events.map(event => [event.lineNumber, event.index])).toEqual([
        [1, 0],
        [2, 0],
        [2, 1],
      ]);
      expect(page).toMatchObject({ nextLine: 3, hasMore: true });
    });

    it('keeps only the types asked for, reading past lines that hold none', async () => {
      const { service } = serviceOver([text('a'), toolResult('x'), text('b'), toolResult('y')]);

      const page = await service.readTranscript(9, { ...read, types: [TranscriptEventType.TOOL_RESULT] });

      expect(page.events.map(event => event.lineNumber)).toEqual([2, 4]);
      expect(page).toMatchObject({ nextLine: 5, hasMore: false });
    });

    it('stops at the line limit when the filter matches little', async () => {
      const lines = Array.from({ length: 250 }, (_unused, index) => text(String(index)));
      const { service, repository } = serviceOver(lines);

      const page = await service.readTranscript(9, { ...read, types: [TranscriptEventType.RESULT], lineLimit: 150 });

      expect(page).toEqual({ events: [], firstLine: 1, hasEarlier: false, nextLine: 151, hasMore: true });
      expect(repository.find).toHaveBeenCalledTimes(2);
    });

    it('answers an empty last page for a run with no transcript', async () => {
      const { service } = serviceOver([]);

      await expect(service.readTranscript(9, read)).resolves.toEqual({
        events: [],
        firstLine: 1,
        hasEarlier: false,
        nextLine: 1,
        hasMore: false,
      });
    });

    it('keeps the asked line as the next one when reading past the end', async () => {
      const { service } = serviceOver([text('a')]);

      await expect(service.readTranscript(9, { ...read, fromLine: 5 })).resolves.toEqual({
        events: [],
        firstLine: 5,
        hasEarlier: true,
        nextLine: 5,
        hasMore: false,
      });
    });

    it('throws for a run that does not exist', async () => {
      runRepository.existsBy.mockResolvedValue(false);
      const { service } = serviceOver([]);

      await expect(service.readTranscript(9, read)).rejects.toThrow(BadRequestException);
    });
  });

  describe('readTranscriptBefore', () => {
    const readBefore = { beforeLine: null, types: undefined, eventLimit: 100, lineLimit: 1000 };

    it('reads the last lines when no line is asked for, in line order, up to the line after the last', async () => {
      const { service } = serviceOver([text('a'), textAndCall('b'), text('c')]);

      const page = await service.readTranscriptBefore(9, { ...readBefore, eventLimit: 3 });

      expect(page.events.map(event => [event.lineNumber, event.index])).toEqual([
        [2, 0],
        [2, 1],
        [3, 0],
      ]);
      expect(page).toMatchObject({ firstLine: 2, hasEarlier: true, nextLine: 4, hasMore: false });
    });

    it('reads the lines before the line asked for, leaving it out', async () => {
      const { service } = serviceOver([text('a'), text('b'), text('c'), text('d')]);

      const page = await service.readTranscriptBefore(9, { ...readBefore, beforeLine: 3 });

      expect(page.events.map(event => event.lineNumber)).toEqual([1, 2]);
      expect(page).toMatchObject({ firstLine: 1, hasEarlier: false, nextLine: 3, hasMore: true });
    });

    it('reads back from the end for a line past it, so going on forward skips nothing', async () => {
      const { service } = serviceOver([text('a'), text('b'), text('c'), text('d'), text('e')]);

      const page = await service.readTranscriptBefore(9, { ...readBefore, beforeLine: 99 });

      expect(page.events.map(event => event.lineNumber)).toEqual([1, 2, 3, 4, 5]);
      expect(page).toMatchObject({ firstLine: 1, hasEarlier: false, nextLine: 6, hasMore: false });
    });

    it('answers an empty page from the first line for a line past the end of a run with no transcript', async () => {
      const { service } = serviceOver([]);

      await expect(service.readTranscriptBefore(9, { ...readBefore, beforeLine: 99 })).resolves.toEqual({
        events: [],
        firstLine: 1,
        hasEarlier: false,
        nextLine: 1,
        hasMore: false,
      });
    });

    it('stops at the first whole line that reaches the event limit', async () => {
      const { service } = serviceOver([text('a'), textAndCall('b'), text('c')]);

      const page = await service.readTranscriptBefore(9, { ...readBefore, eventLimit: 2 });

      expect(page.events.map(event => [event.lineNumber, event.index])).toEqual([
        [2, 0],
        [2, 1],
        [3, 0],
      ]);
      expect(page).toMatchObject({ firstLine: 2, hasEarlier: true });
    });

    it('keeps only the types asked for, reading back past lines that hold none', async () => {
      const { service } = serviceOver([toolResult('x'), text('a'), toolResult('y'), text('b')]);

      const page = await service.readTranscriptBefore(9, { ...readBefore, types: [TranscriptEventType.TOOL_RESULT] });

      expect(page.events.map(event => event.lineNumber)).toEqual([1, 3]);
      expect(page).toMatchObject({ firstLine: 1, hasEarlier: false, nextLine: 5 });
    });

    it('stops at the line limit when the filter matches little, saying where to go on', async () => {
      const lines = Array.from({ length: 250 }, (_unused, index) => text(String(index)));
      const { service, repository } = serviceOver(lines);

      const page = await service.readTranscriptBefore(9, {
        ...readBefore,
        types: [TranscriptEventType.RESULT],
        lineLimit: 150,
      });

      expect(page).toEqual({ events: [], firstLine: 101, hasEarlier: true, nextLine: 251, hasMore: false });
      expect(repository.find).toHaveBeenCalledTimes(2);
    });

    it('answers an empty page from the first line for a run with no transcript', async () => {
      const { service } = serviceOver([]);

      await expect(service.readTranscriptBefore(9, readBefore)).resolves.toEqual({
        events: [],
        firstLine: 1,
        hasEarlier: false,
        nextLine: 1,
        hasMore: false,
      });
    });

    it('throws for a run that does not exist', async () => {
      runRepository.existsBy.mockResolvedValue(false);
      const { service } = serviceOver([]);

      await expect(service.readTranscriptBefore(9, readBefore)).rejects.toThrow(BadRequestException);
    });
  });
});

describe('percentile', () => {
  it('interpolates between the nearest values, as percentile_cont does', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.9)).toBeCloseTo(37);
    expect(percentile([7], 0.9)).toBe(7);
  });

  it('is null for no values', () => {
    expect(percentile([], 0.5)).toBeNull();
  });
});
