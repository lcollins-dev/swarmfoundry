import { z } from 'zod';

import { timestamp } from '../../../fields';
import { ListTaskDto } from '../task/admin';

const AgentStepDto = z.object({
  kind: z.literal('agent'),
  environment: z.string(),
  agent: z.object({
    name: z.string(),
    model: z.string(),
    auth: z.enum(['oauth', 'apiKey']),
    /** Null when only each trigger caps it. */
    concurrency: z.number().nullable(),
  }),
  /** Each path as the config writes it, relative to the config folder. */
  prompt: z.string(),
  systemPrompt: z.string().nullable(),
  timeoutMs: z.number(),
});

const RelabelStepDto = z.object({
  kind: z.literal('relabel'),
  add: z.array(z.string()),
  remove: z.array(z.string()),
});

const CommentStepDto = z.object({
  kind: z.literal('comment'),
  /** The template as configured, secrets masked. */
  body: z.string(),
});

const AssignStepDto = z.object({
  kind: z.literal('assign'),
  usernames: z.array(z.string()),
});

export const TriggerStepDto = z.discriminatedUnion('kind', [
  AgentStepDto,
  RelabelStepDto,
  CommentStepDto,
  AssignStepDto,
]);
export type TriggerStepDto = z.infer<typeof TriggerStepDto>;

export const TriggerStatsDto = z.object({
  /** Succeeded and failed tasks. A cancelled task counts in none of these, nor its runs' cost, even after a step ran. */
  finishedCount: z.number(),
  succeededCount: z.number(),
  /** From 0 to 1. Null with no finished task. */
  successRate: z.number().nullable(),
  /** From each task's first run start to its end. Null with no finished task that ran. */
  medianDurationMs: z.number().nullable(),
  p90DurationMs: z.number().nullable(),
  /** API-equivalent for an `oauth` agent. */
  succeededCostUsd: z.number(),
  failedCostUsd: z.number(),
});
export type TriggerStatsDto = z.infer<typeof TriggerStatsDto>;

export const TriggerDto = z.object({
  name: z.string(),
  /** Which one of `issue`, `schedule` and `mergeRequest` is set. */
  kind: z.enum(['issue', 'schedule', 'mergeRequest']),
  sourceName: z.string(),
  issue: z
    .object({
      labels: z.array(z.string()),
      notLabels: z.array(z.string()),
      anyAssignee: z.array(z.string()),
      /** Empty for every project of the source. */
      projects: z.array(z.string()),
      expect: z.object({ anyLabel: z.array(z.string()) }),
    })
    .nullable(),
  schedule: z
    .object({
      /** Five fields, read in UTC. */
      cron: z.string(),
      project: z.string(),
    })
    .nullable(),
  mergeRequest: z
    .object({
      event: z.enum(['opened', 'merged']),
      /** Null for any branch. */
      targetBranch: z.string().nullable(),
      labels: z.array(z.string()),
      notLabels: z.array(z.string()),
      projects: z.array(z.string()),
    })
    .nullable(),
  steps: z.array(TriggerStepDto),
  failureSteps: z.array(TriggerStepDto),
  concurrency: z.number(),
  /** Its tasks running now, each holding one of `concurrency`'s slots. */
  runningCount: z.number(),
  queuedCount: z.number(),
  /** When it last queued a task. */
  lastFiredDate: timestamp().nullable(),
  /** Over the tasks that finished in the last 7 days. */
  stats: TriggerStatsDto,
});
export type TriggerDto = z.infer<typeof TriggerDto>;

export const TriggerListResponseDto = z.object({
  /** The running config's, in its order. */
  triggerList: z.array(TriggerDto),
  /** The running config revision's commit. Null when the config loads from a local file. */
  configSha: z.string().nullable(),
});
export type TriggerListResponseDto = z.infer<typeof TriggerListResponseDto>;

export const QueueWaitDto = z.discriminatedUnion('reason', [
  z.object({
    reason: z.literal('noFreeSlot'),
    /** The cap that is full: the trigger's `concurrency`, or that of its step's agent. */
    on: z.enum(['trigger', 'agent']),
    name: z.string(),
    /** Running now, and taken by ready tasks ahead in the queue. */
    inUse: z.number(),
    limit: z.number(),
  }),
  z.object({
    /** After a retry's backoff, or an issue that could not be read before starting. */
    reason: z.literal('heldBack'),
    until: timestamp(),
  }),
  z.object({
    /** The next dispatch pass starts it. */
    reason: z.literal('ready'),
  }),
  z.object({
    /** Its trigger, or the step it waits at, is not in the running config, so it never starts. */
    reason: z.literal('notInConfig'),
  }),
]);
export type QueueWaitDto = z.infer<typeof QueueWaitDto>;

export const QueuedTaskDto = ListTaskDto.extend({
  wait: QueueWaitDto,
});
export type QueuedTaskDto = z.infer<typeof QueuedTaskDto>;

export const QueueResponseDto = z.object({
  /** Every queued task, in the order they start. */
  queue: z.array(QueuedTaskDto),
});
export type QueueResponseDto = z.infer<typeof QueueResponseDto>;

export const SourceDto = z.object({
  name: z.string(),
  type: z.enum(['gitlab']),
  url: z.string(),
  projects: z.array(z.string()),
  pollIntervalMs: z.number(),
  /** Null until the first poll since startup ends. */
  lastPoll: z
    .object({
      endDate: timestamp(),
      /** False when the poll failed, or failed to read any project. */
      succeeded: z.boolean(),
      /** Why the whole poll failed. */
      error: z.string().nullable(),
      failedProjects: z.array(z.object({ project: z.string(), error: z.string() })),
    })
    .nullable(),
  /** Null while a poll runs. */
  nextPollDate: timestamp().nullable(),
});
export type SourceDto = z.infer<typeof SourceDto>;

export const SourceListResponseDto = z.object({
  sourceList: z.array(SourceDto),
});
export type SourceListResponseDto = z.infer<typeof SourceListResponseDto>;
