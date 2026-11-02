import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThanOrEqual, Raw, Repository } from 'typeorm';

import type { TranscriptEventType } from '@libs/dto';

import { RunTranscriptLine } from './entities/run-transcript-line.entity';
import { Run } from './entities/run.entity';
import { Task } from './entities/task.entity';

import { StepList, TaskStatus } from './types/task.types';
import type { ITranscriptPage, TranscriptEvent } from './types/transcript.types';
import { parseTranscriptLine } from './utils/transcript.util';

const TASK_MISSING_MESSAGE = "This task doesn't exist.";
const RUN_MISSING_MESSAGE = "This run doesn't exist.";

const TRANSCRIPT_BATCH_LINES = 100;

const TOKEN_COLUMNS = ['run.inputTokens', 'run.outputTokens', 'run.cacheReadTokens', 'run.cacheWriteTokens'];

/** Each field matches exactly, the project path in any case as GitLab's does. An absent one matches every task. */
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
  /** The furthest index in `steps` a run reached. Null before any did. */
  furthestStep: number | null;
}

export interface ITaskSummary {
  task: Task;
  totals: IRunTotals;
}

/** A trigger's finished tasks over a window. A cancelled task counts in none of them, nor its runs' cost. */
export interface ITriggerStats {
  finishedCount: number;
  succeededCount: number;
  /** From 0 to 1. Null with no finished task. */
  successRate: number | null;
  /** From each task's first run start to its end. Null with no finished task that ran. */
  medianDurationMs: number | null;
  p90DurationMs: number | null;
  succeededCostUsd: number;
  failedCostUsd: number;
}

export interface ITriggerActivity {
  runningCount: number;
  queuedCount: number;
  /** When it last queued a task. Null when it never has. */
  lastFiredDate: Date | null;
  stats: ITriggerStats;
}

/** A trigger with no task. */
export const NO_ACTIVITY: ITriggerActivity = {
  runningCount: 0,
  queuedCount: 0,
  lastFiredDate: null,
  stats: statsOf([]),
};

interface ITranscriptReadLimits {
  /** Every type when undefined. */
  types: readonly TranscriptEventType[] | undefined;
  /** A page stops at the first whole line that reaches it, so it may run a line's events over. */
  eventLimit: number;
  /** Bounds the lines one page reads, so a filter matching little returns early with `hasMore` or `hasEarlier`. */
  lineLimit: number;
}

export interface ITranscriptRead extends ITranscriptReadLimits {
  fromLine: number;
}

export interface ITranscriptReadBefore extends ITranscriptReadLimits {
  /** Null reads back from the last line stored. */
  beforeLine: number | null;
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
      where: {
        status: filter.status,
        triggerName: filter.triggerName,
        projectPath:
          filter.projectPath === undefined
            ? undefined
            : Raw(column => `LOWER(${column}) = LOWER(:projectPath)`, { projectPath: filter.projectPath }),
      },
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

  /** Every queued task, in the order a dispatch pass starts them. */
  async findQueued(): Promise<ITaskSummary[]> {
    const tasks = await this.taskRepository.find({
      where: { status: TaskStatus.QUEUED },
      relations: { config: true },
      order: { queuedDate: 'ASC', id: 'ASC' },
    });

    const totals = await this.runTotals(tasks.map(task => task.id));

    return tasks.map(task => ({ task, totals: totals.get(task.id) ?? emptyTotals() }));
  }

  /** Whether any task ran on the config revision. */
  isConfigUsed(configId: number): Promise<boolean> {
    return this.taskRepository.existsBy({ configId });
  }

