import { describe, expect, it } from 'vitest';

import { configFilePath, configLineSegments } from './configFile';

const CONFIG = `agents:
  claude:
    settings: ./agents/claude/settings.json

# A comment at the top level
x-trigger: &trigger
  source: gitlab
triggers:
  triage:
    <<: *trigger
    steps:
      - agent:
          prompt: './prompts/triage/prompt.md'

  review:
    issue: { labels: [workflow::review] }
environments:
  triage:
    image: agent`;

const linked = (segments: ReturnType<typeof configLineSegments>) =>
  segments.flatMap((line, index) =>
    line.filter(segment => segment.trigger ?? segment.file).map(segment => ({ line: index + 1, ...segment }))
  );

describe('configLineSegments', () => {
  it('links each trigger key under the top-level triggers, and each served path', () => {
    const segments = configLineSegments(
      CONFIG,
      new Set(['triage', 'review']),
      new Set(['agents/claude/settings.json', 'prompts/triage/prompt.md'])
    );

    expect(linked(segments)).toEqual([
      { line: 3, text: './agents/claude/settings.json', file: 'agents/claude/settings.json' },
      { line: 9, text: 'triage', trigger: 'triage' },
      { line: 13, text: './prompts/triage/prompt.md', file: 'prompts/triage/prompt.md' },
      { line: 15, text: 'review', trigger: 'review' },
    ]);
  });

  it('keeps every line as written', () => {
    const segments = configLineSegments(CONFIG, new Set(['triage']), new Set(['prompts/triage/prompt.md']));

    expect(segments.map(line => line.map(segment => segment.text).join(''))).toEqual(CONFIG.split('\n'));
  });

  it('links a quoted trigger key', () => {
    const segments = configLineSegments(
      `triggers:\n  "triage":\n  'review':`,
      new Set(['triage', 'review']),
      new Set()
    );

    expect(linked(segments)).toEqual([
      { line: 2, text: '"triage"', trigger: 'triage' },
      { line: 3, text: "'review'", trigger: 'review' },
    ]);
  });

  it('reads a file with CRLF line endings', () => {
    const segments = configLineSegments(
      'triggers:\r\n  triage:\r\n    prompt: ./prompts/triage.md\r\n',
      new Set(['triage']),
      new Set(['prompts/triage.md'])
    );

    expect(linked(segments)).toEqual([
      { line: 2, text: 'triage', trigger: 'triage' },
      { line: 3, text: './prompts/triage.md', file: 'prompts/triage.md' },
    ]);
  });

  it('links no key that is not a trigger of the running config', () => {
    expect(linked(configLineSegments(CONFIG, new Set(['removed']), new Set()))).toEqual([]);
  });
});

describe('configFilePath', () => {
  it('names the file in the query', () => {
    expect(configFilePath('prompts/a b.md')).toBe('/config?file=prompts%2Fa%20b.md');
  });
});
