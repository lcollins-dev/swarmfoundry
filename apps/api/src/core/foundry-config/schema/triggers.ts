import { z } from 'zod';

import { isCronExpression } from '../cron-schedule';
import { label, name, text, username } from './common';
import { stepSchema } from './steps';

export const DEFAULT_CONCURRENCY = 1;

export const issueBlockSchema = z.strictObject({
  labels: z.array(label).min(1, 'must list at least one label'),
  notLabels: z.array(label).default([]),
  anyAssignee: z.array(username).default([]),
  projects: z.array(text).default([]),
  expect: z.strictObject({ anyLabel: z.array(label).default([]) }).default({ anyLabel: [] }),
});

export const scheduleBlockSchema = z.strictObject({
  cron: z.string().refine(isCronExpression, 'must be a cron expression of five fields, such as 0 9 * * 1'),
  project: text.refine(
    project => !/^\d+$/.test(project),
    'must be a project path, since its agent clones the project by path'
  ),
});

export const MERGE_REQUEST_EVENTS = ['opened', 'merged'] as const;

export const mergeRequestBlockSchema = z.strictObject({
  event: z.enum(MERGE_REQUEST_EVENTS),
  targetBranch: text.optional(),
  labels: z.array(label).default([]),
  notLabels: z.array(label).default([]),
  projects: z.array(text).default([]),
});

export const triggerSchema = z
  .strictObject({
    source: name,
    steps: z.array(stepSchema).min(1, 'must list at least one step'),
    failureSteps: z.array(stepSchema).optional(),
    concurrency: z.int().min(1).default(DEFAULT_CONCURRENCY),
    issue: issueBlockSchema.optional(),
    schedule: scheduleBlockSchema.optional(),
    mergeRequest: mergeRequestBlockSchema.optional(),
  })
  .refine(
    trigger =>
      [trigger.issue, trigger.schedule, trigger.mergeRequest].filter(block => block !== undefined).length === 1,
    {
      message: 'must set exactly one of issue, schedule or mergeRequest, to say what starts it',
      // Zod skips a refine after an unknown key, so an old `when` block would hide the missing block until the next load.
      when: ({ value }) => typeof value === 'object' && value !== null,
    }
  );
