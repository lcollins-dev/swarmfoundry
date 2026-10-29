import { Injectable } from '@nestjs/common';

import { issueAt } from './foundry-config.error';
import type { IConfigIssue, ISubstitutedValue, ISubstitution, KeyPath, VariableLookup } from './foundry-config.types';

const REFERENCE_PATTERN = /\$\{([^}]*)\}/g;
const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

@Injectable()
export class VariableSubstitutionService {
  /** Replaces `${VAR}` in string values only. Keys are left as written. */
  substitute(tree: unknown, lookup: VariableLookup): ISubstitution {
    const issues: IConfigIssue[] = [];
    const substitutions: ISubstitutedValue[] = [];

    const substituteString = (text: string, path: KeyPath): string =>
      text.replace(REFERENCE_PATTERN, (reference, variable: string) => {
        if (!VARIABLE_NAME_PATTERN.test(variable)) {
          issues.push(issueAt(path, `"${reference}" is not a valid variable reference`));

          return reference;
        }

        const value = lookup(variable);

        // An empty value counts as unset.
        if (value === undefined || value === '') {
          issues.push(issueAt(path, `\${${variable}} is not set`));

          return reference;
        }

        substitutions.push({ path, value });

        return value;
      });

    const walk = (node: unknown, path: KeyPath): unknown => {
      if (typeof node === 'string') {
        return substituteString(node, path);
      }

      if (Array.isArray(node)) {
        return node.map((item: unknown, index) => walk(item, [...path, index]));
      }

      if (typeof node === 'object' && node !== null) {
        // fromEntries defines each key as data, so a `__proto__` key stays a key.
        return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item, [...path, key])]));
      }

      return node;
    };

    return { value: walk(tree, []), issues, substitutions };
  }
}
