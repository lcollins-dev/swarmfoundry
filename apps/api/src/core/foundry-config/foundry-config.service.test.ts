import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '@/config/config.service';
import { AgentResolutionService } from '@/core/foundry-config/agent-resolution.service';
import { ConfigRepoService } from '@/core/foundry-config/config-repo.service';
import { ConfigRevisionService } from '@/core/foundry-config/config-revision.service';
import { FoundryConfigLoaderService } from '@/core/foundry-config/foundry-config-loader.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { PromptTemplateService } from '@/core/foundry-config/prompt-template.service';
import { REDACTED, SecretRedactionService } from '@/core/foundry-config/secret-redaction.service';
import { VariableSubstitutionService } from '@/core/foundry-config/variable-substitution.service';

import { FoundryConfigError } from '@/core/foundry-config/foundry-config.error';
import type {
  IConfigRepo,
  IConfigRevision,
  IIssueTriggerConfig,
  ILoadedFoundryConfig,
  IPromptContext,
  ITriggerConfig,
} from '@/core/foundry-config/foundry-config.types';
import type { IAgentStepConfig, IStepConfig } from '@/core/foundry-config/foundry-config.types';

const isAgentStep = (step: IStepConfig): step is IAgentStepConfig => step.kind === 'agent';

const EXAMPLE_CONFIG = join(__dirname, '../../../../../resources/compose/config/swarmfoundry.yaml');

const EXAMPLE_ENV = {
  GITLAB_TOKEN: 'glpat-orchestrator-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-subscription-secret',
  ANTHROPIC_API_KEY: 'sk-ant-api-secret',
  GITLAB_BOT_TOKEN: 'glpat-agent-secret',
  AGENT_IMAGE: 'swarmfoundry-agent:0.1.0',
};

const POLL_INTERVAL_MS = 60_000;

const REPO: IConfigRepo = { url: 'https://gitlab.test/ops/config.git', branch: 'main', token: '', gitDir: '/clone' };

const recordCurrent = vi.fn<ConfigRevisionService['recordCurrent']>();
const findSha = vi.fn<ConfigRevisionService['findSha']>();

const compileService = async (configRepoService: Partial<ConfigRepoService> = { repo: null }) => {
  recordCurrent.mockReset().mockResolvedValue(undefined);
  findSha.mockReset().mockImplementation(id => Promise.resolve(id === 3 ? 'c3' : null));

  const moduleRef = await Test.createTestingModule({
    providers: [
      AgentResolutionService,
      FoundryConfigLoaderService,
      FoundryConfigService,
      PromptTemplateService,
      SecretRedactionService,
      VariableSubstitutionService,
      { provide: ConfigService, useValue: { swarmfoundryConfig, configPollIntervalMs: POLL_INTERVAL_MS } },
      { provide: ConfigRepoService, useValue: configRepoService },
      { provide: ConfigRevisionService, useValue: { recordCurrent, findSha } },
    ],
  }).compile();

  return moduleRef.get(FoundryConfigService);
};

let swarmfoundryConfig = '';

const createService = async (configPath: string): Promise<FoundryConfigService> => {
  swarmfoundryConfig = configPath;
  const service = await compileService();
  await service.onModuleInit();

  return service;
};

const loadedWith = (token: string, triggerName: string): ILoadedFoundryConfig => ({
  config: {
    path: '/clone/checkout/swarmfoundry.yaml',
    sources: [],
    environments: [],
    triggers: [
      {
        name: triggerName,
        steps: [{ kind: 'agent', agent: { name: 'subscription' } }],
        failureSteps: [],
      } as unknown as ITriggerConfig,
    ],
  },
  secrets: new Set([token]),
});

const context: IPromptContext = {
  issue: { iid: 12, title: 'Add the poller', url: 'https://gitlab.example.com/acme/swarmfoundry/-/issues/12' },
  project: { path: 'acme/swarmfoundry', url: 'https://gitlab.example.com/acme/swarmfoundry' },
  trigger: { name: 'implement' },
  task: { id: 2 },
  run: { id: 3 },
};

