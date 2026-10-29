import { z } from 'zod';

import { enumValue, text, timestamp, wholeNumberParam } from '../../../fields';
import { INT4_MAX, PageParamDto } from '../params';
import { RunEndReason, RunOutcome, StepList, TaskStatus } from './task';

export enum TranscriptEventType {
  SYSTEM_INIT = 'systemInit',
  ASSISTANT_TEXT = 'assistantText',
  TOOL_CALL = 'toolCall',
  TOOL_RESULT = 'toolResult',
  RATE_LIMIT = 'rateLimit',
  RESULT = 'result',

  /** A line or content block of any other kind, or one that does not parse. */
  UNKNOWN = 'unknown',
}

const TASK_FILTER_MAX_LENGTH = 512;

export const TaskListQueryDto = z.object({
  page: PageParamDto,
  status: enumValue(TaskStatus).optional(),
  trigger: text(1, TASK_FILTER_MAX_LENGTH).optional(),
  /** The project's path, such as `group/project`. */
  project: text(1, TASK_FILTER_MAX_LENGTH).optional(),
});
export type TaskListQueryDto = z.infer<typeof TaskListQueryDto>;

const TaskIssueDto = z.object({
  iid: z.number(),
  title: z.string(),
  url: z.string(),
});

const TaskMergeRequestDto = z.object({
  iid: z.number(),
  event: z.enum(['opened', 'merged']),
  title: z.string(),
  url: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
});

export const ListTaskDto = z.object({
  id: z.number(),
  kind: z.enum(['issue', 'schedule', 'mergeRequest']),
  triggerName: z.string(),
  sourceName: z.string(),
  projectPath: z.string(),
  projectUrl: z.string(),
  /** A merge request task's related issue, when it has one. Null for a scheduled task. */
  issue: TaskIssueDto.nullable(),
  mergeRequest: TaskMergeRequestDto.nullable(),
  /** A scheduled task's. */
  fireTime: timestamp().nullable(),
  status: z.enum(TaskStatus),
  /** With `step`, the step running, or the one to run next while queued. */
  list: z.enum(StepList),
  step: z.number(),
  runCount: z.number(),
  /** Every kind summed, cache reads and writes included. Null when no run recorded usage. */
  totalTokens: z.number().nullable(),
  /** API-equivalent for an `oauth` agent. Null when no run recorded a cost. */
  costUsd: z.number().nullable(),
  /** The config revision's commit. Null before the first run, and in local file mode. */
  configSha: z.string().nullable(),
  queuedDate: timestamp(),
  /** The first run's start. */
  startDate: timestamp().nullable(),
  endDate: timestamp().nullable(),
  /** A queued task waits until then, such as a retry's backoff. */
  notBeforeDate: timestamp().nullable(),
  cancelReason: z.string().nullable(),
});
export type ListTaskDto = z.infer<typeof ListTaskDto>;

export const TaskListResponseDto = z.object({
  /** Newest first. */
  taskList: z.array(ListTaskDto),
  pages: z.number(),
  /** How many tasks match the filters, across every page. */
  total: z.number(),
});
export type TaskListResponseDto = z.infer<typeof TaskListResponseDto>;

export const RunDto = z.object({
  id: z.number(),
  taskId: z.number(),
  list: z.enum(StepList),
  /** The index of the step in `list`. */
  step: z.number(),
  /** The try of its step, from 1. */
  number: z.number(),
  /** Null until the run is judged. */
  outcome: z.enum(RunOutcome).nullable(),
  /** Null until the run is judged. */
  endReason: z.enum(RunEndReason).nullable(),
  /** Null for a static step, and for an agent that never exited on its own. */
  exitCode: z.number().nullable(),
  configSha: z.string().nullable(),
  startDate: timestamp(),
  endDate: timestamp().nullable(),
  error: z.string().nullable(),
  /** Null for a static step, and for a run started before the agent was kept. */
  agent: z
    .object({
      name: z.string(),
      model: z.string(),
      auth: z.enum(['oauth', 'apiKey']),
    })
    .nullable(),
  // Usage, from an agent step's final result. Each is null without one.
  turns: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  /** API-equivalent for an `oauth` agent. */
  costUsd: z.number().nullable(),
});
export type RunDto = z.infer<typeof RunDto>;

