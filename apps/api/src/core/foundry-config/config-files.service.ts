import { Injectable } from '@nestjs/common';
import { basename, dirname, posix, relative } from 'node:path';
import { parseDocument } from 'yaml';

import type { ConfigRevision } from './entities/config-revision.entity';

import { ConfigRepoGitService } from './config-repo-git.service';
import { CONFIG_FILE, ConfigRepoService } from './config-repo.service';
import { ConfigRevisionService } from './config-revision.service';
import { FoundryConfigService } from './foundry-config.service';
import { SecretRedactionService } from './secret-redaction.service';
import { VariableSubstitutionService } from './variable-substitution.service';
import { ConfigService } from '@/config/config.service';

import type { IConfigRepo, KeyPath } from './types/foundry-config.types';
import { SECRETS } from '@/config/config.schema';

/** Stops a small file unfolding into a huge one through aliases, as the loader does. */
const MAX_ALIAS_COUNT = 100;

/** A `.env`, or a variant such as `.env.local`, holds secrets whatever references it. */
const DOT_ENV = /^\.env(?:\..*)?$/;

const AGENT_FILE_KEYS = ['settings', 'instructions'];

/** Where a config names a file: an agent's settings and instructions, wherever an agent block sits, and a step's prompts. */
const FILE_PATHS: readonly KeyPath[] = [
  ...AGENT_FILE_KEYS.flatMap(key => [
    ['agents', '*', key],
    ['environments', '*', 'agent', key],
  ]),
  ...['steps', 'failureSteps'].flatMap(list => [
    ['triggers', '*', list, '*', 'agent', 'prompt'],
    ['triggers', '*', list, '*', 'agent', 'systemPrompt'],
    ...AGENT_FILE_KEYS.map(key => ['triggers', '*', list, '*', 'agent', 'agent', key]),
  ]),
];

/** A file of the config as written, by its path from the config folder. */
export interface IConfigText {
  path: string;
  content: string;
}

export interface IConfigSnapshot {
  /** Null for a local file. */
  sha: string | null;
  /** When the revision first became the running config. Null for a local file, or one that never did. */
  currentDate: Date | null;
  /** The config file first, then each file it references that reads. */
  files: IConfigText[];
}

/**
 * Reads the config file and the files it references, as written, with `${VAR}` unresolved and every secret masked. It
 * serves no other file, so a `.env` beside the config never leaves the host.
 */
@Injectable()
export class ConfigFilesService {
  constructor(
    private readonly configService: ConfigService,
    private readonly configRepoService: ConfigRepoService,
    private readonly configRepoGitService: ConfigRepoGitService,
    private readonly configRevisionService: ConfigRevisionService,
    private readonly foundryConfigService: FoundryConfigService,
    private readonly secretRedactionService: SecretRedactionService,
    private readonly variableSubstitutionService: VariableSubstitutionService
  ) {}

  /** The running revision, or the local file and its references as they loaded. Null with no config file. */
  async readRunning(): Promise<IConfigSnapshot | null> {
    const sha = this.foundryConfigService.revision;

    if (sha !== null) {
      const revision = await this.findRevision(sha);

      return revision === null ? null : this.read(revision);
    }

    const path = this.foundryConfigService.path;

    if (path === null) {
      return null;
    }

    // A local file may reference files outside its folder, as the loader allows.
    const files = [...this.foundryConfigService.files]
      .map(([file, content]) => ({ path: relative(dirname(path), file), content }))
      .filter(file => !DOT_ENV.test(basename(file.path)));

    return this.masked(null, null, files);
  }

  /** A config repo revision that reached a load verdict. Null for a local file. */
  findRevision(sha: string): Promise<ConfigRevision | null> {
    return this.configRepoService.repo === null ? Promise.resolve(null) : this.configRevisionService.findBySha(sha);
  }

  /** Null when the clone no longer holds the revision's config file. */
  read(revision: ConfigRevision): Promise<IConfigSnapshot | null> {
    const repo = this.configRepoService.repo;

    return repo === null ? Promise.resolve(null) : this.readAt(repo, revision);
  }

