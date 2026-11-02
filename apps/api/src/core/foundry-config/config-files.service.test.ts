import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigRevision } from './entities/config-revision.entity';

import { ConfigFilesService } from './config-files.service';
import type { ConfigRepoGitService } from './config-repo-git.service';
import type { ConfigRepoService } from './config-repo.service';
import type { ConfigRevisionService } from './config-revision.service';
import type { FoundryConfigService } from './foundry-config.service';
import { REDACTED, SecretRedactionService } from './secret-redaction.service';
import { VariableSubstitutionService } from './variable-substitution.service';
import type { ConfigService } from '@/config/config.service';

import { ConfigRevisionStatus, type IConfigRepo } from './types/foundry-config.types';

const SHA = 'a'.repeat(40);
const CURRENT = new Date('2026-10-30T09:00:00Z');

/** Known to the running config, as a `${VAR}` value it substituted. */
const RUNNING_SECRET = 'glpat-runningsecret';
const INLINE_TOKEN = 'sk-ant-inline-token';
const INLINE_PASSWORD = 'hunter2hunter2';
const SETTINGS_TOKEN = 'ghp_settingssecret';
const URL_TOKEN = 'glpat-urlcredential==';
const COMMENTED_TOKEN = 'glpat-oldcommented';
const DATABASE_PASSWORD = 'Sup3rS3cretPw';
const DEPLOY_KEY_LINE = 'deploykeylinebody';
const HELPER_KEY = 'sk-ant-helperkey';
const NUMERIC_PASSWORD = 123456789012;
const COMMENTED_URL_PASSWORD = 'oldcommentedpass';
const QUOTED_PASSWORD = "Pa'ssw0rd-prod";
const COLON_PASSWORD = 'abc:defghijk';
const PG_PASSWORD = 's3cretPassw0rdPg';
const SHORT_PASSWORD = 'hunter2';
const SHORT_URL_PASSWORD = 'hunter3';
const OTLP_KEY = 'otlp-bearer-value';
const CUSTOM_HEADER_KEY = 's3cr3t-custom-key';
const PROMPT_TOKEN = 'glpat-promptsecret';
const INSTRUCTIONS_PASSWORD = 's3cretpassw0rd';
const SETTINGS_SECRET = 's3ttingsSecretValue';

const YAML = `sources:
  gitlab:
    type: gitlab
    url: https://gitlab.test
    # token: ${COMMENTED_TOKEN}
    token: \${ORCHESTRATOR_GITLAB_TOKEN}
    projects: [group/project]

x-agent: &agent
  environment: node
  prompt: ./prompts/anchor.md

agents:
  claude:
    type: claude
    auth: apiKey
    token: ${INLINE_TOKEN}
    model: claude-opus-5-5
    settings: ./agents/claude/settings.json
    instructions: ../outside.md

environments:
  node:
    image: node:24
    env:
      DB_PASSWORD: ${INLINE_PASSWORD}
      # DATABASE_URL: postgres://app:${COMMENTED_URL_PASSWORD}@db.test/app
      DATABASE_URL: postgres://app:${DATABASE_PASSWORD}@db.test/app
      REPLICA_URL: postgres://app:${COLON_PASSWORD}@replica.test/app
      PGPASSWORD: ${PG_PASSWORD}
      POSTGRES_PASSWORD: ${SHORT_PASSWORD}
      SHORT_URL: postgres://bot:${SHORT_URL_PASSWORD}@db.test/app
      DB_PWD: pwd12
      GITLAB_PAT: pat12
      APP_PASSWORD: '${QUOTED_PASSWORD.replaceAll("'", "''")}'
      DEPLOY_KEY: |
        -----BEGIN OPENSSH PRIVATE KEY-----
        ${DEPLOY_KEY_LINE}
        -----END OPENSSH PRIVATE KEY-----
      GITLAB_HOST: gitlab.test
    services:
      db: { image: postgres:17, env: { POSTGRES_PASSWORD: ${NUMERIC_PASSWORD} } }
    agent:
      name: claude
      instructions: ./.env

triggers:
  implement:
    source: gitlab
    issue: { labels: [workflow::ready] }
    steps:
      - agent:
          <<: *agent
          systemPrompt: ./prompts/implement/system-prompt.md
          prompt: ./prompts/implement/prompt.md
          agent: { settings: ./agents/claude/settings.json }
    failureSteps:
      - agent:
          environment: node
          prompt: ./prompts/\${PROMPT_DIR}/failed.md
      - comment: 'Failed: {{failure.reason}}'
`;

