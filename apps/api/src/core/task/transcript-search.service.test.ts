import { BadRequestException } from '@nestjs/common';
import type { FindOperator, Repository } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscriptEventType } from '@libs/dto';

import { RunTranscriptLine } from './entities/run-transcript-line.entity';
import { Run } from './entities/run.entity';

import { TranscriptSearchService, type ITranscriptSearch } from './transcript-search.service';

import { StepList } from './types/task.types';

const NOW = new Date('2026-10-26T10:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const text = (value: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: value }] } });

const row = (runId: number, lineNumber: number, line: string) => {
  const transcriptLine = new RunTranscriptLine({ runId, lineNumber, line });
  transcriptLine.createdDate = NOW;

  return transcriptLine;
};

/** In the order the query reads them: newest run first, each run's lines in order. */
const ROWS = [
  row(9, 1, text('coupon one')),
  row(
    9,
    2,
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { coupon: 1 } }] },
    })
  ),
  row(9, 3, text('coupon two')),
  row(4, 1, text('coupon three')),
];

/** Honours the run scope, the cursor and `limit` alone, so every other scope matches every row. */
const lineRepository = (rows: RunTranscriptLine[]) => {
  const calls: { where: string; params?: Record<string, unknown> }[] = [];

  const createQueryBuilder = vi.fn(() => {
    let after: { runId: number; lineNumber: number } | null = null;
    let runId: number | null = null;
    let take = Infinity;

    const builder = {
      innerJoin: () => builder,
      where: (where: string, params?: Record<string, unknown>) => {
        calls.push({ where, params });

        return builder;
      },
      andWhere: (where: string, params?: Record<string, unknown>) => {
        calls.push({ where, params });

        if (params && 'runId' in params) {
          runId = Number(params.runId);
        }

        if (params && 'afterRunId' in params) {
          after = { runId: Number(params.afterRunId), lineNumber: Number(params.afterLineNumber) };
        }

        return builder;
      },
      orderBy: () => builder,
      addOrderBy: () => builder,
      limit: (limit: number) => {
        take = limit;

        return builder;
      },
      getMany: () => {
        const from =
          after === null
            ? rows
            : rows.filter(
                line =>
                  line.runId < after!.runId || (line.runId === after!.runId && line.lineNumber > after!.lineNumber)
              );

        return Promise.resolve(from.filter(line => runId === null || line.runId === runId).slice(0, take));
      },
    };

    return builder;
  });

  const find = vi.fn((options: { where: { runId: number; lineNumber: FindOperator<number[]> } }) => {
    const [from, to] = options.where.lineNumber.value;

    return Promise.resolve(
      rows.filter(line => line.runId === options.where.runId && line.lineNumber >= from && line.lineNumber <= to)
    );
  });

  return {
    repository: { createQueryBuilder, find } as unknown as Repository<RunTranscriptLine>,
    createQueryBuilder,
    calls,
  };
};

const runRepository = {
  find: vi.fn(() =>
    Promise.resolve(
      [9, 4].map(id => {
        const run = new Run({
          taskId: id * 10,
          list: StepList.STEPS,
          step: 0,
          number: 1,
          startDate: NOW,
          configId: null,
          agent: null,
        });
        run.id = id;

        return run;
      })
    )
  ),
} as unknown as Repository<Run>;

const search = (overrides: Partial<ITranscriptSearch> = {}): ITranscriptSearch => ({
  query: 'coupon',
  scope: { triggerName: 'implement' },
  types: undefined,
  after: null,
  eventLimit: 200,
  lineLimit: 2000,
  contextLines: 0,
  ...overrides,
});

