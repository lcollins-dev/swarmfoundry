import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';

import type { TranscriptEventType } from '@libs/dto';

import { RunTranscriptLine } from './entities/run-transcript-line.entity';
import { Run } from './entities/run.entity';
import { Task } from './entities/task.entity';

import type { TaskStatus } from './task.types';
import { parseTranscriptLine, type ITranscriptPage, type TranscriptEvent } from './transcript';

const TASK_MISSING_MESSAGE = "This task doesn't exist.";
const RUN_MISSING_MESSAGE = "This run doesn't exist.";

const TRANSCRIPT_BATCH_LINES = 100;

const TOKEN_COLUMNS = ['run.inputTokens', 'run.outputTokens', 'run.cacheReadTokens', 'run.cacheWriteTokens'];

/** Each field matches exactly. An absent one matches every task. */
export interface ITaskFilter {
  status?: TaskStatus;
  triggerName?: string;
  projectPath?: string;
}

export interface IRunTotals {
  runCount: number;
  /** The first run's start. */
  startDate: Date | null;
  /** Every kind summed. Null when no run recorded usage. */
  totalTokens: number | null;
  costUsd: number | null;
}

export interface ITaskSummary {
  task: Task;
  totals: IRunTotals;
}

export interface ITranscriptRead {
  fromLine: number;
  /** Every type when undefined. */
  types: readonly TranscriptEventType[] | undefined;
  /** A page stops at the first whole line that reaches it, so it may run a line's events over. */
  eventLimit: number;
  /** Bounds the lines one page reads, so a filter matching little returns early with `hasMore`. */
  lineLimit: number;
}

/** What the read API and the MCP tools answer from. Loads each task and run with its `config`. */
@Injectable()
export class TaskReadService {
  constructor(
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>,
    @InjectRepository(Run)
    private readonly runRepository: Repository<Run>,
    @InjectRepository(RunTranscriptLine)
    private readonly runTranscriptLineRepository: Repository<RunTranscriptLine>
  ) {}

  /** A page of the matching tasks, newest first, and how many match. */
  async findTasks(filter: ITaskFilter, skip: number, take: number): Promise<[ITaskSummary[], number]> {
    const [tasks, total] = await this.taskRepository.findAndCount({
      where: { status: filter.status, triggerName: filter.triggerName, projectPath: filter.projectPath },
      relations: { config: true },
      order: { queuedDate: 'DESC', id: 'DESC' },
      skip,
      take,
    });

    const totals = await this.runTotals(tasks.map(task => task.id));

    return [tasks.map(task => ({ task, totals: totals.get(task.id) ?? emptyTotals() })), total];
  }

  /** The task with its `runs`, in the order they started. */
  async findTaskWithThrow(taskId: number): Promise<ITaskSummary> {
    const task = await this.taskRepository.findOne({
      where: { id: taskId },
      relations: { config: true, runs: { config: true } },
      order: { runs: { startDate: 'ASC', id: 'ASC' } },
    });

    if (!task) {
      throw new BadRequestException(TASK_MISSING_MESSAGE);
    }

    const totals = await this.runTotals([task.id]);

    return { task, totals: totals.get(task.id) ?? emptyTotals() };
  }

  async findRunWithThrow(runId: number): Promise<Run> {
    const run = await this.runRepository.findOne({ where: { id: runId }, relations: { config: true } });

    if (!run) {
      throw new BadRequestException(RUN_MISSING_MESSAGE);
    }

    return run;
  }

  /** Parses each line on read, so a better parser reads every past run better. */
  async readTranscript(runId: number, read: ITranscriptRead): Promise<ITranscriptPage> {
    if (!(await this.runRepository.existsBy({ id: runId }))) {
      throw new BadRequestException(RUN_MISSING_MESSAGE);
    }

    const types = read.types === undefined ? null : new Set(read.types);
    const events: TranscriptEvent[] = [];

    let nextLine = read.fromLine;
    let linesRead = 0;
    let exhausted = false;

    while (!exhausted && events.length < read.eventLimit && linesRead < read.lineLimit) {
      const take = Math.min(TRANSCRIPT_BATCH_LINES, read.lineLimit - linesRead);
      const lines = await this.runTranscriptLineRepository.find({
        where: { runId, lineNumber: MoreThanOrEqual(nextLine) },
        order: { lineNumber: 'ASC' },
        take,
      });

      exhausted = lines.length < take;

      for (const line of lines) {
        if (events.length >= read.eventLimit) {
          break;
        }

        parseTranscriptLine(line.line).forEach((event, index) => {
          if (types === null || types.has(event.type)) {
            events.push({ ...event, lineNumber: line.lineNumber, index, storedDate: line.createdDate });
          }
        });

        nextLine = line.lineNumber + 1;
        linesRead++;
      }
    }

    // Lines are numbered from 1 without gaps, so the highest number is the count.
    const lineCount = (await this.runTranscriptLineRepository.maximum('lineNumber', { runId })) ?? 0;

    return { events, nextLine, hasMore: nextLine <= lineCount };
  }

  private async runTotals(taskIds: number[]): Promise<Map<number, IRunTotals>> {
    if (taskIds.length === 0) {
      return new Map();
    }

    const tokens = TOKEN_COLUMNS.map(column => `COALESCE(${column}, 0)`).join(' + ');

    const rows = await this.runRepository
      .createQueryBuilder('run')
      .select('run.taskId', 'taskId')
      .addSelect('COUNT(*)', 'runCount')
      .addSelect('MIN(run.startDate)', 'startDate')
      .addSelect(`SUM(${tokens}) FILTER (WHERE num_nonnulls(${TOKEN_COLUMNS.join(', ')}) > 0)`, 'totalTokens')
      .addSelect('SUM(run.costUsd)', 'costUsd')
      .where('run.taskId IN (:...taskIds)', { taskIds })
      .groupBy('run.taskId')
      .getRawMany<{
        taskId: number;
        runCount: string;
        startDate: Date;
        totalTokens: string | null;
        costUsd: string | null;
      }>();

    // Postgres answers a count and a sum of `int8` or `numeric` as text.
    return new Map(
      rows.map(row => [
        row.taskId,
        {
          runCount: Number(row.runCount),
          startDate: row.startDate,
          totalTokens: row.totalTokens === null ? null : Number(row.totalTokens),
          costUsd: row.costUsd === null ? null : Number(row.costUsd),
        },
      ])
    );
  }
}

function emptyTotals(): IRunTotals {
  return { runCount: 0, startDate: null, totalTokens: null, costUsd: null };
}
