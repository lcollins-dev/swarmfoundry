import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { LineCounter, parseDocument } from 'yaml';

import { AgentResolutionService } from './agent-resolution.service';
import { PromptTemplateService } from './prompt-template.service';
import { SecretRedactionService } from './secret-redaction.service';
import { VariableSubstitutionService } from './variable-substitution.service';

import { FoundryConfigError, issueAt, issuesFromZod } from './foundry-config.error';
import { foundryConfigDocumentSchema } from './schema/document';
import type {
  IAgentLayer,
  IAgentStepConfig,
  IAgentStepDefinition,
  IConfigFile,
  IConfigIssue,
  IEnvironmentConfig,
  IFoundryConfigDocument,
  IIssueBlock,
  ILoadedFoundryConfig,
  IMergeRequestBlock,
  IResolvedAgent,
  IScheduleBlock,
  ISourceConfig,
  IStaticStepConfig,
  IStepConfig,
  IStepDefinition,
  ITriggerConfig,
  ITriggerDefinition,
  KeyPath,
  TriggerKind,
} from './types/foundry-config.types';
import { triggerKindOf } from './utils/trigger-kind.util';

const KIND_DESCRIPTIONS: Record<TriggerKind, string> = {
  issue: '',
  schedule: ' of a scheduled trigger',
  mergeRequest: ' of a merge request trigger',
};

/** What an issue trigger with no `failureSteps` runs. `failureSteps: []` runs nothing. */
export const DEFAULT_ISSUE_FAILURE_STEPS: readonly IStepConfig[] = [
  { kind: 'comment', body: '{{failure.report}}', written: { body: '{{failure.report}}' } },
];

/** Stops a small file unfolding into a huge one through aliases. */
const MAX_ALIAS_COUNT = 100;

type Environment = Readonly<Record<string, string | undefined>>;

export interface ILoadRules {
  /** Fills `${VAR}` from a `.env` beside the file too, after the environment. */
  readDotEnv: boolean;
  /** Refuses any file the config references outside this directory. */
  root?: string;
}

const LOCAL_FILE_RULES: ILoadRules = { readDotEnv: true };

interface ILoadContext {
  directory: string;
  root?: string;
  document: IFoundryConfigDocument;

  /** The tree before `${VAR}` is substituted, shaped as `document` was before parsing. */
  written: unknown;
  issues: IConfigIssue[];
  files: Map<string, string>;
}

interface ITemplateRules {
  triggerKind: TriggerKind;

  /** Allows `{{failure.*}}`. */
  failure: boolean;
}

interface IEnvironments {
  configs: ReadonlyMap<string, IEnvironmentConfig>;
  agentLayers: ReadonlyMap<string, IAgentLayer>;
}

@Injectable()
export class FoundryConfigLoaderService {
  constructor(
    private readonly variableSubstitutionService: VariableSubstitutionService,
    private readonly agentResolutionService: AgentResolutionService,
    private readonly promptTemplateService: PromptTemplateService,
    private readonly secretRedactionService: SecretRedactionService
  ) {}

  /** Throws a `FoundryConfigError` naming every problem found. */
  load(configPath: string, environment: Environment, rules: ILoadRules = LOCAL_FILE_RULES): ILoadedFoundryConfig {
    const path = resolve(configPath);
    const directory = dirname(path);

    let secrets: ReadonlySet<string> = new Set();
    const fail = (issues: readonly IConfigIssue[]) => this.configError(path, issues, secrets);

    let text: string;

    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw fail([issueAt([], `cannot be read (${this.errorCode(error)})`)]);
    }

    const yaml = this.parseYaml(text);

    if (yaml.issues.length > 0) {
      throw fail(yaml.issues);
    }

    const dotEnv = rules.readDotEnv ? this.readDotEnv(directory) : {};
    const substitution = this.variableSubstitutionService.substitute(
      yaml.tree,
      name => environment[name] ?? dotEnv[name]
    );

    // Until every reference resolves, a token still reads `${VAR}`, which the error must show.
    const resolvedTree = substitution.issues.length > 0 ? {} : substitution.value;
    secrets = this.secretRedactionService.collect(resolvedTree, substitution.substitutions);

    if (substitution.issues.length > 0) {
      throw fail(substitution.issues);
    }

