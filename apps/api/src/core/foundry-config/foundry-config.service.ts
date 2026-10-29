import { BeforeApplicationShutdown, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigRepoService } from './config-repo.service';
import { ConfigRevisionService } from './config-revision.service';
import { FoundryConfigLoaderService } from './foundry-config-loader.service';
import { PromptTemplateService } from './prompt-template.service';
import { SecretRedactionService } from './secret-redaction.service';
import { ConfigService } from '@/config/config.service';

import type {
  IAgentStepConfig,
  ICommentStepConfig,
  IConfigRepo,
  IConfigRevision,
  IEnvironmentConfig,
  ILoadedFoundryConfig,
  IPromptContext,
  IRedactionPatterns,
  IRenderedPrompts,
  ISourceConfig,
  ITriggerConfig,
} from './foundry-config.types';

export const DEFAULT_CONFIG_FILE = 'swarmfoundry.yaml';

export type ConfigSwapListener = () => void;

const STEP_LISTS: readonly ('steps' | 'failureSteps')[] = ['steps', 'failureSteps'];

/**
 * Loads the config in `onModuleInit`, so a bad config stops the app before it listens. With a config repo set, it then
 * follows the branch and swaps in each new revision that loads.
 */
@Injectable()
export class FoundryConfigService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(FoundryConfigService.name);

  private loaded: ILoadedFoundryConfig | null = null;
  private loadedRevision: { id: number; sha: string } | null = null;

  /** The running revision and every one a task may still be pinned to, by id. Empty for a local file. */
  private readonly revisions = new Map<number, ILoadedFoundryConfig>();

  /** Every secret of every revision loaded, so text from a run started on an older one stays masked. */
  private readonly secrets = new Set<string>();

  /** One entry per set of extra secrets. They come from the config, so it stays small. */
  private readonly redactionPatterns = new Map<string, IRedactionPatterns>();

  private readonly swapListeners = new Set<ConfigSwapListener>();
  private readonly controller = new AbortController();

  private pollTimer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly foundryConfigLoaderService: FoundryConfigLoaderService,
    private readonly configRepoService: ConfigRepoService,
    private readonly configRevisionService: ConfigRevisionService,
    private readonly promptTemplateService: PromptTemplateService,
    private readonly secretRedactionService: SecretRedactionService
  ) {}

  async onModuleInit(): Promise<void> {
    const repo = this.configRepoService.repo;

    if (repo === null) {
      this.loadLocalFile();

      return;
    }

    await this.install(await this.configRepoService.loadAtStartup(repo, this.controller.signal));
    this.schedulePoll(repo);
  }

  /** Waits for a load in progress, so no git process outlives the app. */
  async beforeApplicationShutdown(): Promise<void> {
    this.controller.abort();

    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    await this.polling;
  }

  /** The sha of the running revision, or null when the config loads from a local file. */
  get revision(): string | null {
    return this.loadedRevision?.sha ?? null;
  }

  /** The running revision's `config_revision` id, or null when the config loads from a local file. */
  get revisionId(): number | null {
    return this.loadedRevision?.id ?? null;
  }

  get sources(): readonly ISourceConfig[] {
    return this.current.config.sources;
  }

  get environments(): readonly IEnvironmentConfig[] {
    return this.current.config.environments;
  }

  get triggers(): readonly ITriggerConfig[] {
    return this.current.config.triggers;
  }

  /**
   * The trigger as revision `configId` defines it, or as the running config does for a null `configId`. Undefined when
   * that revision is not loaded, such as one that no longer loads after a restart.
   */
  triggerAt(configId: number | null, name: string): ITriggerConfig | undefined {
    const loaded = configId === null ? this.current : this.revisions.get(configId);

    return loaded?.config.triggers.find(trigger => trigger.name === name);
  }

  /**
   * Loads a revision a task is pinned to by its `config_revision` id, unless it is loaded already. False when it does
   * not load. Never rejects.
   */
  async loadRevision(configId: number): Promise<boolean> {
    const repo = this.configRepoService.repo;

    if (this.revisions.has(configId)) {
      return true;
    }

    if (repo === null) {
      return false;
    }

    let sha: string | null;

    try {
      sha = await this.configRevisionService.findSha(configId);
    } catch (error) {
      this.logger.error({ configId, error }, `loadRevision(): Failed to read config revision ${configId}`);

      return false;
    }

    const revision = sha === null ? null : await this.configRepoService.loadPinned(repo, sha, this.controller.signal);

    if (revision === null) {
      return false;
    }

    this.addSecrets(revision.loaded);
    this.revisions.set(revision.id, revision.loaded);

    return revision.id === configId;
  }

  /** Unloads every revision but the running one and those in `configIds`. Their secrets stay masked. */
  retainRevisions(configIds: ReadonlySet<number>): void {
    for (const configId of this.revisions.keys()) {
      if (configId !== this.revisionId && !configIds.has(configId)) {
        this.revisions.delete(configId);
      }
    }
  }

  /** Calls `listener` after each swap, once the new revision is in place. Returns the call that removes it. */
  onSwap(listener: ConfigSwapListener): () => void {
    this.swapListeners.add(listener);

    return () => this.swapListeners.delete(listener);
  }

  renderPrompts(step: IAgentStepConfig, context: IPromptContext): IRenderedPrompts {
    return {
      prompt: this.promptTemplateService.render(step.prompt.content, context),
      systemPrompt:
        step.systemPrompt === undefined
          ? undefined
          : this.promptTemplateService.render(step.systemPrompt.content, context),
    };
  }

  /** Unredacted, so mask it before it reaches an issue. */
  renderComment(step: ICommentStepConfig, context: IPromptContext): string {
    return this.promptTemplateService.renderComment(step.body, context);
  }

  /** Masks every secret the config holds, and `extraSecrets`, inside free text such as a transcript line. */
  redactText(text: string, extraSecrets: readonly string[] = []): string {
    return this.secretRedactionService.apply(text, this.patternsWith(extraSecrets));
  }

  /** Masks every `token` field and every secret the config holds, for logging. */
  redact(value: unknown): unknown {
    return this.secretRedactionService.redact(value, this.secrets);
  }

  private get current(): ILoadedFoundryConfig {
    if (this.loaded === null) {
      throw new Error('The Swarmfoundry config was read before it loaded');
    }

    return this.loaded;
  }

  private loadLocalFile(): void {
    const configured = this.configService.swarmfoundryConfig;
    const defaultPath = resolve(DEFAULT_CONFIG_FILE);

    if (configured === '' && !existsSync(defaultPath)) {
      this.loaded = { config: { path: null, sources: [], environments: [], triggers: [] }, secrets: new Set() };

      this.logger.warn(
        { path: defaultPath },
        'loadLocalFile(): No swarmfoundry.yaml found and SWARMFOUNDRY_CONFIG is blank, so no trigger will run'
      );

      return;
    }

    const loaded = this.foundryConfigLoaderService.load(configured === '' ? defaultPath : configured, process.env);
    this.setLoaded(loaded, null);

    this.logger.log(
      { path: loaded.config.path, triggers: loaded.config.triggers.length },
      'loadLocalFile(): Loaded swarmfoundry.yaml'
    );
    this.logTriggers();
  }

  private async install(revision: IConfigRevision): Promise<void> {
    this.setLoaded(revision.loaded, revision);
    this.revisions.set(revision.id, revision.loaded);

    this.logger.log(
      { sha: revision.sha, configId: revision.id, triggers: revision.loaded.config.triggers.length },
      `install(): Loaded config revision ${revision.sha}`
    );
    this.logTriggers();

    try {
      await this.configRevisionService.recordCurrent(revision.id);
    } catch (error) {
      this.logger.warn({ sha: revision.sha, error }, `install(): Failed to record revision ${revision.sha} as current`);
    }
  }

  private setLoaded(loaded: ILoadedFoundryConfig, revision: IConfigRevision | null): void {
    this.addSecrets(loaded);

    this.loaded = loaded;
    this.loadedRevision = revision === null ? null : { id: revision.id, sha: revision.sha };
  }

  private addSecrets(loaded: ILoadedFoundryConfig): void {
    for (const secret of loaded.secrets) {
      this.secrets.add(secret);
    }

    this.redactionPatterns.clear();
  }

  private logTriggers(): void {
    for (const trigger of this.triggers) {
      for (const list of STEP_LISTS) {
        for (const [index, step] of trigger[list].entries()) {
          if (step.kind !== 'agent') {
            continue;
          }

          const { agent } = step;

          this.logger.log(
            {
              trigger: trigger.name,
              list,
              step: index,
              agent: this.redact({
                ...agent,
                settings: agent.settings?.path,
                instructions: agent.instructions?.path,
              }),
            },
            `logTriggers(): ${list}[${index}] of trigger ${trigger.name} resolved its agent`
          );
        }
      }
    }
  }

  /** Polls once the last poll has finished, so two loads never overlap. */
  private schedulePoll(repo: IConfigRepo): void {
    if (this.controller.signal.aborted) {
      return;
    }

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.polling = this.poll(repo).finally(() => {
        this.polling = null;
        this.schedulePoll(repo);
      });
    }, this.configService.configPollIntervalMs);
  }

  private async poll(repo: IConfigRepo): Promise<void> {
    const revision = await this.configRepoService.pollHead(repo, this.controller.signal);

    if (revision === null || this.controller.signal.aborted) {
      return;
    }

    await this.install(revision);

    for (const listener of this.swapListeners) {
      try {
        listener();
      } catch (error) {
        this.logger.error({ error }, 'poll(): A listener failed to follow the config swap');
      }
    }
  }

  private patternsWith(extraSecrets: readonly string[]): IRedactionPatterns {
    const extra = [...new Set(extraSecrets)].filter(secret => !this.secrets.has(secret)).sort();
    const key = extra.join('\u0000');
    let patterns = this.redactionPatterns.get(key);

    if (patterns === undefined) {
      patterns = this.secretRedactionService.compile([...this.secrets, ...extra]);
      this.redactionPatterns.set(key, patterns);
    }

    return patterns;
  }
}
