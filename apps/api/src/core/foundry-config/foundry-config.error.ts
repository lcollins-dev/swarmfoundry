import { z } from 'zod';

import type { IConfigIssue, KeyPath } from './foundry-config.types';
import { ConfigError } from '@/config/config.schema';

export function formatKeyPath(path: KeyPath): string {
  let formatted = '';

  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
    } else {
      formatted += formatted === '' ? String(segment) : `.${String(segment)}`;
    }
  }

  return formatted === '' ? '(root)' : formatted;
}

export function issueAt(path: KeyPath, message: string): IConfigIssue {
  return { path: formatKeyPath(path), message };
}

/** Zod's messages name the expected input, never the received value. */
export function issuesFromZod(issues: readonly z.core.$ZodIssue[], prefix: KeyPath = []): IConfigIssue[] {
  return issues.flatMap(issue => {
    const path = [...prefix, ...issue.path];

    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map(key => issueAt([...path, key], 'is not a known key'));
    }

    if (issue.code === 'invalid_key') {
      return [issueAt(path, issue.issues[0]?.message ?? issue.message)];
    }

    return [issueAt(path, issue.message)];
  });
}

export class FoundryConfigError extends ConfigError {
  readonly issues: readonly IConfigIssue[];

  constructor(configPath: string, issues: readonly IConfigIssue[]) {
    const lines = issues.map(issue => `  ${issue.path}: ${issue.message}`);

    super([`${configPath} is invalid:`, ...lines].join('\n'));
    this.name = 'FoundryConfigError';
    this.issues = issues;
  }
}