export const TaskDto = ListTaskDto.extend({
  /** An issue task's issue when its trigger matched. Null for another kind, or a task queued before it was kept. */
  matchedIssue: z
    .object({
      labels: z.array(z.string()),
      author: z.string().nullable(),
      assignees: z.array(z.string()),
    })
    .nullable(),
  /** The label event or assignment an issue task matched on. */
  change: z
    .object({
      kind: z.enum(['label', 'assignment']),
      date: timestamp(),
      /** Null when GitLab no longer has the user. */
      actor: z.string().nullable(),
    })
    .nullable(),
  cron: z.string().nullable(),
  /** In the order they started. */
  runs: z.array(RunDto),
});
export type TaskDto = z.infer<typeof TaskDto>;

export const TranscriptQueryDto = z.object({
  /** The first line to read. */
  fromLine: wholeNumberParam(1, INT4_MAX).default(1),
  /** Comma separated. Every type when absent. */
  types: z
    .string()
    .transform(types => types.split(','))
    .pipe(z.array(enumValue(TranscriptEventType)))
    .optional(),
});
export type TranscriptQueryDto = z.infer<typeof TranscriptQueryDto>;

const transcriptEvent = <Type extends TranscriptEventType, Shape extends z.ZodRawShape>(type: Type, shape: Shape) =>
  z.object({
    type: z.literal(type),
    lineNumber: z.number(),
    /** The event's place within its line, from 0, since one line can hold text and tool calls. */
    index: z.number(),
    /** When the line was stored. */
    storedDate: timestamp(),
    /** The tool call that started the subagent that emitted it. Null for the main agent's. */
    parentToolUseId: z.string().nullable(),
    ...shape,
  });

export const TranscriptEventDto = z.discriminatedUnion('type', [
  transcriptEvent(TranscriptEventType.SYSTEM_INIT, {
    sessionId: z.string().nullable(),
    model: z.string().nullable(),
    cwd: z.string().nullable(),
    tools: z.array(z.string()),
    permissionMode: z.string().nullable(),
  }),
  transcriptEvent(TranscriptEventType.ASSISTANT_TEXT, {
    text: z.string(),
  }),
  transcriptEvent(TranscriptEventType.TOOL_CALL, {
    toolUseId: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  transcriptEvent(TranscriptEventType.TOOL_RESULT, {
    /** The `toolCall` it answers. */
    toolUseId: z.string(),
    /** The text parts joined, or the content as JSON when it holds any other part, such as an image. */
    content: z.string(),
    isError: z.boolean(),
  }),
  transcriptEvent(TranscriptEventType.RATE_LIMIT, {
    /** Such as `allowed_warning` or `rejected`. Null for a retry after a 429. */
    status: z.string().nullable(),
    /** Unix seconds. */
    resetsAt: z.number().nullable(),
    /** Set for a retry after a 429. */
    retryDelayMs: z.number().nullable(),
  }),
  transcriptEvent(TranscriptEventType.RESULT, {
    subtype: z.string(),
    isError: z.boolean(),
    text: z.string().nullable(),
    turns: z.number().nullable(),
    durationMs: z.number().nullable(),
    costUsd: z.number().nullable(),
  }),
  transcriptEvent(TranscriptEventType.UNKNOWN, {
    /** The line as stored, or the content block as JSON. */
    raw: z.string(),
  }),
]);
export type TranscriptEventDto = z.infer<typeof TranscriptEventDto>;

export const TranscriptResponseDto = z.object({
  /** In line order. A page holds whole lines, so a line's events never split across pages. */
  events: z.array(TranscriptEventDto),
  /** The line to read from next, past every line this page read. */
  nextLine: z.number(),
  /** Whether lines are stored from `nextLine` on. A running run may store more later. */
  hasMore: z.boolean(),
});
export type TranscriptResponseDto = z.infer<typeof TranscriptResponseDto>;
