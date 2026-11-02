import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import type { TranscriptEventType } from '@libs/dto';

import { RunTranscriptLine } from './entities/run-transcript-line.entity';
import { Run } from './entities/run.entity';

import type { ParsedTranscriptEvent, TranscriptEvent } from './types/transcript.types';
import { eventMatches, parseTranscriptLine } from './utils/transcript.util';

export const SCOPE_MISSING_MESSAGE = 'Give a run, a task, a trigger or a date range to search within.';
export const DATE_RANGE_MESSAGE = 'Give a date range that ends after it starts.';

/** A date range alone may span no more than this, so a search with no run, task or trigger scans a bounded slice. */
export const DATE_RANGE_MAX_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const SEARCH_BATCH_LINES = 100;

/** Fields combine. A date range filters by the run's start. */
export interface ITranscriptSearchScope {
  runId?: number;
  taskId?: number;
  triggerName?: string;
  since?: Date;
  /** Now when absent. */
  until?: Date;
}

/** Where a page stopped. Runs read newest first, each run's lines in order. */
export interface ITranscriptSearchCursor {
  runId: number;
  /** The last line read. */
  lineNumber: number;
  /** The last line a context window returned, when an earlier line than `lineNumber`. */
  returnedThrough?: number;
}

export interface ITranscriptSearch {
  query: string;
  scope: ITranscriptSearchScope;
  /** Every type when undefined. */
  types: readonly TranscriptEventType[] | undefined;
  /** Null from the newest run. */
  after: ITranscriptSearchCursor | null;
  /** A page stops at the first whole line that reaches it. */
  eventLimit: number;
  /** Bounds the matching lines one page reads, since a raw match need not hold a matching event. */
  lineLimit: number;
  /** The lines either side of each match to add the kept events of. */
  contextLines: number;
}

export type TranscriptSearchEvent = TranscriptEvent & { match: boolean };

export interface ITranscriptSearchRun {
  /** With its `config` and `task`. */
  run: Run;
  /** In line order. */
  events: TranscriptSearchEvent[];
}

export interface ITranscriptSearchPage {
  /** Newest run first. */
  runs: ITranscriptSearchRun[];
  /** Null once no matching line is left. */
  next: ITranscriptSearchCursor | null;
}

@Injectable()
export class TranscriptSearchService {
  constructor(
    @InjectRepository(Run)
    private readonly runRepository: Repository<Run>,
    @InjectRepository(RunTranscriptLine)
    private readonly runTranscriptLineRepository: Repository<RunTranscriptLine>
  ) {}

  /**
   * Matches stored lines with `ILIKE`, then keeps the events whose own text matches. With context, each match brings
   * the lines around it, and a later match inside that window is read with it, its own lines after it included.
   */
  async search(search: ITranscriptSearch): Promise<ITranscriptSearchPage> {
    assertScoped(search.scope);

    const keep = keeper(search.types);
    const runEvents = new Map<number, TranscriptSearchEvent[]>();
    const returnedThrough = new Map<number, number>();

    if (search.after !== null) {
      returnedThrough.set(search.after.runId, search.after.returnedThrough ?? search.after.lineNumber);
    }

    let eventCount = 0;
    let linesRead = 0;
    let exhausted = false;
    let read = search.after;

    while (!exhausted && eventCount < search.eventLimit && linesRead < search.lineLimit) {
      const take = Math.min(SEARCH_BATCH_LINES, search.lineLimit - linesRead);
      const lines = await this.matchingLines(search, read, take);

      exhausted = lines.length < take;

      for (const line of lines) {
        if (eventCount >= search.eventLimit) {
          exhausted = false;
          break;
        }

        linesRead++;
        read = {
          runId: line.runId,
          lineNumber: Math.max(line.lineNumber, read?.runId === line.runId ? read.lineNumber : 0),
        };

        const through = returnedThrough.get(line.runId) ?? 0;

        if (line.lineNumber <= through || !hasMatch(line, search.query, keep)) {
          continue;
        }

        const window =
          search.contextLines === 0
            ? {
                events: placeEvents(line).filter(event => keep(event) && eventMatches(event, search.query)),
                end: line.lineNumber,
              }
            : await this.window(
                line,
                Math.max(1, line.lineNumber - search.contextLines, through + 1),
                search,
                keep,
                search.eventLimit - eventCount
              );

        const events = window.events.map(event => ({ ...event, match: eventMatches(event, search.query) }));

        runEvents.set(line.runId, [...(runEvents.get(line.runId) ?? []), ...events]);
        eventCount += events.length;
        returnedThrough.set(line.runId, window.end);
        read = { runId: line.runId, lineNumber: Math.max(read.lineNumber, window.end) };
      }
    }

    const runs = await this.runRepository.find({
      where: { id: In([...runEvents.keys()]) },
      relations: { config: true, task: true },
    });
    const runsById = new Map(runs.map(run => [run.id, run]));

    return {
      runs: [...runEvents].flatMap(([runId, events]) => {
        const run = runsById.get(runId);

        return run === undefined ? [] : [{ run, events }];
      }),
      next: exhausted || read === null ? null : cursorAt(read, returnedThrough.get(read.runId)),
    };
  }