    const parsed = foundryConfigDocumentSchema.safeParse(substitution.value);

    if (!parsed.success) {
      throw fail(issuesFromZod(parsed.error.issues));
    }

    const context: ILoadContext = {
      directory,
      root: rules.root,
      document: parsed.data,
      written: yaml.tree,
      issues: [],
      files: new Map([[path, text]]),
    };

    this.checkAgentFiles(context);

    const sources = this.buildSources(context);
    const environments = this.buildEnvironments(context);
    const triggers = Object.entries(context.document.triggers)
      .map(([name, trigger]) => this.buildTrigger(context, name, trigger, sources, environments))
      .filter(trigger => trigger !== undefined);

    if (context.issues.length > 0) {
      throw fail(context.issues);
    }

    return {
      config: {
        path,
        sources: [...sources.values()],
        environments: [...environments.configs.values()],
        triggers,
      },
      secrets,
      files: context.files,
    };
  }

  private configError(path: string, issues: readonly IConfigIssue[], secrets: ReadonlySet<string>): FoundryConfigError {
    const unique = new Map<string, IConfigIssue>();

    for (const issue of issues) {
      const redacted = {
        path: this.secretRedactionService.redactText(issue.path, secrets),
        message: this.secretRedactionService.redactText(issue.message, secrets),
      };
      unique.set(`${redacted.path}: ${redacted.message}`, redacted);
    }

    return new FoundryConfigError(path, [...unique.values()]);
  }

  private parseYaml(text: string): { tree?: unknown; issues: IConfigIssue[] } {
    const lineCounter = new LineCounter();
    const document = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true, merge: true });

    // Only the first error and only its code: the messages quote source text, which may hold a token, and later
    // errors are mostly knock-on effects of the first.
    if (document.errors.length > 0) {
      const firstError = document.errors[0];
      const { line, col } = lineCounter.linePos(firstError.pos[0]);

      return { issues: [{ path: `line ${line}, column ${col}`, message: `YAML syntax error (${firstError.code})` }] };
    }

    try {
      return { tree: this.withoutExtensionKeys(document.toJS({ maxAliasCount: MAX_ALIAS_COUNT })), issues: [] };
    } catch (error) {
      return { issues: [issueAt([], error instanceof Error ? error.message : 'cannot be read as YAML')] };
    }
  }

  /** Top-level `x-*` keys hold anchors for the rest of the file to merge in, and are not config. */
  private withoutExtensionKeys(tree: unknown): unknown {
    if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) {
      return tree;
    }

    return Object.fromEntries(Object.entries(tree).filter(([key]) => !key.startsWith('x-')));
  }

  /** The process environment wins over a `.env` beside the config file. */
  private readDotEnv(directory: string): Environment {
    const path = join(directory, '.env');

    return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  }

  /** Checks a definition's files even when no trigger resolves to it. */
  private checkAgentFiles(context: ILoadContext): void {
    for (const [name, agent] of Object.entries(context.document.agents)) {
      if (agent.settings !== undefined) {
        this.readSettings(context, agent.settings, ['agents', name, 'settings']);
      }

      if (agent.instructions !== undefined) {
        this.readFile(context, agent.instructions, ['agents', name, 'instructions']);
      }
    }
  }

  private buildSources(context: ILoadContext): ReadonlyMap<string, ISourceConfig> {
    return new Map(
      Object.entries(context.document.sources).map(([name, source]) => {
        const written = { url: this.writtenText(context, ['sources', name, 'url'], source.url) };

        return [name, { name, ...source, written }];
      })
    );
  }

  private buildEnvironments(context: ILoadContext): IEnvironments {
    const configs = new Map<string, IEnvironmentConfig>();
    const agentLayers = new Map<string, IAgentLayer>();

    for (const [name, definition] of Object.entries(context.document.environments)) {
      const { image, agent, env, mounts, services, resources } = definition;
      configs.set(name, { name, image, env, mounts, services, resources });

      if (agent !== undefined) {
        const layer = { path: ['environments', name, 'agent'], block: agent };
        agentLayers.set(name, layer);
        this.resolveAgent(context, [layer]);
      }
    }

    return { configs, agentLayers };
  }

  private buildTrigger(
    context: ILoadContext,
    name: string,
    trigger: ITriggerDefinition,
    sources: ReadonlyMap<string, ISourceConfig>,
    environments: IEnvironments
  ): ITriggerConfig | undefined {
    const keyPath = ['triggers', name];
    const source = sources.get(trigger.source);

    if (source === undefined) {
      context.issues.push(issueAt([...keyPath, 'source'], `source "${trigger.source}" is not defined under sources`));
    } else {
      this.checkTriggerProjects(context, trigger, source, keyPath);
    }

    const kind = triggerKindOf(trigger);
    const steps = this.buildSteps(context, trigger.steps, kind, [...keyPath, 'steps'], environments, false);
    const failureSteps =
      trigger.failureSteps === undefined
        ? [...(kind === 'issue' ? DEFAULT_ISSUE_FAILURE_STEPS : [])]
        : this.buildSteps(context, trigger.failureSteps, kind, [...keyPath, 'failureSteps'], environments, true);

    if (source === undefined || steps === undefined || failureSteps === undefined) {
      return undefined;
    }

    const { concurrency, issue, schedule, mergeRequest } = trigger;
    const written = {
      issue: issue === undefined ? undefined : this.writtenIssue(context, [...keyPath, 'issue'], issue),
      schedule: schedule === undefined ? undefined : this.writtenSchedule(context, [...keyPath, 'schedule'], schedule),
      mergeRequest:
        mergeRequest === undefined
          ? undefined
          : this.writtenMergeRequest(context, [...keyPath, 'mergeRequest'], mergeRequest),
    };
    const fields = { name, source, steps, failureSteps, concurrency, written };

    if (schedule !== undefined) {
      return { ...fields, schedule };
    }

    if (mergeRequest !== undefined) {
      return { ...fields, mergeRequest };
    }

    return issue === undefined ? undefined : { ...fields, issue };
  }

  /** Undefined when any step fails to build. `failure` lets the steps use `{{failure.*}}`. */
  private buildSteps(
    context: ILoadContext,
    definitions: readonly IStepDefinition[],
    triggerKind: TriggerKind,
    keyPath: KeyPath,
    environments: IEnvironments,
    failure: boolean
  ): IStepConfig[] | undefined {
    const steps = definitions.map((step, index) =>
      this.buildStep(context, step, { triggerKind, failure }, [...keyPath, index], environments)
    );

    return steps.every(step => step !== undefined) ? steps : undefined;
  }

  /** The schema holds a step to exactly one action. */
  private buildStep(
    context: ILoadContext,
    step: IStepDefinition,
    templates: ITemplateRules,
    keyPath: KeyPath,
    environments: IEnvironments
  ): IStepConfig | undefined {
    if (step.agent !== undefined) {
      return this.buildAgentStep(context, step.agent, templates, [...keyPath, 'agent'], environments);
    }

    const staticStep = this.staticStepOf(context, step, keyPath);

    if (staticStep === undefined) {
      return undefined;
    }

    if (templates.triggerKind === 'schedule') {
      context.issues.push(
        issueAt([...keyPath, staticStep.kind], 'is a static step, which acts on an issue a scheduled task lacks')
      );

      return undefined;
    }

    if (staticStep.kind === 'comment') {
      this.checkTemplate(context, staticStep.body, templates, [...keyPath, 'comment']);
    }

    return staticStep;
  }

  private staticStepOf(context: ILoadContext, step: IStepDefinition, keyPath: KeyPath): IStaticStepConfig | undefined {
    if (step.relabel !== undefined) {
      const { add, remove } = step.relabel;
      const written = {
        add: this.writtenList(context, [...keyPath, 'relabel', 'add'], add),
        remove: this.writtenList(context, [...keyPath, 'relabel', 'remove'], remove),
      };

      return { kind: 'relabel', add, remove, written };
    }

    if (step.comment !== undefined) {
      const written = { body: this.writtenText(context, [...keyPath, 'comment'], step.comment) };

      return { kind: 'comment', body: step.comment, written };
    }

    if (step.assign === undefined) {
      return undefined;
    }

    const written = { usernames: this.writtenList(context, [...keyPath, 'assign'], step.assign) };

    return { kind: 'assign', usernames: step.assign, written };
  }

  private buildAgentStep(
    context: ILoadContext,
    step: IAgentStepDefinition,
    templates: ITemplateRules,
    keyPath: KeyPath,
    environments: IEnvironments
  ): IAgentStepConfig | undefined {
    const environment = environments.configs.get(step.environment);
    let resolved: { agent: IResolvedAgent; origins: ReadonlyMap<string, KeyPath> } | undefined;

    if (environment === undefined) {
      context.issues.push(
        issueAt([...keyPath, 'environment'], `environment "${step.environment}" is not defined under environments`)
      );
    } else {
      const environmentAgent = environments.agentLayers.get(step.environment);
      const stepAgent = step.agent === undefined ? undefined : { path: [...keyPath, 'agent'], block: step.agent };
      const layers = [stepAgent, environmentAgent].filter(layer => layer !== undefined);

      if (layers.length === 0) {
        context.issues.push(issueAt([...keyPath, 'agent'], 'must name an agent, here or on the environment'));
      } else {
        resolved = this.resolveAgent(context, layers);
      }
    }

    const prompt = this.readPrompt(context, step.prompt, templates, [...keyPath, 'prompt']);
    const systemPrompt =
      step.systemPrompt === undefined
        ? undefined
        : this.readPrompt(context, step.systemPrompt, templates, [...keyPath, 'systemPrompt']);

    if (environment === undefined || resolved === undefined || prompt === undefined) {
      return undefined;
    }

    const { agent, origins } = resolved;
    const written = {
      model: this.writtenText(context, origins.get('model') ?? [], agent.model),
      prompt: this.writtenText(context, [...keyPath, 'prompt'], step.prompt),
      systemPrompt:
        step.systemPrompt === undefined
          ? undefined
          : this.writtenText(context, [...keyPath, 'systemPrompt'], step.systemPrompt),
    };

    return { kind: 'agent', environment, agent, prompt, systemPrompt, timeout: step.timeout, written };
  }

  private checkTriggerProjects(
    context: ILoadContext,
    trigger: ITriggerDefinition,
    source: ISourceConfig,
    keyPath: KeyPath
  ): void {
    if (trigger.schedule !== undefined) {
      this.checkTriggerProject(context, trigger.schedule.project, source, [...keyPath, 'schedule', 'project']);
    }

    for (const [index, project] of (trigger.issue?.projects ?? []).entries()) {
      this.checkTriggerProject(context, project, source, [...keyPath, 'issue', 'projects', index]);
    }

    for (const [index, project] of (trigger.mergeRequest?.projects ?? []).entries()) {
      this.checkTriggerProject(context, project, source, [...keyPath, 'mergeRequest', 'projects', index]);
    }
  }

  private checkTriggerProject(context: ILoadContext, project: string, source: ISourceConfig, path: KeyPath): void {
    if (!source.projects.includes(project)) {
      context.issues.push(issueAt(path, `project "${project}" is not listed under sources.${source.name}.projects`));
    }
  }

  private resolveAgent(
    context: ILoadContext,
    layers: readonly IAgentLayer[]
  ): { agent: IResolvedAgent; origins: ReadonlyMap<string, KeyPath> } | undefined {
    const result = this.agentResolutionService.resolve(context.document.agents, layers);

    if (!result.ok) {
      context.issues.push(...result.issues);

      return undefined;
    }

    const { name, agent, origins } = result.resolution;
    const settings =
      agent.settings === undefined
        ? undefined
        : this.readSettings(context, agent.settings, origins.get('settings') ?? []);
    const instructions =
      agent.instructions === undefined
        ? undefined
        : this.readFile(context, agent.instructions, origins.get('instructions') ?? []);

    return { agent: { ...agent, name, settings, instructions }, origins };
  }

  private writtenIssue(context: ILoadContext, keyPath: KeyPath, issue: IIssueBlock): IIssueBlock {
    const list = (key: string, resolved: readonly string[]) => this.writtenList(context, [...keyPath, key], resolved);

    return {
      labels: list('labels', issue.labels),
      notLabels: list('notLabels', issue.notLabels),
      anyAssignee: list('anyAssignee', issue.anyAssignee),
      projects: list('projects', issue.projects),
      expect: { anyLabel: this.writtenList(context, [...keyPath, 'expect', 'anyLabel'], issue.expect.anyLabel) },
    };
  }

  private writtenSchedule(context: ILoadContext, keyPath: KeyPath, schedule: IScheduleBlock): IScheduleBlock {
    return {
      cron: this.writtenText(context, [...keyPath, 'cron'], schedule.cron),
      project: this.writtenText(context, [...keyPath, 'project'], schedule.project),
    };
  }

  private writtenMergeRequest(
    context: ILoadContext,
    keyPath: KeyPath,
    mergeRequest: IMergeRequestBlock
  ): IMergeRequestBlock {
    const list = (key: string, resolved: readonly string[]) => this.writtenList(context, [...keyPath, key], resolved);
    const { event, targetBranch } = mergeRequest;

    return {
      event,
      targetBranch:
        targetBranch === undefined ? undefined : this.writtenText(context, [...keyPath, 'targetBranch'], targetBranch),
      labels: list('labels', mergeRequest.labels),
      notLabels: list('notLabels', mergeRequest.notLabels),
      projects: list('projects', mergeRequest.projects),
    };
  }

  /**
   * The string at `keyPath` as the file writes it. `resolved` only where the file writes none, as for a default, which
   * no `${VAR}` can reach.
   */
  private writtenText(context: ILoadContext, keyPath: KeyPath, resolved: string): string {
    let node = context.written;

    for (const key of keyPath) {
      node = typeof node === 'object' && node !== null && Object.hasOwn(node, key) ? Reflect.get(node, key) : undefined;
    }

    return typeof node === 'string' ? node : resolved;
  }

  private writtenList(context: ILoadContext, keyPath: KeyPath, resolved: readonly string[]): string[] {
    return resolved.map((item, index) => this.writtenText(context, [...keyPath, index], item));
  }

  private readFile(context: ILoadContext, relativePath: string, keyPath: KeyPath): IConfigFile | undefined {
    const absolutePath = resolve(context.directory, relativePath);

    if (context.root !== undefined && !this.isInside(context.root, absolutePath)) {
      context.issues.push(issueAt(keyPath, `${relativePath} must stay inside the config folder`));

      return undefined;
    }

    try {
      const content = readFileSync(absolutePath, 'utf8');
      context.files.set(absolutePath, content);

      return { path: absolutePath, content };
    } catch (error) {
      context.issues.push(issueAt(keyPath, `cannot read ${absolutePath} (${this.errorCode(error)})`));

      return undefined;
    }
  }

  private readPrompt(
    context: ILoadContext,
    relativePath: string,
    templates: ITemplateRules,
    keyPath: KeyPath
  ): IConfigFile | undefined {
    const prompt = this.readFile(context, relativePath, keyPath);

    this.checkTemplate(context, prompt?.content ?? '', templates, keyPath);

    return prompt;
  }

  private checkTemplate(context: ILoadContext, template: string, rules: ITemplateRules, keyPath: KeyPath): void {
    const { triggerKind, failure } = rules;
    const knownVariables = this.promptTemplateService.variableNames(triggerKind, failure).join(', ');
    const ofKind = KIND_DESCRIPTIONS[triggerKind];

    for (const variable of this.promptTemplateService.findUnknownVariables(template, triggerKind, failure)) {
      const message = this.promptTemplateService.isFailureVariable(variable.name)
        ? `{{${variable.name}}} on line ${variable.line} is a template variable of failureSteps only`
        : `{{${variable.name}}} on line ${variable.line} is not a template variable${ofKind}; use one of ${knownVariables}`;

      context.issues.push(issueAt(keyPath, message));
    }
  }

  private readSettings(context: ILoadContext, relativePath: string, keyPath: KeyPath): IConfigFile | undefined {
    const settings = this.readFile(context, relativePath, keyPath);

    if (settings === undefined) {
      return undefined;
    }

    try {
      const json: unknown = JSON.parse(settings.content);

      if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        context.issues.push(issueAt(keyPath, `${settings.path} must hold a JSON object`));
      }
    } catch {
      context.issues.push(issueAt(keyPath, `${settings.path} is not valid JSON`));
    }

    return settings;
  }

  private isInside(root: string, path: string): boolean {
    const fromRoot = relative(resolve(root), path);

    return !isAbsolute(fromRoot) && fromRoot.split(sep)[0] !== '..';
  }

  private errorCode(error: unknown): string {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown error';
  }
}