describe('TranscriptSearchService', () => {
  let lines: ReturnType<typeof lineRepository>;
  let service: TranscriptSearchService;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });

    lines = lineRepository(ROWS);
    service = new TranscriptSearchService(runRepository, lines.repository);
  });

  describe('scope', () => {
    it.each([
      ['no scope', {}],
      ['a date range alone over 30 days', { since: new Date(NOW.getTime() - 31 * DAY_MS) }],
      ['a range that ends before it starts', { triggerName: 'implement', since: NOW, until: NOW }],
    ])('refuses %s', async (_name, scope) => {
      await expect(service.search(search({ scope }))).rejects.toThrow(BadRequestException);
      expect(lines.createQueryBuilder).not.toHaveBeenCalled();
    });

    it.each([
      ['a run', { runId: 9 }],
      ['a task', { taskId: 3 }],
      ['a trigger over any range', { triggerName: 'implement', since: new Date('2025-01-01T00:00:00Z') }],
      ['a date range alone of 30 days', { since: new Date(NOW.getTime() - 30 * DAY_MS) }],
    ])('accepts %s', async (_name, scope) => {
      await expect(service.search(search({ scope }))).resolves.toBeDefined();
    });
  });

  it("escapes LIKE's wildcards in the query as stored inside a JSON string", async () => {
    await service.search(search({ query: '50%_"off"' }));

    expect(lines.calls[0].params).toEqual({
      jsonPattern: '%50\\%\\_\\\\"off\\\\"%',
      plainPattern: '%50\\%\\_"off"%',
    });
  });

  it('keeps the events whose own text matches, grouped by run in the order read', async () => {
    const page = await service.search(search());

    expect(page.runs.map(({ run, events }) => [run.id, events.map(event => event.lineNumber)])).toEqual([
      [9, [1, 3]],
      [4, [1]],
    ]);
    expect(page.next).toBeNull();
  });

  it('narrows to a run', async () => {
    await service.search(search({ scope: { runId: 9 } }));

    expect(lines.calls).toContainEqual({ where: 'line.runId = :runId', params: { runId: 9 } });
  });

  describe('with context', () => {
    const placed = (page: Awaited<ReturnType<TranscriptSearchService['search']>>) =>
      page.runs.map(({ run, events }) => [run.id, events.map(event => [event.lineNumber, event.type, event.match])]);

    it('adds the events of the lines around a match, counting them toward the limit', async () => {
      const page = await service.search(search({ contextLines: 1, eventLimit: 1 }));

      expect(placed(page)).toEqual([
        [
          9,
          [
            [1, TranscriptEventType.ASSISTANT_TEXT, true],
            [2, TranscriptEventType.TOOL_CALL, false],
          ],
        ],
      ]);
      expect(page.next).toEqual({ runId: 9, lineNumber: 2 });
    });

    it('marks a later match inside the window and reads it once', async () => {
      const page = await service.search(search({ contextLines: 2 }));

      expect(placed(page)).toEqual([
        [
          9,
          [
            [1, TranscriptEventType.ASSISTANT_TEXT, true],
            [2, TranscriptEventType.TOOL_CALL, false],
            [3, TranscriptEventType.ASSISTANT_TEXT, true],
          ],
        ],
        [4, [[1, TranscriptEventType.ASSISTANT_TEXT, true]]],
      ]);
    });

    const serviceOver = (rows: RunTranscriptLine[]) =>
      new TranscriptSearchService(runRepository, lineRepository(rows).repository);

    it('starts a window before a line that matched only in its JSON', async () => {
      const page = await serviceOver([row(9, 1, text('hello')), ROWS[1], row(9, 3, text('coupon two'))]).search(
        search({ contextLines: 1 })
      );

      expect(placed(page)).toEqual([
        [
          9,
          [
            [2, TranscriptEventType.TOOL_CALL, false],
            [3, TranscriptEventType.ASSISTANT_TEXT, true],
          ],
        ],
      ]);
    });

    it('grows a window to the context lines after a later match inside it', async () => {
      const lines = ['a', 'coupon', 'b', 'coupon', 'c', 'd', 'e', 'f'].map((value, index) =>
        row(9, index + 1, text(value))
      );

      const page = await serviceOver(lines).search(search({ contextLines: 2 }));

      expect(page.runs[0].events.map(event => [event.lineNumber, event.match])).toEqual([
        [1, false],
        [2, true],
        [3, false],
        [4, true],
        [5, false],
        [6, false],
      ]);
      expect(page.next).toBeNull();
    });

    it('keeps only the types asked for, and starts after the lines a page already read', async () => {
      const page = await service.search(
        search({ contextLines: 1, types: [TranscriptEventType.ASSISTANT_TEXT], after: { runId: 9, lineNumber: 2 } })
      );

      expect(placed(page)).toEqual([
        [9, [[3, TranscriptEventType.ASSISTANT_TEXT, true]]],
        [4, [[1, TranscriptEventType.ASSISTANT_TEXT, true]]],
      ]);
    });
  });

  it('keeps only the types asked for', async () => {
    const page = await service.search(search({ types: [TranscriptEventType.TOOL_CALL] }));

    expect(page.runs).toEqual([]);
  });

  it('stops at the first whole line that reaches the event limit, and goes on from its cursor', async () => {
    const first = await service.search(search({ eventLimit: 1 }));

    expect(first.runs.map(({ run }) => run.id)).toEqual([9]);
    expect(first.next).toEqual({ runId: 9, lineNumber: 1 });

    const second = await service.search(search({ eventLimit: 1, after: first.next }));

    expect(second.runs[0].events.map(event => event.lineNumber)).toEqual([3]);
    expect(second.next).toEqual({ runId: 9, lineNumber: 3 });
  });

  describe('hasMatchAfter', () => {
    it("is true while the cursor's run holds a match after it, past lines that match only in their JSON", async () => {
      await expect(service.hasMatchAfter(search(), { runId: 9, lineNumber: 1 })).resolves.toBe(true);
    });

    it("is false after the run's last match, whatever later runs hold", async () => {
      await expect(service.hasMatchAfter(search(), { runId: 9, lineNumber: 3 })).resolves.toBe(false);
    });
  });

  it('stops at the line limit when lines match only in their JSON', async () => {
    const page = await service.search(search({ lineLimit: 2, after: null, types: [TranscriptEventType.TOOL_CALL] }));

    expect(page.runs).toEqual([]);
    expect(page.next).toEqual({ runId: 9, lineNumber: 2 });
  });
});
