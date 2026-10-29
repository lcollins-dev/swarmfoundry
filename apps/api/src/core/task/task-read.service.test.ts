import { BadRequestException } from '@nestjs/common';
import type { FindManyOptions, FindOperator, Repository } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscriptEventType } from '@libs/dto';

import { RunTranscriptLine } from './entities/run-transcript-line.entity';
import type { Run } from './entities/run.entity';
import type { Task } from './entities/task.entity';

import { TaskReadService } from './task-read.service';

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
      const where = options.where as { lineNumber: FindOperator<number> };
      const from = where.lineNumber.value;

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
      expect(page).toMatchObject({ nextLine: 2, hasMore: false });
    });

    it('reads from the line asked for', async () => {
      const { service } = serviceOver([text('a'), text('b'), text('c')]);

      const page = await service.readTranscript(9, { ...read, fromLine: 2 });

      expect(page.events.map(event => event.lineNumber)).toEqual([2, 3]);
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

      expect(page).toEqual({ events: [], nextLine: 151, hasMore: true });
      expect(repository.find).toHaveBeenCalledTimes(2);
    });

    it('answers an empty last page for a run with no transcript', async () => {
      const { service } = serviceOver([]);

      await expect(service.readTranscript(9, read)).resolves.toEqual({ events: [], nextLine: 1, hasMore: false });
    });

    it('keeps the asked line as the next one when reading past the end', async () => {
      const { service } = serviceOver([text('a')]);

      await expect(service.readTranscript(9, { ...read, fromLine: 5 })).resolves.toEqual({
        events: [],
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
});