  /** Each trigger's tasks now, and its stats over the tasks that finished since `since`. By trigger name. */
  async findTriggerActivity(triggerNames: readonly string[], since: Date): Promise<Map<string, ITriggerActivity>> {
    const names = [...triggerNames];

    if (names.length === 0) {
      return new Map();
    }

    const [counts, lastFired, stats] = await Promise.all([
      this.countUnfinished(names),
      this.lastFiredDates(names),
      this.triggerStats(names, since),
    ]);

    return new Map(
      names.map(name => [
        name,
        {
          runningCount: counts.get(name)?.running ?? 0,
          queuedCount: counts.get(name)?.queued ?? 0,
          lastFiredDate: lastFired.get(name) ?? null,
          stats: stats.get(name) ?? NO_ACTIVITY.stats,
        },
      ])
    );
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
    await this.assertRunExists(runId);

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

        events.push(...lineEvents(line, types));

        nextLine = line.lineNumber + 1;
        linesRead++;
      }
    }

    return this.toPage(events, read.fromLine, nextLine, await this.countLines(runId));
  }

  /** Returns events in line order, like a forward page. */
  async readTranscriptBefore(runId: number, read: ITranscriptReadBefore): Promise<ITranscriptPage> {
    await this.assertRunExists(runId);

    const types = read.types === undefined ? null : new Set(read.types);

    // A line past the end reads back from the end, so a client going on forward from `nextLine` skips nothing.
    const lineCount = await this.countLines(runId);
    const endLine = Math.min(read.beforeLine ?? Infinity, lineCount + 1);

    const linesEvents: TranscriptEvent[][] = [];

    let eventCount = 0;
    let firstLine = endLine;
    let linesRead = 0;
    let exhausted = false;

    while (!exhausted && eventCount < read.eventLimit && linesRead < read.lineLimit) {
      const take = Math.min(TRANSCRIPT_BATCH_LINES, read.lineLimit - linesRead);
      const lines = await this.runTranscriptLineRepository.find({
        where: { runId, lineNumber: LessThan(firstLine) },
        order: { lineNumber: 'DESC' },
        take,
      });

      exhausted = lines.length < take;

      for (const line of lines) {
        if (eventCount >= read.eventLimit) {
          break;
        }

        const events = lineEvents(line, types);

        linesEvents.push(events);
        eventCount += events.length;

        firstLine = line.lineNumber;
        linesRead++;
      }
    }

    return this.toPage(linesEvents.reverse().flat(), firstLine, endLine, lineCount);
  }

  private async assertRunExists(runId: number): Promise<void> {
    if (!(await this.runRepository.existsBy({ id: runId }))) {
      throw new BadRequestException(RUN_MISSING_MESSAGE);
    }
  }

  /** Lines are numbered from 1 without gaps, so the highest number is the count. */
  private async countLines(runId: number): Promise<number> {
    return (await this.runTranscriptLineRepository.maximum('lineNumber', { runId })) ?? 0;
  }

  private toPage(events: TranscriptEvent[], firstLine: number, nextLine: number, lineCount: number): ITranscriptPage {
    return {
      events,
      firstLine,
      hasEarlier: firstLine > 1 && lineCount > 0,
      nextLine,
      hasMore: nextLine <= lineCount,
    };
  }

  private async countUnfinished(triggerNames: string[]): Promise<Map<string, { running: number; queued: number }>> {
    const rows = await this.taskRepository
      .createQueryBuilder('task')
      .select('task.triggerName', 'triggerName')
      .addSelect('task.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('task.triggerName IN (:...triggerNames)', { triggerNames })
      .andWhere('task.status IN (:...statuses)', { statuses: [TaskStatus.QUEUED, TaskStatus.RUNNING] })
      .groupBy('task.triggerName')
      .addGroupBy('task.status')
      .getRawMany<{ triggerName: string; status: TaskStatus; count: string }>();

    const counts = new Map<string, { running: number; queued: number }>();

    for (const row of rows) {
      const count = counts.get(row.triggerName) ?? { running: 0, queued: 0 };

      // Postgres answers a count as text.
      count[row.status === TaskStatus.RUNNING ? 'running' : 'queued'] = Number(row.count);
      counts.set(row.triggerName, count);
    }

    return counts;
  }

  private async lastFiredDates(triggerNames: string[]): Promise<Map<string, Date>> {
    const rows = await this.taskRepository
      .createQueryBuilder('task')
      .select('task.triggerName', 'triggerName')
      .addSelect('MAX(task.queuedDate)', 'lastFiredDate')
      .where('task.triggerName IN (:...triggerNames)', { triggerNames })
      .groupBy('task.triggerName')
      .getRawMany<{ triggerName: string; lastFiredDate: Date }>();

    return new Map(rows.map(row => [row.triggerName, row.lastFiredDate]));
  }

  private async triggerStats(triggerNames: string[], since: Date): Promise<Map<string, ITriggerStats>> {
    const tasks = await this.taskRepository.find({
      select: { id: true, triggerName: true, status: true, endDate: true },
      where: {
        triggerName: In(triggerNames),
        status: In([TaskStatus.SUCCEEDED, TaskStatus.FAILED]),
        endDate: MoreThanOrEqual(since),
      },
    });

    const totals = await this.runTotals(tasks.map(task => task.id));
    const finished = new Map<string, IFinishedTask[]>();

    for (const task of tasks) {
      const { startDate, costUsd } = totals.get(task.id) ?? emptyTotals();
      const durationMs =
        startDate === null || task.endDate === null ? null : task.endDate.getTime() - startDate.getTime();
      const list = finished.get(task.triggerName) ?? [];

      list.push({ succeeded: task.status === TaskStatus.SUCCEEDED, durationMs, costUsd: costUsd ?? 0 });
      finished.set(task.triggerName, list);
    }

    return new Map([...finished].map(([name, list]) => [name, statsOf(list)]));
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
      .addSelect('MAX(run.step) FILTER (WHERE run.list = :steps)', 'furthestStep')
      .where('run.taskId IN (:...taskIds)', { taskIds })
      .setParameter('steps', StepList.STEPS)
      .groupBy('run.taskId')
      .getRawMany<{
        taskId: number;
        runCount: string;
        startDate: Date;
        totalTokens: string | null;
        costUsd: string | null;
        furthestStep: number | null;
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
          furthestStep: row.furthestStep,
        },
      ])
    );
  }
}

interface IFinishedTask {
  succeeded: boolean;
  durationMs: number | null;
  costUsd: number;
}

function statsOf(tasks: readonly IFinishedTask[]): ITriggerStats {
  const durations = tasks
    .map(task => task.durationMs)
    .filter(durationMs => durationMs !== null)
    .sort((left, right) => left - right);
  const costOf = (succeeded: boolean) =>
    tasks.filter(task => task.succeeded === succeeded).reduce((sum, task) => sum + task.costUsd, 0);

  const succeededCount = tasks.filter(task => task.succeeded).length;

  return {
    finishedCount: tasks.length,
    succeededCount,
    successRate: tasks.length === 0 ? null : succeededCount / tasks.length,
    medianDurationMs: percentile(durations, 0.5),
    p90DurationMs: percentile(durations, 0.9),
    succeededCostUsd: costOf(true),
    failedCostUsd: costOf(false),
  };
}

/** Interpolates between the two nearest values, as Postgres's `percentile_cont` does. Null for no values. */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null;
  }

  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function emptyTotals(): IRunTotals {
  return { runCount: 0, startDate: null, totalTokens: null, costUsd: null, furthestStep: null };
}

const lineEvents = (line: RunTranscriptLine, types: ReadonlySet<TranscriptEventType> | null): TranscriptEvent[] =>
  parseTranscriptLine(line.line).flatMap((event, index) =>
    types === null || types.has(event.type)
      ? [{ ...event, lineNumber: line.lineNumber, index, storedDate: line.createdDate }]
      : []
  );
