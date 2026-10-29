import { Test } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { AgentResolutionService } from '@/core/foundry-config/agent-resolution.service';
import { FoundryConfigLoaderService, type ILoadRules } from '@/core/foundry-config/foundry-config-loader.service';
import { PromptTemplateService } from '@/core/foundry-config/prompt-template.service';
import { SecretRedactionService } from '@/core/foundry-config/secret-redaction.service';
import { VariableSubstitutionService } from '@/core/foundry-config/variable-substitution.service';

import { FoundryConfigError } from '@/core/foundry-config/foundry-config.error';
import type { IAgentStepConfig, IStepConfig } from '@/core/foundry-config/foundry-config.types';

const isAgentStep = (step: IStepConfig): step is IAgentStepConfig => step.kind === 'agent';

const EXAMPLE_DIR = join(__dirname, '../../../../../resources/compose/config');
const EXAMPLE_CONFIG = join(EXAMPLE_DIR, 'swarmfoundry.yaml');

const EXAMPLE_SECRETS = {
  GITLAB_TOKEN: 'glpat-orchestrator-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-subscription-secret',
  ANTHROPIC_API_KEY: 'sk-ant-api-secret',
  GITLAB_BOT_TOKEN: 'glpat-agent-secret',
};

const EXAMPLE_ENV = { ...EXAMPLE_SECRETS, AGENT_IMAGE: 'swarmfoundry-agent:0.1.0' };

const temporaryDirs: string[] = [];

let foundryConfigLoaderService: FoundryConfigLoaderService;

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const IMPLEMENT_STEP = { environment: 'node', prompt: './prompts/implement.md', timeout: '60m' };

const withStep = (trigger: Record<string, unknown>, fields: Record<string, unknown>) => ({
  ...trigger,
  steps: [{ agent: { ...IMPLEMENT_STEP, ...fields } }],
});

const baseConfig = () => ({
  sources: {
    gitlab: { type: 'gitlab', url: 'https://gitlab.example.com', token: '${GITLAB_TOKEN}', projects: ['acme/app'] },
  },
  agents: {
    subscription: {
      type: 'claude',
      auth: 'oauth',
      token: '${CLAUDE_CODE_OAUTH_TOKEN}',
      model: 'claude-opus-5-5',
      settings: './settings.json',
      instructions: undefined as string | undefined,
    },
  },
  environments: {
    node: { image: 'agent:latest', agent: { name: 'subscription' } },
  },
  triggers: {
    implement: {
      source: 'gitlab',
      steps: [{ agent: IMPLEMENT_STEP }],
      issue: { labels: ['workflow::in-progress'] },
    } as Record<string, unknown>,
  },
});

function writeConfig(config: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-config-'));
  temporaryDirs.push(dir);

  const allFiles: Record<string, string> = {
    'settings.json': '{}',
    'prompts/implement.md': 'Implement #{{issue.iid}}',
    ...files,
    'swarmfoundry.yaml': typeof config === 'string' ? config : stringify(config),
  };

  for (const [path, content] of Object.entries(allFiles)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }

  return join(dir, 'swarmfoundry.yaml');
}

function loadError(
  configPath: string,
  environment: Record<string, string> = EXAMPLE_ENV,
  rules?: ILoadRules
): FoundryConfigError {
  try {
    foundryConfigLoaderService.load(configPath, environment, rules);
  } catch (error) {
    if (error instanceof FoundryConfigError) {
      return error;
    }

    throw error;
  }

  throw new Error('expected the config to be refused');
}

const linesOf = (error: FoundryConfigError) => error.issues.map(issue => `${issue.path}: ${issue.message}`);