  /** Whether the cursor's run holds a match after it, so its matches continue on the next page. */
  async hasMatchAfter(search: ITranscriptSearch, cursor: ITranscriptSearchCursor): Promise<boolean> {
    const keep = keeper(search.types);
    const runSearch = { ...search, scope: { ...search.scope, runId: cursor.runId } };

    let after: ITranscriptSearchCursor = cursor;

    for (;;) {
      const lines = await this.matchingLines(runSearch, after, SEARCH_BATCH_LINES);

      if (lines.some(line => hasMatch(line, search.query, keep))) {
        return true;
      }

      if (lines.length < SEARCH_BATCH_LINES) {
        return false;
      }

      after = { runId: cursor.runId, lineNumber: lines[lines.length - 1].lineNumber };
    }
  }

  /**
   * The kept events of the lines from `start` to `contextLines` after the last match, growing while a match falls in
   * the lines it adds. It stops growing once it holds `room` events, so a page stays one page.
   */
  private async window(
    line: RunTranscriptLine,
    start: number,
    search: ITranscriptSearch,
    keep: (event: ParsedTranscriptEvent) => boolean,
    room: number
  ): Promise<{ events: TranscriptEvent[]; end: number }> {
    const events: TranscriptEvent[] = [];

    let from = start;
    let end = line.lineNumber + search.contextLines;

    while (from <= end) {
      const lines = await this.runTranscriptLineRepository.find({
        where: { runId: line.runId, lineNumber: Between(from, end) },
        order: { lineNumber: 'ASC' },
      });

      let grownEnd = end;

      for (const windowLine of lines) {
        const kept = placeEvents(windowLine).filter(keep);

        events.push(...kept);

        if (windowLine.lineNumber > line.lineNumber && kept.some(event => eventMatches(event, search.query))) {
          grownEnd = windowLine.lineNumber + search.contextLines;
        }
      }

      if (grownEnd === end || events.length >= room || lines.length === 0) {
        break;
      }

      from = end + 1;
      end = grownEnd;
    }

    return { events, end };
  }

  private matchingLines(
    search: ITranscriptSearch,
    after: ITranscriptSearchCursor | null,
    take: number
  ): Promise<RunTranscriptLine[]> {
    const { runId, taskId, triggerName, since, until } = search.scope;

    const builder = this.runTranscriptLineRepository
      .createQueryBuilder('line')
      .innerJoin('line.run', 'run')
      .innerJoin('run.task', 'task')
      .where(`(line.line ILIKE :jsonPattern ESCAPE '\\' OR line.line ILIKE :plainPattern ESCAPE '\\')`, {
        jsonPattern: `%${escapeLike(jsonEscaped(search.query))}%`,
        plainPattern: `%${escapeLike(search.query)}%`,
      });

    if (runId !== undefined) {
      builder.andWhere('line.runId = :runId', { runId });
    }

    if (taskId !== undefined) {
      builder.andWhere('run.taskId = :taskId', { taskId });
    }

    if (triggerName !== undefined) {
      builder.andWhere('task.triggerName = :triggerName', { triggerName });
    }

    if (since !== undefined) {
      builder.andWhere('run.startDate >= :since', { since });
    }

    if (until !== undefined) {
      builder.andWhere('run.startDate < :until', { until });
    }

    if (after !== null) {
      builder.andWhere(
        '(line.runId < :afterRunId OR (line.runId = :afterRunId AND line.lineNumber > :afterLineNumber))',
        { afterRunId: after.runId, afterLineNumber: after.lineNumber }
      );
    }

    return builder.orderBy('line.runId', 'DESC').addOrderBy('line.lineNumber', 'ASC').limit(take).getMany();
  }
}

function assertScoped({ runId, taskId, triggerName, since, until }: ITranscriptSearchScope): void {
  if (since !== undefined && until !== undefined && until <= since) {
    throw new BadRequestException(DATE_RANGE_MESSAGE);
  }

  if (runId !== undefined || taskId !== undefined || triggerName !== undefined) {
    return;
  }

  if (since === undefined) {
    throw new BadRequestException(SCOPE_MISSING_MESSAGE);
  }

  const end = until ?? new Date();

  if (end.getTime() - since.getTime() > DATE_RANGE_MAX_DAYS * DAY_MS) {
    throw new BadRequestException(
      `Give a date range of ${DATE_RANGE_MAX_DAYS} days or less, or narrow the search to a run, task or trigger.`
    );
  }
}

const placeEvents = (line: RunTranscriptLine): TranscriptEvent[] =>
  parseTranscriptLine(line.line).map((event, index) => ({
    ...event,
    lineNumber: line.lineNumber,
    index,
    storedDate: line.createdDate,
  }));

const keeper =
  (types: readonly TranscriptEventType[] | undefined) =>
  (event: ParsedTranscriptEvent): boolean =>
    types === undefined || types.includes(event.type);

const hasMatch = (line: RunTranscriptLine, query: string, keep: (event: ParsedTranscriptEvent) => boolean): boolean =>
  parseTranscriptLine(line.line).some(event => keep(event) && eventMatches(event, query));

function cursorAt(read: ITranscriptSearchCursor, returnedThrough: number | undefined): ITranscriptSearchCursor {
  return returnedThrough === undefined || returnedThrough >= read.lineNumber
    ? { runId: read.runId, lineNumber: read.lineNumber }
    : { runId: read.runId, lineNumber: read.lineNumber, returnedThrough };
}

/** The query as stored inside a JSON string, so a quote or newline in a JSON line still matches. */
function jsonEscaped(query: string): string {
  return JSON.stringify(query).slice(1, -1);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, character => `\\${character}`);
}
