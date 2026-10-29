import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { ConfigService } from '@/config/config.service';
import { AgentResolutionService } from '@/core/foundry-config/agent-resolution.service';
import { ConfigRepoGitService, GitError } from '@/core/foundry-config/config-repo-git.service';
import { ConfigRepoService } from '@/core/foundry-config/config-repo.service';
import { ConfigRevisionService } from '@/core/foundry-config/config-revision.service';
import { FoundryConfigLoaderService } from '@/core/foundry-config/foundry-config-loader.service';
import { PromptTemplateService } from '@/core/foundry-config/prompt-template.service';
import { SecretRedactionService } from '@/core/foundry-config/secret-redaction.service';
import { VariableSubstitutionService } from '@/core/foundry-config/variable-substitution.service';

import { ConfigError } from '@/config/config.schema';
import type { IConfigRepo } from '@/core/foundry-config/foundry-config.types';
import type { IAgentStepConfig, IStepConfig } from '@/core/foundry-config/foundry-config.types';

const isAgentStep = (step: IStepConfig): step is IAgentStepConfig => step.kind === 'agent';

const TRACKING_REF = 'refs/remotes/origin/main';
const GOOD_REF = 'refs/swarmfoundry/good/main';

type Files = Record<string, string>;

/** Commits by sha, in branch order, so an earlier commit is an ancestor of a later one. */
class FakeGit {
  readonly commits = new Map<string, Files>();
  readonly refs = new Map<string, string>();

  head: string | null = null;
  fetchError: Error | null = null;
  exportError: Error | null = null;
  exports = 0;

  init = vi.fn(() => Promise.resolve());

  commit(sha: string, files: Files): string {
    this.commits.set(sha, files);
    this.head = sha;

    return sha;
  }

  fetch(): Promise<string> {
    if (this.fetchError !== null) {
      return Promise.reject(this.fetchError);
    }

    if (this.head === null) {
      return Promise.reject(new GitError('no branch'));
    }

    this.refs.set(TRACKING_REF, this.head);

    return Promise.resolve(this.head);
  }

  resolve(_repo: IConfigRepo, ref: string): Promise<string | null> {
    return Promise.resolve(this.refs.get(ref) ?? (this.commits.has(ref) ? ref : null));
  }

  isAncestor(_repo: IConfigRepo, ancestor: string, descendant: string): Promise<boolean> {
    const order = [...this.commits.keys()];

    return Promise.resolve(order.indexOf(ancestor) <= order.indexOf(descendant));
  }

  listFiles(_repo: IConfigRepo, sha: string): Promise<string[]> {
    return Promise.resolve(Object.keys(this.commits.get(sha) ?? {}));
  }

  export(_repo: IConfigRepo, sha: string, folder: string, target: string): Promise<boolean> {
    this.exports++;

    if (this.exportError !== null) {
      return Promise.reject(this.exportError);
    }

    const prefix = folder === '' ? '' : `${folder}/`;
    const files = Object.entries(this.commits.get(sha) ?? {}).filter(([path]) => path.startsWith(prefix));

    if (files.length === 0) {
      return Promise.resolve(false);
    }

    rmSync(target, { recursive: true, force: true });

    for (const [path, content] of files) {
      const file = join(target, path.slice(prefix.length));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }

    return Promise.resolve(true);
  }

  setRef(_repo: IConfigRepo, ref: string, sha: string): Promise<void> {
    this.refs.set(ref, sha);

    return Promise.resolve();
  }

  trackingRef(): string {
    return TRACKING_REF;
  }
}

const configYaml = (overrides: { prompt?: string; token?: string; instructions?: string } = {}) =>
  stringify({
    sources: {
      gitlab: {
        type: 'gitlab',
        url: 'https://gitlab.example.com',
        token: overrides.token ?? '${GITLAB_TOKEN}',
        projects: ['acme/app'],
      },
    },
    agents: {
      subscription: {
        type: 'claude',
        auth: 'oauth',
        token: '${CLAUDE_CODE_OAUTH_TOKEN}',
        model: 'claude-opus-5-5',
        instructions: overrides.instructions,
      },
    },
    environments: { node: { image: 'agent:latest', agent: { name: 'subscription' } } },
    triggers: {
      implement: {
        source: 'gitlab',
        steps: [
          { agent: { environment: 'node', prompt: overrides.prompt ?? './prompts/implement.md', timeout: '60m' } },
        ],
        issue: { labels: ['workflow::ready'] },
      },
    },
  });

const validFiles = (folder = ''): Files => {
  const prefix = folder === '' ? '' : `${folder}/`;

  return {
    [`${prefix}swarmfoundry.yaml`]: configYaml(),
    [`${prefix}prompts/implement.md`]: 'Implement #{{issue.iid}}',
  };
};