const FILES: Record<string, string> = {
  'swarmfoundry.yaml': YAML,
  'agents/claude/settings.json': JSON.stringify({
    env: {
      GITHUB_TOKEN: SETTINGS_TOKEN,
      GIT_HOST: 'gitlab.test',
      DEPLOY_SECRET: SETTINGS_SECRET,
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${OTLP_KEY}`,
      ANTHROPIC_CUSTOM_HEADERS: `Authorization: Bearer ${CUSTOM_HEADER_KEY}`,
    },
    apiKeyHelper: `echo ${HELPER_KEY}`,
    extraKnownMarketplaces: { team: { source: { url: `https://oauth2:${URL_TOKEN}@gitlab.test/team/plugins.git` } } },
  }),
  'prompts/implement/system-prompt.md': `Never print ${RUNNING_SECRET}.\nPush to https://deploy:${INSTRUCTIONS_PASSWORD}@gitlab.test/x.git.\nLog in with ${INLINE_PASSWORD} or ${SETTINGS_SECRET}.`,
  'prompts/implement/prompt.md': `Implement {{issue.url}}.\nClone https://oauth2:${PROMPT_TOKEN}@gitlab.test/x.git.`,
  'prompts/anchor.md': 'Only named through an anchor that a step overrides.',
  'prompts/failing/failed.md': 'Report the failure.',
  'prompts/unreferenced.md': 'No step names this file.',
  '.env': `ORCHESTRATOR_GITLAB_TOKEN=${RUNNING_SECRET}`,
};

const SERVED = [
  'swarmfoundry.yaml',
  'agents/claude/settings.json',
  'prompts/implement/prompt.md',
  'prompts/implement/system-prompt.md',
];

const revision = (): ConfigRevision => {
  const row = new ConfigRevision({ sha: SHA, status: ConfigRevisionStatus.LOADED, errors: [], seenDate: CURRENT });
  row.id = 3;
  row.currentDate = CURRENT;

  return row;
};

describe('ConfigFilesService', () => {
  const secretRedactionService = new SecretRedactionService();

  let repo: IConfigRepo | null;
  let runningSha: string | null;
  let configPath: string | null;
  let loadedFiles: Map<string, string>;
  let readFile: ReturnType<typeof vi.fn<ConfigRepoGitService['readFile']>>;
  let service: ConfigFilesService;

  beforeEach(() => {
    repo = { url: 'https://gitlab.test/group/config.git', branch: 'main', token: '', gitDir: '/clone/repo.git' };
    runningSha = SHA;
    configPath = null;
    loadedFiles = new Map();
    readFile = vi.fn<ConfigRepoGitService['readFile']>((_repo, _sha, path) =>
      Promise.resolve(path.startsWith('config/') ? (FILES[path.slice('config/'.length)] ?? null) : null)
    );

    const foundryConfigService = {
      get revision() {
        return runningSha;
      },
      get path() {
        return configPath;
      },
      get files() {
        return loadedFiles;
      },
      maskWritten: (text: string, extra: readonly string[] = []) =>
        secretRedactionService.maskCredentials(secretRedactionService.redactText(text, [RUNNING_SECRET, ...extra])),
    } as unknown as FoundryConfigService;

    vi.stubEnv('PROMPT_DIR', '');

    service = new ConfigFilesService(
      { configPath: 'config' } as ConfigService,
      {
        get repo() {
          return repo;
        },
      } as ConfigRepoService,
      { readFile } as unknown as ConfigRepoGitService,
      {
        findBySha: (sha: string) => Promise.resolve(sha === SHA ? revision() : null),
      } as unknown as ConfigRevisionService,
      foundryConfigService,
      secretRedactionService,
      new VariableSubstitutionService()
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('a config repo revision', () => {
    it('serves the config file and each file it references, from the config folder at the sha', async () => {
      const snapshot = await service.readRunning();

      expect(snapshot?.sha).toBe(SHA);
      expect(snapshot?.currentDate).toEqual(CURRENT);
      expect(snapshot?.files.map(file => file.path)).toEqual(SERVED);
      expect(readFile).toHaveBeenCalledWith(repo, SHA, 'config/swarmfoundry.yaml', expect.anything());
    });

    it('reads no .env, no file outside the folder, no unresolved path and no file nothing references', async () => {
      await service.readRunning();

      const read = readFile.mock.calls.map(([, , path]) => path);

      expect(read).not.toContain('config/.env');
      expect(read.some(path => path.includes('outside') || path.includes('${') || path.includes('unreferenced'))).toBe(
        false
      );
    });

    it('keeps ${VAR} as written, and masks every secret written in or known to the running config', async () => {
      const snapshot = await service.readRunning();
      const content = snapshot?.files.map(file => file.content).join('\n') ?? '';

      expect(content).toContain('token: ${ORCHESTRATOR_GITLAB_TOKEN}');
      expect(content).toContain(`token: ${REDACTED}`);
      expect(content).toContain(`DB_PASSWORD: ${REDACTED}`);
      expect(content).toContain('GITLAB_HOST: gitlab.test');
      expect(content).toContain('auth: apiKey');
      expect(content).toContain(`Never print ${REDACTED}.`);
      expect(content).not.toContain(INLINE_TOKEN);
      expect(content).not.toContain(INLINE_PASSWORD);
      expect(content).not.toContain(RUNNING_SECRET);
    });

    it('masks a token in a comment, a URL password and each line of a block scalar secret', async () => {
      const snapshot = await service.readRunning();
      const yaml = snapshot?.files[0].content ?? '';

      expect(yaml).not.toContain(COMMENTED_TOKEN);
      expect(yaml).not.toContain(DATABASE_PASSWORD);
      expect(yaml).not.toContain(DEPLOY_KEY_LINE);
      expect(yaml).not.toContain(String(NUMERIC_PASSWORD));
      expect(yaml).not.toContain(COMMENTED_URL_PASSWORD);
      expect(yaml).not.toContain('defghijk');
      expect(yaml).not.toContain(PG_PASSWORD);
      expect(yaml).not.toContain("Pa''ssw0rd-prod");
      expect(yaml).toContain('@db.test/app');
    });

    it('masks a secret too short to mask everywhere, in place: by its key or as a URL password', async () => {
      const snapshot = await service.readRunning();
      const yaml = snapshot?.files[0].content ?? '';

      expect(yaml).toContain(`POSTGRES_PASSWORD: ${REDACTED}`);
      expect(yaml).toContain(`SHORT_URL: postgres://bot:${REDACTED}@db.test/app`);
      expect(yaml).toContain(`DB_PWD: ${REDACTED}`);
      expect(yaml).toContain(`GITLAB_PAT: ${REDACTED}`);
      expect(yaml).not.toContain(SHORT_PASSWORD);
      expect(yaml).not.toContain(SHORT_URL_PASSWORD);
    });

    it('masks the credential in a header variable of a settings file', async () => {
      const snapshot = await service.readRunning();
      const settings = snapshot?.files.find(file => file.path === 'agents/claude/settings.json')?.content ?? '';

      expect(settings).not.toContain(OTLP_KEY);
      expect(settings).not.toContain(CUSTOM_HEADER_KEY);
    });

    it('masks a URL password and a token written into a prompt', async () => {
      const snapshot = await service.readRunning();
      const prompts = snapshot?.files.filter(file => file.path.endsWith('.md')).map(file => file.content) ?? [];

      expect(prompts).toContain(`Implement {{issue.url}}.\nClone https://oauth2:${REDACTED}@gitlab.test/x.git.`);
      expect(prompts.join('\n')).not.toContain(INSTRUCTIONS_PASSWORD);
    });

    it('masks a secret written into a referenced file, by its key or inside a URL', async () => {
      const snapshot = await service.readRunning();
      const settings = snapshot?.files.find(file => file.path === 'agents/claude/settings.json')?.content ?? '';

      expect(settings).not.toContain(SETTINGS_TOKEN);
      expect(settings).not.toContain(URL_TOKEN);
      expect(settings).not.toContain(HELPER_KEY);
      expect(settings).toContain('gitlab.test');
    });

    it('masks a secret written in one file wherever another file repeats it', async () => {
      const snapshot = await service.readRunning();
      const systemPrompt = snapshot?.files.find(file => file.path.endsWith('system-prompt.md'))?.content ?? '';

      expect(systemPrompt).toContain(`Log in with ${REDACTED} or ${REDACTED}.`);
    });

    it("draws none of the orchestrator's own secrets into a referenced path", async () => {
      vi.stubEnv('TYPEORM_PASSWORD', 'failing');
      readFile.mockImplementation((_repo, _sha, path) =>
        Promise.resolve(
          path === 'config/swarmfoundry.yaml'
            ? YAML.replace('${PROMPT_DIR}', '${TYPEORM_PASSWORD}')
            : (FILES[path.slice('config/'.length)] ?? null)
        )
      );

      const snapshot = await service.readRunning();

      expect(snapshot?.files.map(file => file.path)).not.toContain('prompts/failing/failed.md');
    });

    it('fills ${VAR} in a referenced path from the environment, as the loader does', async () => {
      vi.stubEnv('PROMPT_DIR', 'failing');

      const snapshot = await service.readRunning();

      expect(snapshot?.files.map(file => file.path)).toContain('prompts/failing/failed.md');
    });

    it('reads nothing for a revision the clone no longer holds', async () => {
      readFile.mockResolvedValue(null);

      await expect(service.read(revision())).resolves.toBeNull();
    });

    it('serves nothing for a config file that does not parse, since its secrets cannot be found', async () => {
      readFile.mockImplementation((_repo, _sha, path) =>
        Promise.resolve(path === 'config/swarmfoundry.yaml' ? `token: ${INLINE_TOKEN}\nsources: [unclosed` : '{}')
      );

      await expect(service.read(revision())).resolves.toBeNull();
    });
  });

  describe('a local file', () => {
    const folder = join('/srv', 'config');

    beforeEach(() => {
      repo = null;
      runningSha = null;
      configPath = join(folder, 'swarmfoundry.yaml');
      loadedFiles = new Map([
        [configPath, YAML],
        [join(folder, 'agents/claude/settings.json'), FILES['agents/claude/settings.json']],
        [join(folder, '..', 'outside.md'), 'Shared instructions.'],
        [join(folder, '.env'), FILES['.env']],
        [join(folder, 'prompts/implement/prompt.md'), FILES['prompts/implement/prompt.md']],
      ]);
    });

    it('serves the file and its references as they loaded, with no sha and no .env', async () => {
      const snapshot = await service.readRunning();

      expect(snapshot?.sha).toBeNull();
      expect(snapshot?.currentDate).toBeNull();
      // A local file may reference one outside its folder, as the loader reads it.
      expect(snapshot?.files.map(file => file.path)).toEqual([
        ...SERVED.slice(0, 2),
        '../outside.md',
        'prompts/implement/prompt.md',
      ]);
      expect(snapshot?.files.map(file => file.content).join('\n')).not.toContain(INLINE_TOKEN);
      expect(snapshot?.files.map(file => file.content).join('\n')).not.toContain(RUNNING_SECRET);
    });

    it('has no revisions', async () => {
      await expect(service.findRevision(SHA)).resolves.toBeNull();
      await expect(service.read(revision())).resolves.toBeNull();
    });

    it('serves nothing when no config file was found', async () => {
      configPath = null;

      await expect(service.readRunning()).resolves.toBeNull();
    });
  });
});
