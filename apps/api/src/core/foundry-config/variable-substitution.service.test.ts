import { beforeEach, describe, expect, it } from 'vitest';

import { VariableSubstitutionService } from '@/core/foundry-config/variable-substitution.service';

const lookupFrom =
  (variables: Record<string, string>) =>
  (name: string): string | undefined =>
    variables[name];

describe('VariableSubstitutionService', () => {
  let variableSubstitutionService: VariableSubstitutionService;

  beforeEach(() => {
    variableSubstitutionService = new VariableSubstitutionService();
  });

  it('replaces every reference in nested strings and lists', () => {
    const result = variableSubstitutionService.substitute(
      { sources: { local: { token: '${TOKEN}', projects: ['${GROUP}/app', 'fixed'] } } },
      lookupFrom({ TOKEN: 'glpat-secret', GROUP: 'acme' })
    );

    expect(result.issues).toEqual([]);
    expect(result.value).toEqual({ sources: { local: { token: 'glpat-secret', projects: ['acme/app', 'fixed'] } } });
  });

  it('records each substituted value with its key path', () => {
    const result = variableSubstitutionService.substitute(
      { a: '${ONE}', b: ['x-${TWO}'] },
      lookupFrom({ ONE: 'first', TWO: 'second' })
    );

    expect(result.substitutions).toEqual([
      { path: ['a'], value: 'first' },
      { path: ['b', 0], value: 'second' },
    ]);
  });

  it('names the variable and the key path of an unset variable', () => {
    const result = variableSubstitutionService.substitute(
      { sources: { local: { token: '${GITLAB_TOKEN}' } } },
      lookupFrom({})
    );

    expect(result.issues).toEqual([{ path: 'sources.local.token', message: '${GITLAB_TOKEN} is not set' }]);
  });

  it('counts an empty variable as unset', () => {
    const result = variableSubstitutionService.substitute({ token: '${TOKEN}' }, lookupFrom({ TOKEN: '' }));

    expect(result.issues).toEqual([{ path: 'token', message: '${TOKEN} is not set' }]);
  });

  it('names a list item by its index', () => {
    const result = variableSubstitutionService.substitute({ projects: ['ok', '${MISSING}'] }, lookupFrom({}));

    expect(result.issues[0].path).toBe('projects[1]');
  });

  it('refuses a reference that is not a variable name', () => {
    const result = variableSubstitutionService.substitute({ token: '${not valid}' }, lookupFrom({}));

    expect(result.issues).toEqual([{ path: 'token', message: '"${not valid}" is not a valid variable reference' }]);
  });

  it('leaves keys, numbers and booleans as written', () => {
    const result = variableSubstitutionService.substitute({ '${KEY}': 4, flag: true }, lookupFrom({ KEY: 'value' }));

    expect(result.value).toEqual({ '${KEY}': 4, flag: true });
  });

  it('inserts a value holding a reference as written, without substituting it again', () => {
    const result = variableSubstitutionService.substitute(
      { token: '${OUTER}' },
      lookupFrom({ OUTER: '${INNER}', INNER: 'inner' })
    );

    expect(result.value).toEqual({ token: '${INNER}' });
  });

  it('keeps a __proto__ key as data rather than setting the prototype', () => {
    const result = variableSubstitutionService.substitute(
      JSON.parse('{"__proto__": {"polluted": "${VALUE}"}}'),
      lookupFrom({ VALUE: 'x' })
    );

    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.keys(result.value as object)).toEqual(['__proto__']);
  });
});