const brokenFiles = (): Files => ({ ...validFiles(), 'swarmfoundry.yaml': `${configYaml()}\nunknown: true\n` });

describe('ConfigRepoService', () => {
  const signal = new AbortController().signal;

  let cloneDir: string;
  let fakeGit: FakeGit;
  let configService: Record<string, unknown>;
  let service: ConfigRepoService;
  let repo: IConfigRepo;
  let errors: unknown[][];
  let warnings: unknown[][];
  let recordLoad: ReturnType<typeof vi.fn<ConfigRevisionService['recordLoad']>>;

  beforeEach(async () => {
    cloneDir = mkdtempSync(join(tmpdir(), 'config-repo-'));
    fakeGit = new FakeGit();
    configService = {
      configRepo: 'https://gitlab.example.com/ops/config.git',
      configBranch: 'main',
      configToken: 'glpat-config-secret',
      configCloneDir: cloneDir,
      configPath: '',
    };

    vi.stubEnv('GITLAB_TOKEN', 'glpat-orchestrator-secret');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-subscription-secret');

    errors = [];
    warnings = [];
    recordLoad = vi.fn<ConfigRevisionService['recordLoad']>().mockResolvedValue(42);
    vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => void errors.push(args));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args));

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentResolutionService,
        ConfigRepoService,
        FoundryConfigLoaderService,
        PromptTemplateService,
        SecretRedactionService,
        VariableSubstitutionService,
        { provide: ConfigService, useValue: configService },
        { provide: ConfigRepoGitService, useValue: fakeGit },
        { provide: ConfigRevisionService, useValue: { recordLoad } },
      ],
    }).compile();

    service = moduleRef.get(ConfigRepoService);

    const configured = service.repo;

    if (configured === null) {
      throw new Error('expected a config repo');
    }

    repo = configured;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it('has no repo without SWARMFOUNDRY_CONFIG_REPO', () => {
    configService.configRepo = undefined;

    expect(service.repo).toBeNull();
  });

  describe('loadAtStartup', () => {
    it('loads the head, records it as good and removes the checkout', async () => {
      fakeGit.commit('a1', validFiles());

      const revision = await service.loadAtStartup(repo, signal);

      expect(revision.sha).toBe('a1');
      expect(revision.loaded.config.triggers.map(trigger => trigger.name)).toEqual(['implement']);
      expect(revision.loaded.config.triggers[0].steps.filter(isAgentStep)[0].prompt.content).toBe(
        'Implement #{{issue.iid}}'
      );
      expect(fakeGit.refs.get(GOOD_REF)).toBe('a1');
      expect(existsSync(join(cloneDir, 'checkout'))).toBe(false);
      expect(recordLoad).toHaveBeenCalledExactlyOnceWith('a1', []);
      expect(revision.id).toBe(42);
    });

    it('falls back to the last good revision when the head is broken, logging each error with the sha', async () => {
      fakeGit.commit('a1', validFiles());
      await service.loadAtStartup(repo, signal);
      fakeGit.commit('b2', brokenFiles());

      const revision = await service.loadAtStartup(repo, signal);

      expect(revision.sha).toBe('a1');
      expect(errors).toContainEqual([
        { sha: 'b2', path: 'unknown', reason: 'is not a known key' },
        'tryLoad(): Revision b2 is invalid at unknown: is not a known key',
      ]);
      expect(recordLoad).toHaveBeenCalledWith('b2', [{ path: 'unknown', message: 'is not a known key' }]);
    });

    it('falls back to the last good revision when the branch cannot be fetched', async () => {
      fakeGit.commit('a1', validFiles());
      await service.loadAtStartup(repo, signal);
      fakeGit.fetchError = new GitError('git fetch failed (exit code 128): Could not resolve host');

      await expect(service.loadAtStartup(repo, signal)).resolves.toMatchObject({ sha: 'a1' });
      expect(JSON.stringify(warnings)).toContain('Could not resolve host');
    });

    it('refuses to start on a broken head with no good revision', async () => {
      fakeGit.commit('b2', brokenFiles());

      await expect(service.loadAtStartup(repo, signal)).rejects.toThrow(ConfigError);
      await expect(service.loadAtStartup(repo, signal)).rejects.toThrow(/Revision b2 of main does not load/);
    });

    it('refuses to start when the branch cannot be fetched and there is no clone', async () => {
      fakeGit.fetchError = new GitError('git fetch failed (exit code 128)');

      await expect(service.loadAtStartup(repo, signal)).rejects.toThrow(/Cannot fetch main of https:/);
    });

    it('refuses to start when the clone cannot be made', async () => {
      fakeGit.init.mockRejectedValue(new GitError('git init failed (exit code 1)'));

      await expect(service.loadAtStartup(repo, signal)).rejects.toThrow(ConfigError);
    });

    it('falls back to no good revision the branch no longer reaches', async () => {
      fakeGit.commits.set('b2', brokenFiles());
      fakeGit.commit('a1', validFiles());
      await service.loadAtStartup(repo, signal);

      // As after a force-push: a1 is not an ancestor of the new head.
      fakeGit.head = 'b2';

      await expect(service.loadAtStartup(repo, signal)).rejects.toThrow(ConfigError);
      expect(JSON.stringify(warnings)).toContain('no longer on the branch');
    });

    it('refuses a fallback that no longer loads', async () => {
      fakeGit.commit('a1', validFiles());
      await service.loadAtStartup(repo, signal);
      fakeGit.commit('b2', brokenFiles());
      vi.stubEnv('GITLAB_TOKEN', undefined);

      await expect(service.loadAtStartup(repo, signal)).rejects.toThrow(/GITLAB_TOKEN/);
    });
  });

  describe('a revision', () => {
    const loadError = async (files: Files): Promise<string> => {
      fakeGit.commit('c3', files);

      await expect(service.loadAtStartup(repo, signal)).rejects.toThrow(ConfigError);

      return JSON.stringify(errors);
    };

    it('fails to load when it holds a .env file anywhere', async () => {
      const logged = await loadError({ ...validFiles(), 'deploy/.env': 'GITLAB_TOKEN=committed' });

      expect(logged).toContain('deploy/.env');
      expect(logged).toContain('is a .env file');
    });

    it("never fills a ${VAR} with one of the orchestrator's own secrets", async () => {
      vi.stubEnv('USER_TOKEN_SECRET', 'console-session-secret');

      const logged = await loadError({
        ...validFiles(),
        'swarmfoundry.yaml': configYaml({ token: '${USER_TOKEN_SECRET}' }),
      });

      expect(logged).toContain('USER_TOKEN_SECRET');
      expect(logged).not.toContain('console-session-secret');
    });

    it('refuses a referenced file outside the config folder', async () => {
      const logged = await loadError({ ...validFiles(), 'swarmfoundry.yaml': configYaml({ prompt: '../outside.md' }) });

      expect(logged).toContain('must stay inside the config folder');
    });

    it('refuses instructions outside the config folder', async () => {
      const logged = await loadError({
        ...validFiles(),
        'swarmfoundry.yaml': configYaml({ instructions: '../CLAUDE.md' }),
      });

      expect(logged).toContain('agents.subscription.instructions: ../CLAUDE.md must stay inside the config folder');
    });

    it('loads from SWARMFOUNDRY_CONFIG_PATH', async () => {
      configService.configPath = 'deploy/config';
      fakeGit.commit('a1', { ...validFiles('deploy/config'), 'README.md': 'not config' });

      await expect(service.loadAtStartup(repo, signal)).resolves.toMatchObject({ sha: 'a1' });
    });

    it('fails to load when SWARMFOUNDRY_CONFIG_PATH is not a folder in it', async () => {
      configService.configPath = 'missing';

      const logged = await loadError(validFiles());

      expect(logged).toContain('SWARMFOUNDRY_CONFIG_PATH missing is not a folder in the revision');
    });
  });

  describe('pollHead', () => {
    beforeEach(async () => {
      fakeGit.commit('a1', validFiles());
      await service.loadAtStartup(repo, signal);
    });

    it('loads nothing while the head stays put', async () => {
      const exports = fakeGit.exports;

      await expect(service.pollHead(repo, signal)).resolves.toBeNull();
      expect(fakeGit.exports).toBe(exports);
    });

    it('loads a new head and records it as good', async () => {
      fakeGit.commit('b2', validFiles());

      await expect(service.pollHead(repo, signal)).resolves.toMatchObject({ sha: 'b2' });
      expect(fakeGit.refs.get(GOOD_REF)).toBe('b2');
    });

    it('logs a broken head once and tries it again only once the branch moves', async () => {
      fakeGit.commit('b2', brokenFiles());

      await expect(service.pollHead(repo, signal)).resolves.toBeNull();
      expect(fakeGit.refs.get(GOOD_REF)).toBe('a1');

      const exports = fakeGit.exports;
      await service.pollHead(repo, signal);

      expect(fakeGit.exports).toBe(exports);

      fakeGit.commit('c3', validFiles());

      await expect(service.pollHead(repo, signal)).resolves.toMatchObject({ sha: 'c3' });
    });

    it('keeps the running config when the branch cannot be fetched', async () => {
      fakeGit.fetchError = new GitError('git fetch failed (exit code 128)');

      await expect(service.pollHead(repo, signal)).resolves.toBeNull();
      expect(JSON.stringify(warnings)).toContain('so the running config stays');
    });

    it('tries a head again when its load failed for a reason other than the revision', async () => {
      fakeGit.commit('b2', validFiles());
      fakeGit.exportError = new GitError('git read-tree failed (exit code 128)');

      await expect(service.pollHead(repo, signal)).resolves.toBeNull();

      fakeGit.exportError = null;

      await expect(service.pollHead(repo, signal)).resolves.toMatchObject({ sha: 'b2' });
      expect(recordLoad.mock.calls.filter(([sha]) => sha === 'b2')).toEqual([['b2', []]]);
    });

    it('swaps in no head whose row cannot be written, and tries it again on the next poll', async () => {
      fakeGit.commit('b2', validFiles());
      recordLoad.mockRejectedValueOnce(new Error('connection lost'));

      await expect(service.pollHead(repo, signal)).resolves.toBeNull();
      expect(fakeGit.refs.get(GOOD_REF)).toBe('a1');

      await expect(service.pollHead(repo, signal)).resolves.toMatchObject({ id: 42, sha: 'b2' });
    });

    it('still logs a broken head whose row cannot be written', async () => {
      fakeGit.commit('b2', brokenFiles());
      recordLoad.mockRejectedValueOnce(new Error('connection lost'));

      await expect(service.pollHead(repo, signal)).resolves.toBeNull();
      expect(JSON.stringify(errors)).toContain('Revision b2 is invalid at unknown');
    });
  });

  describe('loadPinned', () => {
    const OLD = 'a'.repeat(40);
    const HEAD = 'b'.repeat(40);

    beforeEach(async () => {
      const files = { ...validFiles(), 'swarmfoundry.yaml': configYaml({ instructions: './CLAUDE.md' }) };
      fakeGit.commit(OLD, { ...files, 'prompts/implement.md': 'Old prompt', 'CLAUDE.md': 'Old instructions' });
      fakeGit.commit(HEAD, { ...files, 'prompts/implement.md': 'New prompt', 'CLAUDE.md': 'New instructions' });
      await service.loadAtStartup(repo, signal);
    });

    it('loads an older revision of the branch without making it the last good one', async () => {
      const revision = await service.loadPinned(repo, OLD, signal);

      expect(revision?.loaded.config.triggers[0].steps.filter(isAgentStep)[0].prompt.content).toBe('Old prompt');
      expect(fakeGit.refs.get(GOOD_REF)).toBe(HEAD);
      expect(recordLoad).toHaveBeenCalledWith(OLD, []);
    });

    it("carries the agent's instructions as the pinned revision holds them", async () => {
      const pinned = await service.loadPinned(repo, OLD, signal);
      const head = await service.loadPinned(repo, HEAD, signal);

      expect(pinned?.loaded.config.triggers[0].steps.filter(isAgentStep)[0].agent.instructions?.content).toBe(
        'Old instructions'
      );
      expect(head?.loaded.config.triggers[0].steps.filter(isAgentStep)[0].agent.instructions?.content).toBe(
        'New instructions'
      );
    });

    it('records a revision that no longer loads as failed', async () => {
      vi.stubEnv('GITLAB_TOKEN', undefined);

      await expect(service.loadPinned(repo, OLD, signal)).resolves.toBeNull();
      expect(recordLoad).toHaveBeenCalledWith(OLD, [expect.objectContaining({ path: 'sources.gitlab.token' })]);
      expect(JSON.stringify(errors)).toContain(`loadPinned(): Revision ${OLD} is invalid at sources.gitlab.token`);
    });

    it('loads no revision the branch no longer reaches', async () => {
      const elsewhere = 'c'.repeat(40);
      fakeGit.commits.set(elsewhere, validFiles());

      await expect(service.loadPinned(repo, elsewhere, signal)).resolves.toBeNull();
      expect(JSON.stringify(errors)).toContain('is no longer on main');
    });

    it('loads nothing for a malformed sha', async () => {
      const exports = fakeGit.exports;

      await expect(service.loadPinned(repo, '--upload-pack=x', signal)).resolves.toBeNull();
      expect(fakeGit.exports).toBe(exports);
    });

    it('loads one revision at a time, since every load writes the same checkout', async () => {
      const [pinned, polled] = await Promise.all([
        service.loadPinned(repo, OLD, signal),
        service.loadPinned(repo, HEAD, signal),
      ]);

      expect(pinned?.loaded.config.triggers[0].steps.filter(isAgentStep)[0].prompt.content).toBe('Old prompt');
      expect(polled?.loaded.config.triggers[0].steps.filter(isAgentStep)[0].prompt.content).toBe('New prompt');
    });
  });
});
