import type { z } from 'zod';

import type { agentBlockSchema, agentDefinitionSchema } from './schema/agents';
import type { foundryConfigDocumentSchema } from './schema/document';
import type { environmentSchema } from './schema/environments';
import type { sourceSchema } from './schema/sources';
import type { agentStepSchema, stepSchema } from './schema/steps';
import type {
  issueBlockSchema,
  MERGE_REQUEST_EVENTS,
  mergeRequestBlockSchema,
  scheduleBlockSchema,
  triggerSchema,
} from './schema/triggers';

// The file as validated, before references and files are resolved.

export type IFoundryConfigDocument = z.output<typeof foundryConfigDocumentSchema>;
export type IAgentDefinition = z.output<typeof agentDefinitionSchema>;
export type IAgentBlock = z.output<typeof agentBlockSchema>;
export type ISourceDefinition = z.output<typeof sourceSchema>;
export type IEnvironmentDefinition = z.output<typeof environmentSchema>;
export type ITriggerDefinition = z.output<typeof triggerSchema>;
export type IStepDefinition = z.output<typeof stepSchema>;
export type IAgentStepDefinition = z.output<typeof agentStepSchema>;
export type IIssueBlock = z.output<typeof issueBlockSchema>;
export type IScheduleBlock = z.output<typeof scheduleBlockSchema>;
export type IMergeRequestBlock = z.output<typeof mergeRequestBlockSchema>;
export type MergeRequestEventKind = (typeof MERGE_REQUEST_EVENTS)[number];

// The loaded config. Durations are in milliseconds and `resources.memory` in bytes. Every file path is absolute.

export type ISourceConfig = ISourceDefinition & { name: string };

export type IEnvironmentConfig = Omit<IEnvironmentDefinition, 'agent'> & { name: string };

export interface IConfigFile {
  path: string;
  content: string;
}

export type IResolvedAgent = Omit<IAgentDefinition, 'settings' | 'instructions'> & {
  name: string;
  settings?: IConfigFile;
  instructions?: IConfigFile;
};

export type IAgentStepConfig = Omit<IAgentStepDefinition, 'environment' | 'agent' | 'prompt' | 'systemPrompt'> & {
  kind: 'agent';
  environment: IEnvironmentConfig;
  agent: IResolvedAgent;
  prompt: IConfigFile;
  systemPrompt?: IConfigFile;
};

export interface IRelabelStepConfig {
  kind: 'relabel';
  add: string[];
  remove: string[];
}

export interface ICommentStepConfig {
  kind: 'comment';
  body: string;
}

export interface IAssignStepConfig {
  kind: 'assign';
  usernames: string[];
}

export type IStaticStepConfig = IRelabelStepConfig | ICommentStepConfig | IAssignStepConfig;

export type IStepConfig = IAgentStepConfig | IStaticStepConfig;

export type StepKind = IStepConfig['kind'];

type ITriggerFields = Omit<
  ITriggerDefinition,
  'source' | 'steps' | 'failureSteps' | 'issue' | 'schedule' | 'mergeRequest'
> & {
  name: string;
  source: ISourceConfig;
  steps: IStepConfig[];

  /** An issue trigger that sets none gets one comment of `{{failure.report}}`. */
  failureSteps: IStepConfig[];
};

export type IIssueTriggerConfig = ITriggerFields & {
  issue: IIssueBlock;
  schedule?: undefined;
  mergeRequest?: undefined;
};

export type IScheduleTriggerConfig = ITriggerFields & {
  schedule: IScheduleBlock;
  issue?: undefined;
  mergeRequest?: undefined;
};

export type IMergeRequestTriggerConfig = ITriggerFields & {
  mergeRequest: IMergeRequestBlock;
  issue?: undefined;
  schedule?: undefined;
};

export type ITriggerConfig = IIssueTriggerConfig | IScheduleTriggerConfig | IMergeRequestTriggerConfig;

export interface IFoundryConfig {
  /** Null when no config file was found at the default path. */
  path: string | null;
  sources: ISourceConfig[];
  environments: IEnvironmentConfig[];
  triggers: ITriggerConfig[];
}

export interface ILoadedFoundryConfig {
  config: IFoundryConfig;
  /** None may reach a log line. */
  secrets: ReadonlySet<string>;
}

/** A bare clone of the config repo, following one branch. */
export interface IConfigRepo {
  url: string;
  branch: string;
  /** Blank sends no credentials. */
  token: string;
  gitDir: string;
}

export interface IConfigRevision {
  id: number;
  sha: string;
  loaded: ILoadedFoundryConfig;
}

export enum ConfigRevisionStatus {
  LOADED = 'loaded',
  FAILED = 'failed',
}

export interface IRedactionPatterns {
  /** Longest first. */
  plain: readonly string[];

  /** Null when no secret is long enough to mask encoded. */
  encoded: RegExp | null;
}

// Loading

export type KeyPath = readonly PropertyKey[];

/** Never carries a value from the file, so it is safe to print. */
export interface IConfigIssue {
  path: string;
  message: string;
}

export type VariableLookup = (name: string) => string | undefined;

export interface ISubstitutedValue {
  path: KeyPath;
  value: string;
}

export interface ISubstitution {
  value: unknown;
  issues: IConfigIssue[];
  substitutions: ISubstitutedValue[];
}

export interface IAgentLayer {
  path: KeyPath;
  block: IAgentBlock;
}

export interface IMergedAgentFields {
  fields: ReadonlyMap<string, unknown>;
  origins: ReadonlyMap<string, KeyPath>;
}

export interface IAgentResolution {
  name: string;
  agent: IAgentDefinition;
  origins: ReadonlyMap<string, KeyPath>;
}

export type AgentResolutionResult = { ok: true; resolution: IAgentResolution } | { ok: false; issues: IConfigIssue[] };

// Prompts

export type TriggerKind = 'issue' | 'schedule' | 'mergeRequest';

/** ISO 8601 times in UTC. A `last*` time is empty when the trigger has no such run. */
export interface IScheduleContext {
  fireTime: string;
  previousFireTime: string;
  nextFireTime: string;
  lastRunStart: string;
  lastSuccessEnd: string;
  lastFailureEnd: string;
}

export interface IMergeRequestContext {
  iid: number;
  url: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
}

/** Each safe to post on an issue as it stands: GitLab runs no quick action and notifies no mention in it. */
export interface IFailureContext {
  report: string;

  /** One line of inline code. */
  reason: string;
}

/**
 * Holds `issue` for a label trigger's task, and `schedule` for a scheduled trigger's. A merge request trigger's holds
 * `mergeRequest`, and `issue` too when the merge request relates to one. A step of `failureSteps` also gets `failure`.
 */
export interface IPromptContext {
  issue?: { iid: number; title: string; url: string };
  schedule?: IScheduleContext;
  mergeRequest?: IMergeRequestContext;
  failure?: IFailureContext;
  project: { path: string; url: string };
  trigger: { name: string };
  task: { id: number };
  run: { id: number | string };
}

export interface IUnknownVariable {
  name: string;
  line: number;
}

export interface IRenderedPrompts {
  prompt: string;
  systemPrompt?: string;
}
