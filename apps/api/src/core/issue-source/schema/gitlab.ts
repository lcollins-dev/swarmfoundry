import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value));

export const gitlabProjectSchema = z.object({
  id: z.int(),
  path_with_namespace: z.string(),
  web_url: z.string(),
});

export const gitlabIssueSchema = z.object({
  iid: z.int(),
  title: z.string(),
  state: z.string(),
  labels: z.array(z.string()),
  author: z.object({ username: z.string() }).nullish(),
  assignees: z.array(z.object({ username: z.string() })),
  web_url: z.string(),
  updated_at: timestamp,
});

export const gitlabLabelEventSchema = z.object({
  id: z.int(),
  action: z.string(),
  created_at: timestamp,
  user: z.object({ username: z.string() }).nullish(),
  // Null once the label is deleted.
  label: z.object({ name: z.string() }).nullable(),
});

export const gitlabNoteSchema = z.object({
  id: z.int(),
  body: z.string(),
  system: z.boolean(),
  created_at: timestamp,
  author: z.object({ username: z.string() }).nullish(),
});

export const gitlabMergeRequestSchema = z.object({
  iid: z.int(),
  title: z.string(),
  state: z.string(),
  labels: z.array(z.string()),
  source_branch: z.string(),
  target_branch: z.string(),
  web_url: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
  merged_at: timestamp.nullish(),
});

export const gitlabRelatedIssueSchema = z.object({
  iid: z.int(),
  project_id: z.int(),
  title: z.string(),
  web_url: z.string(),
});

export const gitlabUserSchema = z.object({
  id: z.int(),
  username: z.string(),
});

export type IGitLabProject = z.output<typeof gitlabProjectSchema>;
export type IGitLabIssue = z.output<typeof gitlabIssueSchema>;
export type IGitLabLabelEvent = z.output<typeof gitlabLabelEventSchema>;
export type IGitLabNote = z.output<typeof gitlabNoteSchema>;
export type IGitLabMergeRequest = z.output<typeof gitlabMergeRequestSchema>;
export type IGitLabRelatedIssue = z.output<typeof gitlabRelatedIssueSchema>;