  private async readAt(repo: IConfigRepo, revision: ConfigRevision): Promise<IConfigSnapshot | null> {
    const signal = new AbortController().signal;
    const readText = (file: string) =>
      this.configRepoGitService.readFile(repo, revision.sha, posix.join(this.configService.configPath, file), signal);

    const yaml = await readText(CONFIG_FILE);
    const tree = yaml === null ? undefined : this.parse(yaml);

    if (yaml === null || tree === undefined) {
      return null;
    }

    const files: IConfigText[] = [{ path: CONFIG_FILE, content: yaml }];

    for (const path of this.referencedFiles(tree).filter(path => path !== CONFIG_FILE)) {
      const content = await readText(path);

      if (content !== null) {
        files.push({ path, content });
      }
    }

    return this.masked(revision.sha, revision.currentDate, files);
  }

  /**
   * `files` with the config file first. Null when it does not parse, since its secrets could not then be found to
   * mask. Values under a secret key are masked in place first, while the text still parses.
   */
  private masked(sha: string | null, currentDate: Date | null, files: IConfigText[]): IConfigSnapshot | null {
    const tree = files.length === 0 ? undefined : this.parse(files[0].content);

    if (tree === undefined) {
      return null;
    }

    const secrets = this.secretRedactionService.collectWritten(tree, files[0].content);
    const keyed = new Set<IConfigText>([files[0]]);

    for (const file of files.slice(1)) {
      const json = this.parseJson(file.content);

      if (json !== null) {
        keyed.add(file);

        for (const secret of this.secretRedactionService.collectNamed(json)) {
          secrets.add(secret);
        }
      }
    }

    return {
      sha,
      currentDate,
      files: files.map(file => {
        const content = keyed.has(file) ? this.secretRedactionService.maskKeyedValues(file.content) : file.content;

        return { ...file, content: this.foundryConfigService.maskWritten(content, [...secrets]) };
      }),
    };
  }

  /** Undefined when the file is not YAML. */
  private parse(yaml: string): unknown {
    const document = parseDocument(yaml, { merge: true });

    try {
      return document.errors.length > 0 ? undefined : document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
    } catch {
      return undefined;
    }
  }

  /** Null for a file that is not JSON, such as a prompt, whose prose is scanned for credentials alone. */
  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Each path with `${VAR}` filled in as the loader fills it, normalised from the config folder, once. One that does
   * not resolve, names a `.env`, or leaves the folder, as a revision's load refuses, is left out.
   */
  private referencedFiles(tree: unknown): string[] {
    const paths = new Set<string>();

    const walk = (node: unknown, keyPath: KeyPath): void => {
      if (typeof node === 'string' && FILE_PATHS.some(pattern => matches(keyPath, pattern))) {
        const substitution = this.variableSubstitutionService.substitute(node, name => this.variable(name));
        const path = posix.normalize(String(substitution.value));
        const outside = posix.isAbsolute(path) || path === '..' || path.startsWith('../');

        if (substitution.issues.length === 0 && !outside && !DOT_ENV.test(posix.basename(path))) {
          paths.add(path);
        }
      } else if (Array.isArray(node)) {
        node.forEach((item: unknown, index) => walk(item, [...keyPath, index]));
      } else if (typeof node === 'object' && node !== null) {
        for (const [key, item] of Object.entries(node)) {
          // Top-level `x-*` keys hold anchors, which the files they merge into already name.
          if (keyPath.length > 0 || !key.startsWith('x-')) {
            walk(item, [...keyPath, key]);
          }
        }
      }
    };

    walk(tree, []);

    return [...paths];
  }

  /** From the environment without the orchestrator's own secrets, so no path can draw one in. */
  private variable(name: string): string | undefined {
    return new Set<string>(SECRETS).has(name) ? undefined : process.env[name];
  }
}

function matches(keyPath: KeyPath, pattern: KeyPath): boolean {
  return (
    pattern.length === keyPath.length &&
    pattern.every((segment, index) => segment === '*' || segment === keyPath[index])
  );
}