describe('FoundryConfigLoaderService', () => {
  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentResolutionService,
        FoundryConfigLoaderService,
        PromptTemplateService,
        SecretRedactionService,
        VariableSubstitutionService,
      ],
    }).compile();

    foundryConfigLoaderService = moduleRef.get(FoundryConfigLoaderService);
  });

  describe('the example config', () => {
    it('loads with every variable set', () => {
      const { config } = foundryConfigLoaderService.load(EXAMPLE_CONFIG, EXAMPLE_ENV);

      expect(config.sources.map(source => source.name)).toEqual(['gitlab-local']);
      expect(config.environments.map(environment => environment.name)).toEqual(['node-postgres']);
      expect(config.triggers.map(trigger => trigger.name)).toEqual(['implement', 'review', 'merged']);
    });

    it('holds failureSteps on the issue triggers and static steps on the merge request trigger', () => {
      const { config } = foundryConfigLoaderService.load(EXAMPLE_CONFIG, EXAMPLE_ENV);
      const [implement, review, merged] = config.triggers;

      expect(implement.failureSteps).toEqual([
        { kind: 'comment', body: '{{failure.report}}' },
        { kind: 'relabel', add: ['foundry::failed'], remove: ['foundry::running'] },
      ]);
      expect(review.failureSteps).toEqual(implement.failureSteps);
      expect(merged.steps).toEqual([
        {
          kind: 'relabel',
          add: ['workflow::merged'],
          remove: ['workflow::approved', 'workflow::review', 'foundry::needs-human'],
        },
        { kind: 'comment', body: 'Merged in !{{mergeRequest.iid}}.' },
      ]);
    });

    it('wraps each agent step in relabels that add and remove foundry::running', () => {
      const [implement, review] = foundryConfigLoaderService.load(EXAMPLE_CONFIG, EXAMPLE_ENV).config.triggers;

      expect(implement.steps).toMatchObject([
        { kind: 'relabel', add: ['workflow::in-progress', 'foundry::running'], remove: ['workflow::ready'] },
        { kind: 'agent' },
        { kind: 'relabel', add: [], remove: ['foundry::running'] },
      ]);
      expect(review.steps).toMatchObject([
        { kind: 'relabel', add: ['foundry::running'], remove: [] },
        { kind: 'agent' },
        { kind: 'relabel', add: [], remove: ['foundry::running'] },
      ]);
    });

    it("gives implement the environment's agent", () => {
      const implement = foundryConfigLoaderService.load(EXAMPLE_CONFIG, EXAMPLE_ENV).config.triggers[0];

      expect(implement.steps.filter(isAgentStep)[0].agent).toEqual({
        name: 'claude-subscription',
        type: 'claude',
        auth: 'oauth',
        token: EXAMPLE_ENV.CLAUDE_CODE_OAUTH_TOKEN,
        model: 'claude-opus-5-5',
        settings: {
          path: join(EXAMPLE_DIR, 'agents/claude/settings.json'),
          content: readFileSync(join(EXAMPLE_DIR, 'agents/claude/settings.json'), 'utf8'),
        },
        instructions: {
          path: join(EXAMPLE_DIR, 'agents/claude/instructions.md'),
          content: readFileSync(join(EXAMPLE_DIR, 'agents/claude/instructions.md'), 'utf8'),
        },
      });
    });

    it("merges review's agent block over the environment's", () => {
      const review = foundryConfigLoaderService.load(EXAMPLE_CONFIG, EXAMPLE_ENV).config.triggers[1];

      expect(review.steps.filter(isAgentStep)[0].agent).toMatchObject({
        name: 'claude-api',
        auth: 'apiKey',
        token: EXAMPLE_ENV.ANTHROPIC_API_KEY,
        model: 'claude-opus-5-5',
      });
    });

    it('resolves prompt paths relative to the config file and reads them', () => {
      const [step] = foundryConfigLoaderService
        .load(EXAMPLE_CONFIG, EXAMPLE_ENV)
        .config.triggers[0].steps.filter(isAgentStep);

      expect(step.prompt.path).toBe(join(EXAMPLE_DIR, 'prompts/implement.md'));
      expect(step.prompt.content).toContain('{{issue.iid}}');
      expect(step.systemPrompt?.path).toBe(join(EXAMPLE_DIR, 'prompts/implement.system.md'));
    });

    it('substitutes the variables and collects their values as secrets', () => {
      const { config, secrets } = foundryConfigLoaderService.load(EXAMPLE_CONFIG, EXAMPLE_ENV);

      expect(config.sources[0].token).toBe(EXAMPLE_ENV.GITLAB_TOKEN);
      expect(config.environments[0].env.GITLAB_TOKEN).toBe(EXAMPLE_ENV.GITLAB_BOT_TOKEN);
      expect(config.environments[0].image).toBe(EXAMPLE_ENV.AGENT_IMAGE);
      expect([...secrets].sort()).toEqual(Object.values(EXAMPLE_SECRETS).sort());
    });

    it('keeps a substituted value outside a secret position readable in errors', () => {
      const config = baseConfig();
      config.triggers.implement = withStep(config.triggers.implement, { prompt: './prompts/${DEBUG_LEVEL}.md' });

      const error = loadError(writeConfig(config), { ...EXAMPLE_ENV, DEBUG_LEVEL: 'missing' });

      expect(linesOf(error)[0]).toContain('/prompts/missing.md');
    });

    it('masks a literal token in the error output', () => {
      const config = baseConfig();
      config.sources.gitlab = { ...config.sources.gitlab, token: 'glpat-literal-in-file' };
      config.triggers.implement = withStep(config.triggers.implement, { prompt: './glpat-literal-in-file.md' });

      const error = loadError(writeConfig(config));

      expect(error.message).not.toContain('glpat-literal-in-file');
    });

    it('converts durations and sizes', () => {
      const { config } = foundryConfigLoaderService.load(EXAMPLE_CONFIG, EXAMPLE_ENV);

      expect(config.sources[0].pollInterval).toBe(60_000);
      expect(config.triggers[0].steps.filter(isAgentStep)[0].timeout).toBe(3_600_000);
      expect(config.environments[0].resources).toEqual({ cpus: 4, memory: 8 * 1024 ** 3 });
    });

    it('exits naming an unset variable and its key path', () => {
      const environment = Object.fromEntries(Object.entries(EXAMPLE_ENV).filter(([name]) => name !== 'GITLAB_TOKEN'));

      expect(linesOf(loadError(EXAMPLE_CONFIG, environment))).toEqual([
        'sources.gitlab-local.token: ${GITLAB_TOKEN} is not set',
      ]);
    });
  });

  describe('variables', () => {
    it('reads a .env beside the config file', () => {
      const configPath = writeConfig(baseConfig(), {
        '.env': 'GITLAB_TOKEN=from-dotenv\nCLAUDE_CODE_OAUTH_TOKEN=oauth-from-dotenv\n',
      });

      const { config } = foundryConfigLoaderService.load(configPath, {});

      expect(config.sources[0].token).toBe('from-dotenv');
    });

    it('prefers the process environment over .env', () => {
      const configPath = writeConfig(baseConfig(), { '.env': 'GITLAB_TOKEN=from-dotenv\n' });

      const { config } = foundryConfigLoaderService.load(configPath, EXAMPLE_ENV);

      expect(config.sources[0].token).toBe(EXAMPLE_ENV.GITLAB_TOKEN);
    });

    it('reads no .env when the rules say not to', () => {
      const configPath = writeConfig(baseConfig(), {
        '.env': 'GITLAB_TOKEN=from-dotenv\nCLAUDE_CODE_OAUTH_TOKEN=oauth-from-dotenv\n',
      });

      expect(() => foundryConfigLoaderService.load(configPath, {}, { readDotEnv: false })).toThrow(/GITLAB_TOKEN/);
    });
  });

  describe('a root folder', () => {
    it('refuses a prompt, settings or instructions file outside it', () => {
      const config = baseConfig();
      config.triggers.implement = withStep(config.triggers.implement, { prompt: '../implement.md' });
      config.agents.subscription.settings = '/etc/swarmfoundry/settings.json';
      config.agents.subscription.instructions = '../CLAUDE.md';
      const configPath = writeConfig(config);

      const error = loadError(configPath, EXAMPLE_ENV, { readDotEnv: true, root: dirname(configPath) });

      expect(linesOf(error)).toEqual(
        expect.arrayContaining([
          'triggers.implement.steps[0].agent.prompt: ../implement.md must stay inside the config folder',
          'agents.subscription.settings: /etc/swarmfoundry/settings.json must stay inside the config folder',
          'agents.subscription.instructions: ../CLAUDE.md must stay inside the config folder',
        ])
      );
    });

    it('accepts files anywhere inside it', () => {
      const config = baseConfig();
      config.triggers.implement = withStep(config.triggers.implement, { prompt: './prompts/../prompts/implement.md' });
      const configPath = writeConfig(config);

      const { config: loaded } = foundryConfigLoaderService.load(configPath, EXAMPLE_ENV, {
        readDotEnv: true,
        root: dirname(configPath),
      });

      expect(loaded.triggers[0].steps.filter(isAgentStep)[0].prompt.content).toBe('Implement #{{issue.iid}}');
    });
  });

  describe('references', () => {
    it('refuses an undefined source and environment, naming the keys', () => {
      const config = baseConfig();
      config.triggers.implement = {
        ...withStep(config.triggers.implement, { environment: 'python' }),
        source: 'github',
      };

      expect(linesOf(loadError(writeConfig(config)))).toEqual([
        'triggers.implement.source: source "github" is not defined under sources',
        'triggers.implement.steps[0].agent.environment: environment "python" is not defined under environments',
      ]);
    });

    it('refuses an undefined agent on an environment or a trigger', () => {
      const config = baseConfig();
      config.environments.node.agent.name = 'missing';
      config.triggers.implement = withStep(config.triggers.implement, { agent: { name: 'gone' } });

      expect(linesOf(loadError(writeConfig(config)))).toEqual([
        'environments.node.agent.name: agent "missing" is not defined under agents',
        'triggers.implement.steps[0].agent.agent.name: agent "gone" is not defined under agents',
      ]);
    });

    it("refuses an issue.projects path missing from the source's projects, naming the key path", () => {
      const config = baseConfig();
      config.triggers.implement = {
        ...config.triggers.implement,
        issue: { labels: ['workflow::in-progress'], projects: ['acme/app', 'acme/ap'] },
      };

      expect(linesOf(loadError(writeConfig(config)))).toEqual([
        'triggers.implement.issue.projects[1]: project "acme/ap" is not listed under sources.gitlab.projects',
      ]);
    });

    it("keeps a trigger's issue.projects paths listed on its source", () => {
      const config = baseConfig();
      config.triggers.implement = {
        ...config.triggers.implement,
        issue: { labels: ['workflow::in-progress'], projects: ['acme/app'] },
      };

      const { config: loaded } = foundryConfigLoaderService.load(writeConfig(config), EXAMPLE_ENV);

      expect(loaded.triggers[0].issue?.projects).toEqual(['acme/app']);
    });

    it("refuses a schedule.project missing from the source's projects, naming the key path", () => {
      const fields = { ...baseConfig().triggers.implement, issue: undefined };
      const config = {
        ...baseConfig(),
        triggers: { friction: { ...fields, schedule: { cron: '0 9 * * 1', project: 'acme/ap' } } },
      };

      expect(linesOf(loadError(writeConfig(config, { 'prompts/implement.md': 'Review' })))).toEqual([
        'triggers.friction.schedule.project: project "acme/ap" is not listed under sources.gitlab.projects',
      ]);
    });

    it("refuses a mergeRequest.projects path missing from the source's projects, naming the key path", () => {
      const fields = { ...baseConfig().triggers.implement, issue: undefined };
      const config = {
        ...baseConfig(),
        triggers: { merged: { ...fields, mergeRequest: { event: 'merged', projects: ['acme/app', 'acme/ap'] } } },
      };

      expect(linesOf(loadError(writeConfig(config, { 'prompts/implement.md': 'Move it on' })))).toEqual([
        'triggers.merged.mergeRequest.projects[1]: project "acme/ap" is not listed under sources.gitlab.projects',
      ]);
    });

    it('refuses a trigger with no agent to resolve', () => {
      const config = { ...baseConfig(), environments: { node: { image: 'agent:latest' } } };

      expect(linesOf(loadError(writeConfig(config)))).toEqual([
        'triggers.implement.steps[0].agent.agent: must name an agent, here or on the environment',
      ]);
    });
  });

  describe('agents', () => {
    it("keeps the environment's credentials when a trigger overrides only agent.model", () => {
      const config = baseConfig();
      config.triggers.implement = withStep(config.triggers.implement, { agent: { model: 'claude-haiku-5-5' } });

      const { config: loaded } = foundryConfigLoaderService.load(writeConfig(config), EXAMPLE_ENV);

      expect(loaded.triggers[0].steps.filter(isAgentStep)[0].agent).toMatchObject({
        name: 'subscription',
        auth: 'oauth',
        token: EXAMPLE_ENV.CLAUDE_CODE_OAUTH_TOKEN,
        model: 'claude-haiku-5-5',
      });
    });

    it("runs a trigger that names another agent without the environment's credentials", () => {
      const config = {
        ...baseConfig(),
        agents: {
          ...baseConfig().agents,
          api: { type: 'claude', auth: 'apiKey', token: '${ANTHROPIC_API_KEY}', model: 'claude-sonnet-5-5' },
        },
        environments: {
          node: { image: 'agent:latest', agent: { name: 'subscription', token: '${CLAUDE_CODE_OAUTH_TOKEN}' } },
        },
      };
      config.triggers.implement = withStep(config.triggers.implement, { agent: { name: 'api' } });

      const { config: loaded } = foundryConfigLoaderService.load(writeConfig(config), EXAMPLE_ENV);

      expect(loaded.triggers[0].steps.filter(isAgentStep)[0].agent).toMatchObject({
        name: 'api',
        auth: 'apiKey',
        token: EXAMPLE_ENV.ANTHROPIC_API_KEY,
      });
    });

    it("gives every trigger the agent definition's concurrency", () => {
      const config = baseConfig();
      Object.assign(config.agents.subscription, { concurrency: 2 });
      Object.assign(config.triggers, {
        review: withStep(config.triggers.implement, { agent: { model: 'claude-haiku-5-5' } }),
      });

      const { config: loaded } = foundryConfigLoaderService.load(writeConfig(config), EXAMPLE_ENV);

      expect(loaded.triggers.map(trigger => trigger.steps.filter(isAgentStep)[0].agent.concurrency)).toEqual([2, 2]);
    });

    it('refuses plugins on a claude agent, naming the key', () => {
      const config = baseConfig();
      Object.assign(config.agents.subscription, { plugins: ['./plugin'] });

      expect(linesOf(loadError(writeConfig(config)))).toEqual(['agents.subscription.plugins: is not a known key']);
    });

    it('refuses plugins in a trigger agent block, naming the key', () => {
      const config = baseConfig();
      config.triggers.implement = withStep(config.triggers.implement, { agent: { plugins: ['./plugin'] } });

      expect(linesOf(loadError(writeConfig(config)))).toEqual([
        'triggers.implement.steps[0].agent.agent.plugins: is not an option of agent type "claude"',
      ]);
    });

    it('refuses a settings file that is missing or not a JSON object', () => {
      const missing = baseConfig();
      missing.agents.subscription.settings = './nowhere.json';

      expect(linesOf(loadError(writeConfig(missing)))[0]).toMatch(
        /^agents\.subscription\.settings: cannot read .*nowhere\.json \(ENOENT\)$/
      );

      expect(linesOf(loadError(writeConfig(baseConfig(), { 'settings.json': '[1, 2]' })))[0]).toMatch(
        /^agents\.subscription\.settings: .*settings\.json must hold a JSON object$/
      );
    });

    it('resolves an overriding settings path relative to the config file', () => {
      const config = baseConfig();
      config.triggers.implement = withStep(config.triggers.implement, { agent: { settings: './other/settings.json' } });

      const configPath = writeConfig(config, { 'other/settings.json': '{"enabledPlugins": {}}' });

      expect(
        foundryConfigLoaderService.load(configPath, EXAMPLE_ENV).config.triggers[0].steps.filter(isAgentStep)[0].agent
          .settings
      ).toEqual({
        path: join(dirname(configPath), 'other/settings.json'),
        content: '{"enabledPlugins": {}}',
      });
    });

    it('reads instructions relative to the config file, as written', () => {
      const config = baseConfig();
      config.agents.subscription.instructions = './agents/CLAUDE.md';

      const configPath = writeConfig(config, { 'agents/CLAUDE.md': '# Standing guidance\n\n{{not.a.variable}}' });

      expect(
        foundryConfigLoaderService.load(configPath, EXAMPLE_ENV).config.triggers[0].steps.filter(isAgentStep)[0].agent
          .instructions
      ).toEqual({
        path: join(dirname(configPath), 'agents/CLAUDE.md'),
        content: '# Standing guidance\n\n{{not.a.variable}}',
      });
    });

    it('resolves an overriding instructions path relative to the config file', () => {
      const config = baseConfig();
      config.agents.subscription.instructions = './CLAUDE.md';
      config.triggers.implement = withStep(config.triggers.implement, {
        agent: { instructions: './review/CLAUDE.md' },
      });

      const configPath = writeConfig(config, { 'CLAUDE.md': 'Base', 'review/CLAUDE.md': 'Review' });

      expect(
        foundryConfigLoaderService.load(configPath, EXAMPLE_ENV).config.triggers[0].steps.filter(isAgentStep)[0].agent
          .instructions
      ).toEqual({
        path: join(dirname(configPath), 'review/CLAUDE.md'),
        content: 'Review',
      });
    });

    it('refuses an instructions file that is missing, even on an agent no trigger uses', () => {
      const config = baseConfig();
      const agents = { ...config.agents, unused: { ...config.agents.subscription, instructions: './nowhere.md' } };

      expect(linesOf(loadError(writeConfig({ ...config, agents })))).toEqual([
        expect.stringMatching(/^agents\.unused\.instructions: cannot read .*nowhere\.md \(ENOENT\)$/),
      ]);
    });

    it('leaves the instructions out when the agent names none', () => {
      const [{ agent }] = foundryConfigLoaderService
        .load(writeConfig(baseConfig()), EXAMPLE_ENV)
        .config.triggers[0].steps.filter(isAgentStep);

      expect(agent.instructions).toBeUndefined();
    });
  });

  describe('steps', () => {
    it('loads several agent steps in order, each resolving its own agent and reading its own prompt', () => {
      const config = {
        ...baseConfig(),
        agents: {
          ...baseConfig().agents,
          api: { type: 'claude', auth: 'apiKey', token: '${ANTHROPIC_API_KEY}', model: 'claude-sonnet-5-5' },
        },
      };
      config.triggers.implement = {
        ...config.triggers.implement,
        steps: [
          { agent: IMPLEMENT_STEP },
          { agent: { ...IMPLEMENT_STEP, agent: { name: 'api' }, prompt: './prompts/review.md' } },
        ],
        concurrency: 2,
      };

      const configPath = writeConfig(config, { 'prompts/review.md': 'Review #{{issue.iid}}' });
      const [trigger] = foundryConfigLoaderService.load(configPath, EXAMPLE_ENV).config.triggers;

      expect(trigger.concurrency).toBe(2);
      expect(trigger.steps).toMatchObject([
        { kind: 'agent', agent: { name: 'subscription' }, prompt: { content: 'Implement #{{issue.iid}}' } },
        { kind: 'agent', agent: { name: 'api' }, prompt: { content: 'Review #{{issue.iid}}' } },
      ]);
    });

    it('names the step of each reference it cannot resolve', () => {
      const config = baseConfig();
      config.triggers.implement = {
        ...config.triggers.implement,
        steps: [
          { agent: IMPLEMENT_STEP },
          { agent: { ...IMPLEMENT_STEP, environment: 'python', prompt: './nowhere.md' } },
        ],
      };

      expect(linesOf(loadError(writeConfig(config)))).toEqual([
        'triggers.implement.steps[1].agent.environment: environment "python" is not defined under environments',
        expect.stringMatching(/^triggers\.implement\.steps\[1\]\.agent\.prompt: cannot read .*nowhere\.md \(ENOENT\)$/),
      ]);
    });
  });

  describe('static steps and failureSteps', () => {
    const mergeRequestTrigger = (fields: Record<string, unknown>) => ({
      source: 'gitlab',
      mergeRequest: { event: 'merged' },
      ...fields,
    });

    const frictionStep = { agent: { ...IMPLEMENT_STEP, prompt: './prompts/friction.md' } };
    const frictionFiles = { 'prompts/friction.md': 'Review the week' };

    const scheduledTrigger = (fields: Record<string, unknown>) => ({
      source: 'gitlab',
      schedule: { cron: '0 9 * * 1', project: 'acme/app' },
      steps: [frictionStep],
      ...fields,
    });

    it('builds each static step of a merge request trigger', () => {
      const steps = [
        { relabel: { add: ['workflow::test'], remove: ['workflow::review'] } },
        { comment: 'Merged in !{{mergeRequest.iid}} for #{{issue.iid}}.' },
        { assign: ['ada'] },
      ];
      const config = { ...baseConfig(), triggers: { merged: mergeRequestTrigger({ steps }) } };

      const [trigger] = foundryConfigLoaderService.load(writeConfig(config), EXAMPLE_ENV).config.triggers;

      expect(trigger.steps).toEqual([
        { kind: 'relabel', add: ['workflow::test'], remove: ['workflow::review'] },
        { kind: 'comment', body: 'Merged in !{{mergeRequest.iid}} for #{{issue.iid}}.' },
        { kind: 'assign', usernames: ['ada'] },
      ]);
    });

    it('gives an issue trigger without failureSteps one comment of the failure report, and other kinds none', () => {
      const config = baseConfig();
      const triggers = {
        implement: config.triggers.implement,
        quiet: { ...config.triggers.implement, failureSteps: [] },
        merged: mergeRequestTrigger({ steps: [{ comment: 'Merged' }] }),
        friction: scheduledTrigger({}),
      };

      const loaded = foundryConfigLoaderService.load(
        writeConfig({ ...config, triggers }, frictionFiles),
        EXAMPLE_ENV
      ).config;

      expect(loaded.triggers.map(trigger => [trigger.name, trigger.failureSteps])).toEqual([
        ['implement', [{ kind: 'comment', body: '{{failure.report}}' }]],
        ['quiet', []],
        ['merged', []],
        ['friction', []],
      ]);
    });

    it('builds failureSteps of any kind, resolving an agent step as in steps', () => {
      const config = baseConfig();
      config.triggers.implement = {
        ...config.triggers.implement,
        failureSteps: [{ relabel: { add: ['foundry::failed'] } }, { agent: IMPLEMENT_STEP }],
      };

      const [trigger] = foundryConfigLoaderService.load(writeConfig(config), EXAMPLE_ENV).config.triggers;

      expect(trigger.failureSteps).toMatchObject([
        { kind: 'relabel', add: ['foundry::failed'], remove: [] },
        { kind: 'agent', agent: { name: 'subscription' }, prompt: { content: 'Implement #{{issue.iid}}' } },
      ]);
    });

    it('refuses a static step in the steps or failureSteps of a scheduled trigger, naming each key path', () => {
      const friction = scheduledTrigger({
        steps: [frictionStep, { relabel: { add: ['x'] } }],
        failureSteps: [{ comment: 'Failed' }, { assign: ['ada'] }, frictionStep],
      });

      expect(linesOf(loadError(writeConfig({ ...baseConfig(), triggers: { friction } }, frictionFiles)))).toEqual([
        'triggers.friction.steps[1].relabel: is a static step, which acts on an issue a scheduled task lacks',
        'triggers.friction.failureSteps[0].comment: is a static step, which acts on an issue a scheduled task lacks',
        'triggers.friction.failureSteps[1].assign: is a static step, which acts on an issue a scheduled task lacks',
      ]);
    });

    it('allows the failure variables in failureSteps alone, in a comment and in an agent prompt', () => {
      const config = baseConfig();
      config.triggers.implement = {
        ...config.triggers.implement,
        steps: [{ agent: IMPLEMENT_STEP }, { comment: 'Done: {{failure.reason}}' }],
        failureSteps: [
          { comment: '{{failure.report}}\n\n{{failure.reason}} on #{{issue.iid}}' },
          { agent: { ...IMPLEMENT_STEP, prompt: './prompts/triage.md' } },
        ],
      };

      const configPath = writeConfig(config, { 'prompts/triage.md': 'Triage {{failure.report}}' });

      expect(linesOf(loadError(configPath))).toEqual([
        'triggers.implement.steps[1].comment: {{failure.reason}} on line 1 is a template variable of failureSteps only',
      ]);
    });

    it('refuses a comment with an unknown variable, naming the key path and line', () => {
      const config = baseConfig();
      config.triggers.implement = {
        ...config.triggers.implement,
        failureSteps: [{ comment: 'Failed\n{{issue.description}}' }],
      };

      expect(linesOf(loadError(writeConfig(config)))).toEqual([
        'triggers.implement.failureSteps[0].comment: {{issue.description}} on line 2 is not a template variable; use ' +
          'one of issue.iid, issue.title, issue.url, project.path, project.url, trigger.name, task.id, run.id, ' +
          'failure.report, failure.reason',
      ]);
    });
  });

  describe('prompts', () => {
    it('refuses a template with an unknown variable, naming the key path', () => {
      const configPath = writeConfig(baseConfig(), { 'prompts/implement.md': 'Fix\n{{issue.description}}' });

      expect(linesOf(loadError(configPath))).toEqual([
        'triggers.implement.steps[0].agent.prompt: {{issue.description}} on line 2 is not a template variable; use one of ' +
          'issue.iid, issue.title, issue.url, project.path, project.url, trigger.name, task.id, run.id',
      ]);
    });

    it('refuses an issue variable in a scheduled trigger, and a schedule variable in a label trigger', () => {
      const config = baseConfig();
      const fields = { ...config.triggers.implement, issue: undefined };
      const friction = {
        ...withStep(fields, { prompt: './prompts/friction.md', systemPrompt: './prompts/friction.system.md' }),
        schedule: { cron: '0 9 * * 1', project: 'acme/app' },
      };

      const configPath = writeConfig(
        { ...config, triggers: { ...config.triggers, friction } },
        {
          'prompts/implement.md': 'Since {{schedule.lastSuccessEnd}}',
          'prompts/friction.md': 'Review since {{schedule.lastSuccessEnd}} for {{issue.title}}',
          'prompts/friction.system.md': 'Work on {{issue.url}}',
        }
      );

      expect(linesOf(loadError(configPath))).toEqual([
        'triggers.implement.steps[0].agent.prompt: {{schedule.lastSuccessEnd}} on line 1 is not a template variable; use one of ' +
          'issue.iid, issue.title, issue.url, project.path, project.url, trigger.name, task.id, run.id',
        'triggers.friction.steps[0].agent.prompt: {{issue.title}} on line 1 is not a template variable of a scheduled trigger; ' +
          'use one of schedule.fireTime, schedule.previousFireTime, schedule.nextFireTime, schedule.lastRunStart, ' +
          'schedule.lastSuccessEnd, schedule.lastFailureEnd, project.path, project.url, trigger.name, task.id, run.id',
        'triggers.friction.steps[0].agent.systemPrompt: {{issue.url}} on line 1 is not a template variable of a scheduled trigger; ' +
          'use one of schedule.fireTime, schedule.previousFireTime, schedule.nextFireTime, schedule.lastRunStart, ' +
          'schedule.lastSuccessEnd, schedule.lastFailureEnd, project.path, project.url, trigger.name, task.id, run.id',
      ]);
    });

    it('loads a scheduled trigger using every schedule variable', () => {
      const config = baseConfig();
      const fields = { ...config.triggers.implement, issue: undefined };
      const friction = {
        ...withStep(fields, { prompt: './prompts/friction.md' }),
        schedule: { cron: '0 9 * * 1', project: 'acme/app' },
      };

      const configPath = writeConfig(
        { ...config, triggers: { friction } },
        {
          'prompts/friction.md':
            '{{schedule.fireTime}} {{schedule.previousFireTime}} {{schedule.nextFireTime}} ' +
            '{{schedule.lastRunStart}} {{schedule.lastSuccessEnd}} {{schedule.lastFailureEnd}} {{project.path}}',
        }
      );

      const [trigger] = foundryConfigLoaderService.load(configPath, EXAMPLE_ENV).config.triggers;

      expect(trigger.schedule).toEqual({ cron: '0 9 * * 1', project: 'acme/app' });
      expect(trigger.issue).toBeUndefined();
    });

    it('loads a merge request trigger using every merge request and issue variable', () => {
      const config = baseConfig();
      const fields = { ...config.triggers.implement, issue: undefined };
      const merged = {
        ...withStep(fields, { prompt: './prompts/merged.md' }),
        mergeRequest: { event: 'merged', targetBranch: 'master', projects: ['acme/app'] },
      };

      const configPath = writeConfig(
        { ...config, triggers: { merged } },
        {
          'prompts/merged.md':
            '{{mergeRequest.iid}} {{mergeRequest.url}} {{mergeRequest.title}} {{mergeRequest.sourceBranch}} ' +
            '{{mergeRequest.targetBranch}} {{issue.iid}} {{issue.title}} {{issue.url}} {{project.path}}',
        }
      );

      const [trigger] = foundryConfigLoaderService.load(configPath, EXAMPLE_ENV).config.triggers;

      expect(trigger.mergeRequest).toEqual({
        event: 'merged',
        targetBranch: 'master',
        labels: [],
        notLabels: [],
        projects: ['acme/app'],
      });
      expect(trigger.issue).toBeUndefined();
      expect(trigger.schedule).toBeUndefined();
    });

    it('refuses a schedule variable in a merge request trigger, naming its kind', () => {
      const config = baseConfig();
      const fields = { ...config.triggers.implement, issue: undefined };
      const merged = { ...withStep(fields, { prompt: './prompts/merged.md' }), mergeRequest: { event: 'merged' } };

      const configPath = writeConfig(
        { ...config, triggers: { merged } },
        { 'prompts/merged.md': 'Since {{schedule.lastSuccessEnd}}' }
      );

      expect(linesOf(loadError(configPath))).toEqual([
        'triggers.merged.steps[0].agent.prompt: {{schedule.lastSuccessEnd}} on line 1 is not a template variable of a merge ' +
          'request trigger; use one of mergeRequest.iid, mergeRequest.url, mergeRequest.title, ' +
          'mergeRequest.sourceBranch, mergeRequest.targetBranch, issue.iid, issue.title, issue.url, project.path, ' +
          'project.url, trigger.name, task.id, run.id',
      ]);
    });

    it('refuses a missing prompt file', () => {
      const config = baseConfig();
      config.triggers.implement = withStep(config.triggers.implement, { systemPrompt: './prompts/missing.md' });

      expect(linesOf(loadError(writeConfig(config)))[0]).toMatch(
        /^triggers\.implement\.steps\[0\]\.agent\.systemPrompt: cannot read .*missing\.md \(ENOENT\)$/
      );
    });
  });

  describe('the file', () => {
    it('refuses a file it cannot read', () => {
      expect(linesOf(loadError('/nonexistent/swarmfoundry.yaml'))).toEqual(['(root): cannot be read (ENOENT)']);
    });

    it('names the line of a YAML syntax error without quoting it', () => {
      const error = loadError(writeConfig('sources:\n  gitlab: [glpat-literal-secret\n'));

      expect(error.issues).toHaveLength(1);
      expect(error.issues[0].path).toMatch(/^line \d+, column \d+$/);
      expect(error.message).not.toContain('glpat-literal-secret');
    });

    it('reports only the first syntax error, by code, when a stray brace comes before a literal token', () => {
      const error = loadError(writeConfig('sources:\n  g: { url: x }}\n  token: glpat-literal\n'));

      expect(linesOf(error)).toEqual(['line 2, column 16: YAML syntax error (UNEXPECTED_TOKEN)']);
      expect(error.message).not.toContain('glpat-literal');
    });

    it('merges shared defaults from an anchor under a top-level x- key', () => {
      const yaml = [
        'x-trigger-defaults: &trigger-defaults',
        '  source: gitlab',
        'x-step-defaults: &step-defaults',
        '  environment: node',
        '  timeout: 30m',
        stringify({ ...baseConfig(), triggers: undefined }).trimEnd(),
        'triggers:',
        '  implement:',
        '    <<: *trigger-defaults',
        '    issue: { labels: [workflow::in-progress] }',
        '    steps:',
        '      - agent:',
        '          <<: *step-defaults',
        '          prompt: ./prompts/implement.md',
        '          timeout: 60m',
        '',
      ].join('\n');

      const { config } = foundryConfigLoaderService.load(writeConfig(yaml), EXAMPLE_ENV);

      expect(config.triggers[0]).toMatchObject({
        name: 'implement',
        steps: [{ kind: 'agent', environment: { name: 'node' }, timeout: 3_600_000 }],
        source: { name: 'gitlab' },
      });
    });

    it('refuses a duplicate key', () => {
      const error = loadError(writeConfig('sources: {}\nsources: {}\n'));

      expect(error.issues[0].message).toBe('YAML syntax error (DUPLICATE_KEY)');
    });

    it('refuses alias expansion past the limit', () => {
      const anchors = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];

      for (let i = 1; i <= 8; i++) {
        anchors.push(
          `${'b'.repeat(i)}: &${'b'.repeat(i)} [${Array(10)
            .fill(i === 1 ? '*a' : `*${'b'.repeat(i - 1)}`)
            .join(', ')}]`
        );
      }

      const error = loadError(writeConfig(`${anchors.join('\n')}\n`));

      expect(error.issues[0].message).toMatch(/alias/i);
    });
  });

  describe('secrets', () => {
    it('never prints a variable value or token in the error output', () => {
      const config = baseConfig();
      config.sources.gitlab = { ...config.sources.gitlab, url: '${GITLAB_TOKEN}' };
      config.triggers.implement = withStep(config.triggers.implement, { prompt: './${GITLAB_TOKEN}/missing.md' });

      const error = loadError(writeConfig(config));

      for (const secret of Object.values(EXAMPLE_ENV)) {
        expect(error.message).not.toContain(secret);
      }

      expect(error.message).toContain('sources.gitlab.url');
    });

    it('masks a variable value in a reported file path', () => {
      const config = baseConfig();
      config.triggers.implement = withStep(config.triggers.implement, { prompt: './${GITLAB_TOKEN}/missing.md' });

      const error = loadError(writeConfig(config));

      expect(linesOf(error)[0]).toMatch(/\[redacted\]\/missing\.md/);
    });
  });
});