describe('FoundryConfigService', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(EXAMPLE_ENV)) {
      vi.stubEnv(name, value);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('without a config file', () => {
    let emptyDir: string;

    beforeEach(() => {
      emptyDir = mkdtempSync(join(tmpdir(), 'foundry-config-empty-'));
      vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
    });

    afterEach(() => {
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('runs with no triggers when SWARMFOUNDRY_CONFIG is blank and no default file exists', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const service = await createService('');

      expect(service.triggers).toEqual([]);
      expect(service.sources).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    });

    it('refuses to start when SWARMFOUNDRY_CONFIG names a missing file', async () => {
      await expect(createService(join(emptyDir, 'missing.yaml'))).rejects.toThrow(FoundryConfigError);
    });
  });

  describe('with the example config', () => {
    let service: FoundryConfigService;

    beforeEach(async () => {
      service = await createService(EXAMPLE_CONFIG);
    });

    it('has no revision', () => {
      expect(service.revision).toBeNull();
    });

    it('reads an unpinned trigger from the running config, and loads no pinned revision', async () => {
      expect(service.triggerAt(null, 'review')).toBe(service.triggers[1]);
      expect(service.triggerAt(7, 'review')).toBeUndefined();
      await expect(service.loadRevision(7)).resolves.toBe(false);
    });

    it('exposes the sources, environments and resolved triggers', () => {
      expect(service.sources.map(source => source.name)).toEqual(['gitlab-local']);
      expect(service.environments.map(environment => environment.name)).toEqual(['node-postgres']);
      expect(service.triggers.map(trigger => [trigger.name, trigger.steps.filter(isAgentStep)[0]?.agent.name])).toEqual(
        [
          ['implement', 'claude-subscription'],
          ['review', 'claude-api'],
          ['merged', undefined],
        ]
      );
    });

    it("logs each step's resolved agent with no token or variable value in it", async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      await service.onModuleInit();

      const logged = JSON.stringify(log.mock.calls);

      for (const secret of Object.values(EXAMPLE_ENV)) {
        expect(logged).not.toContain(secret);
      }

      expect(log).toHaveBeenCalledWith(
        {
          trigger: 'review',
          list: 'steps',
          step: 1,
          agent: {
            name: 'claude-api',
            type: 'claude',
            auth: 'apiKey',
            token: REDACTED,
            model: 'claude-opus-5-5',
            settings: join(dirname(EXAMPLE_CONFIG), 'agents/claude/review-settings.json'),
            instructions: join(dirname(EXAMPLE_CONFIG), 'agents/claude/instructions.md'),
          },
        },
        'logTriggers(): steps[1] of trigger review resolved its agent'
      );
    });

    it("renders a step's prompts", () => {
      const rendered = service.renderPrompts(service.triggers[0].steps.filter(isAgentStep)[0], context);

      expect(rendered.prompt).toContain('Implement #12, "Add the poller", in acme/swarmfoundry:');
      expect(rendered.systemPrompt).toContain('task 2 of the `implement` trigger');
    });

    it('masks variable values anywhere in a value', () => {
      expect(service.redact({ line: `cloning with ${EXAMPLE_ENV.GITLAB_BOT_TOKEN}` })).toEqual({
        line: `cloning with ${REDACTED}`,
      });
    });

    it('masks secrets and extra secrets in text', () => {
      expect(service.redactText(`${EXAMPLE_ENV.GITLAB_BOT_TOKEN} and extra-secret`, ['extra-secret'])).toBe(
        `${REDACTED} and ${REDACTED}`
      );
    });
  });

  describe('with a config repo', () => {
    let pollHead: ReturnType<typeof vi.fn<(repo: IConfigRepo, signal: AbortSignal) => Promise<IConfigRevision | null>>>;
    let loadPinned: ReturnType<
      typeof vi.fn<(repo: IConfigRepo, sha: string, signal: AbortSignal) => Promise<IConfigRevision | null>>
    >;
    let service: FoundryConfigService;

    beforeEach(async () => {
      vi.useFakeTimers();
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      pollHead = vi.fn(() => Promise.resolve(null));
      loadPinned = vi.fn(() => Promise.resolve(null));

      service = await compileService({
        repo: REPO,
        loadAtStartup: () =>
          Promise.resolve({ id: 1, sha: 'a1', loaded: loadedWith('glpat-first-secret', 'implement') }),
        pollHead,
        loadPinned,
      });
      await service.onModuleInit();
    });

    afterEach(async () => {
      await service.beforeApplicationShutdown();
      vi.useRealTimers();
    });

    it('starts on the revision the repo loads', () => {
      expect(service.revision).toBe('a1');
      expect(service.triggers.map(trigger => trigger.name)).toEqual(['implement']);
    });

    it('polls the branch every interval, once the last poll has finished', async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);

      expect(pollHead).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(pollHead).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(pollHead).toHaveBeenCalledTimes(2);
    });

    it('swaps in a revision that loads, then tells each listener', async () => {
      const seen: string[] = [];
      service.onSwap(() => seen.push(service.triggers[0].name));
      pollHead.mockResolvedValueOnce({ id: 2, sha: 'b2', loaded: loadedWith('glpat-second-secret', 'review') });

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(service.revision).toBe('b2');
      expect(seen).toEqual(['review']);
    });

    it('keeps the running revision when the poll loads nothing', async () => {
      const listener = vi.fn();
      service.onSwap(listener);

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(service.revision).toBe('a1');
      expect(listener).not.toHaveBeenCalled();
    });

    it("keeps masking an older revision's secrets after a swap", async () => {
      pollHead.mockResolvedValueOnce({ id: 2, sha: 'b2', loaded: loadedWith('glpat-second-secret', 'review') });

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(service.redactText('glpat-first-secret glpat-second-secret')).toBe(`${REDACTED} ${REDACTED}`);
    });

    it('keeps following swaps after a listener throws', async () => {
      const listener = vi.fn();
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      service.onSwap(() => {
        throw new Error('listener failed');
      });
      service.onSwap(listener);
      pollHead.mockResolvedValueOnce({ id: 2, sha: 'b2', loaded: loadedWith('glpat-second-secret', 'review') });

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(listener).toHaveBeenCalledOnce();
    });

    it('records each revision it swaps in as current', async () => {
      pollHead.mockResolvedValueOnce({ id: 2, sha: 'b2', loaded: loadedWith('glpat-second-secret', 'review') });

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(recordCurrent.mock.calls).toEqual([[1], [2]]);
    });

    it('keeps an older revision after a swap until no task is pinned to it', async () => {
      const first = service.triggers[0];
      pollHead.mockResolvedValueOnce({ id: 2, sha: 'b2', loaded: loadedWith('glpat-second-secret', 'implement') });

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(service.triggerAt(1, 'implement')).toBe(first);
      expect(service.triggerAt(null, 'implement')).toBe(service.triggers[0]);
      expect(service.triggerAt(null, 'implement')).not.toBe(first);

      service.retainRevisions(new Set([1]));
      expect(service.triggerAt(1, 'implement')).toBe(first);

      service.retainRevisions(new Set());
      expect(service.triggerAt(1, 'implement')).toBeUndefined();
      expect(service.triggerAt(2, 'implement')).toBe(service.triggers[0]);
    });

    it('loads a pinned revision once, by the sha of its row, and masks its secrets', async () => {
      loadPinned.mockResolvedValueOnce({ id: 3, sha: 'c3', loaded: loadedWith('glpat-pinned-secret', 'review') });

      await expect(service.loadRevision(3)).resolves.toBe(true);
      await expect(service.loadRevision(3)).resolves.toBe(true);

      expect(loadPinned).toHaveBeenCalledExactlyOnceWith(REPO, 'c3', expect.any(AbortSignal));
      expect(service.revision).toBe('a1');
      expect(service.triggerAt(3, 'review')?.name).toBe('review');
      expect(service.redactText('glpat-pinned-secret')).toBe(REDACTED);
    });

    it('reports a pinned revision that does not load, or whose row is gone', async () => {
      await expect(service.loadRevision(3)).resolves.toBe(false);
      expect(service.triggerAt(3, 'review')).toBeUndefined();

      await expect(service.loadRevision(4)).resolves.toBe(false);
      expect(loadPinned).toHaveBeenCalledOnce();
    });

    it('stops polling on shutdown, and calls no listener removed before a swap', async () => {
      const listener = vi.fn();
      service.onSwap(listener)();
      pollHead.mockResolvedValue({ id: 2, sha: 'b2', loaded: loadedWith('glpat-second-secret', 'review') });

      await service.beforeApplicationShutdown();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

      expect(pollHead).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("the example config's label flow", () => {
    let service: FoundryConfigService;
    let implement: IIssueTriggerConfig;
    let review: IIssueTriggerConfig;

    beforeEach(async () => {
      service = await createService(EXAMPLE_CONFIG);

      const triggerNamed = (name: string): IIssueTriggerConfig => {
        const trigger = service.triggers.find(candidate => candidate.name === name);

        if (trigger?.issue === undefined) {
          throw new Error(`No issue trigger named ${name}`);
        }

        return trigger;
      };

      implement = triggerNamed('implement');
      review = triggerNamed('review');
    });

    it('gates both triggers on the same assignee', () => {
      expect(implement.issue.anyAssignee).not.toEqual([]);
      expect(review.issue.anyAssignee).toEqual(implement.issue.anyAssignee);
    });

    it('passes a send-back, even once implement has started, so it adds no failure label', () => {
      expect(review.issue.expect.anyLabel).toEqual(expect.arrayContaining(implement.issue.labels));
      expect(review.issue.expect.anyLabel).toContain('workflow::in-progress');
    });

    it("refuses every review verdict label, implement's labels among them", () => {
      expect(review.issue.notLabels).toEqual(expect.arrayContaining(implement.issue.labels));
      expect(review.issue.notLabels).toContain('workflow::in-progress');
      expect(review.issue.notLabels).toEqual(expect.arrayContaining(review.issue.expect.anyLabel));
    });

    it('refuses every implement outcome label, and an approved ticket', () => {
      expect(implement.issue.notLabels).toEqual(expect.arrayContaining(implement.issue.expect.anyLabel));
      expect(implement.issue.notLabels).toContain('workflow::approved');
    });

    it('keeps the reviewer from pushing', () => {
      const settings: unknown = JSON.parse(review.steps.filter(isAgentStep)[0].agent.settings?.content ?? '{}');

      expect(settings).toHaveProperty(
        'permissions.deny',
        expect.arrayContaining(['Bash(git push)', 'Bash(git push *)'])
      );
    });

    it('renders every prompt in full', () => {
      for (const trigger of [implement, review]) {
        const rendered = service.renderPrompts(trigger.steps.filter(isAgentStep)[0], {
          ...context,
          trigger: { name: trigger.name },
        });

        expect(`${rendered.prompt}${rendered.systemPrompt}`).not.toContain('{{');
        expect(rendered.systemPrompt).toContain(`task 2 of the \`${trigger.name}\` trigger`);
      }
    });
  });
});
