import { describe, expect, it } from 'vitest';

import { TranscriptEventType, type TranscriptEventDto } from '@libs/dto';

import {
  eventDetail,
  eventLabel,
  eventSummary,
  eventTagType,
  hasDetail,
  subagentName,
  toolInputSummary,
} from './transcript';

const EVENT_BASE = { lineNumber: 1, index: 0, storedDate: new Date('2026-10-25T09:03:00Z'), parentToolUseId: null };

const toolResult = (isError: boolean, content = 'output'): TranscriptEventDto => ({
  ...EVENT_BASE,
  type: TranscriptEventType.TOOL_RESULT,
  toolUseId: 'toolu_1',
  content,
  isError,
});

describe('eventLabel and eventTagType', () => {
  it('marks a tool result that errored', () => {
    expect(eventLabel(toolResult(true))).toBe('Tool error');
    expect(eventTagType(toolResult(true))).toBe('error');

    expect(eventLabel(toolResult(false))).toBe('Tool result');
    expect(eventTagType(toolResult(false))).toBe('default');
  });

  it('marks a final result that errored', () => {
    const result: TranscriptEventDto = {
      ...EVENT_BASE,
      type: TranscriptEventType.RESULT,
      subtype: 'error_max_turns',
      isError: true,
      text: null,
      turns: 40,
      durationMs: null,
      costUsd: null,
    };

    expect(eventLabel(result)).toBe('Final result');
    expect(eventTagType(result)).toBe('error');
    expect(eventTagType({ ...result, isError: false })).toBe('success');
  });
});

describe('eventSummary', () => {
  it("sums up a session's start by its model, tool count and permission mode", () => {
    const summary = eventSummary({
      ...EVENT_BASE,
      type: TranscriptEventType.SYSTEM_INIT,
      sessionId: 'session-1',
      model: 'claude-opus',
      cwd: '/workspace',
      tools: ['Bash', 'Read'],
      permissionMode: 'default',
    });

    expect(summary).toEqual({ text: 'claude-opus · 2 tools · default', mono: false });
  });

  it("sums up a tool result by its output's first line, in mono", () => {
    expect(eventSummary(toolResult(false, '\nfirst\nsecond'))).toEqual({ text: 'first', mono: true });
  });
});

describe('eventDetail', () => {
  it('opens a final result on its text and its figures', () => {
    const detail = eventDetail({
      ...EVENT_BASE,
      type: TranscriptEventType.RESULT,
      subtype: 'success',
      isError: false,
      text: 'Done.',
      turns: 12,
      durationMs: 6000,
      costUsd: 0.5,
    });

    expect(detail).toEqual({
      prose: 'Done.',
      fields: [
        ['subtype', 'success'],
        ['num_turns', '12'],
        ['duration_ms', '6000'],
        ['total_cost_usd', '0.5000'],
      ],
      block: null,
    });
  });

  it('has nothing to open for a tool result with no output', () => {
    expect(hasDetail(eventDetail(toolResult(false, '')))).toBe(false);
    expect(hasDetail(eventDetail(toolResult(false)))).toBe(true);
  });
});

describe('subagentName', () => {
  it("names a subagent by its call's subagent type, or generically", () => {
    expect(subagentName(Object.fromEntries([['subagent_type', 'Explore']]))).toBe('Explore');
    expect(subagentName({ prompt: 'Find it' })).toBe('Subagent');
    expect(subagentName(undefined)).toBe('Subagent');
  });
});

describe('toolInputSummary', () => {
  it('reads the first field that names what the tool acts on', () => {
    expect(toolInputSummary({ description: 'Run the tests', command: 'npm test' })).toBe('npm test');
    expect(toolInputSummary({ pattern: 'TranscriptEvent', path: 'src' })).toBe('src');
  });

  it('is null with no such field', () => {
    expect(toolInputSummary({ todos: [] })).toBeNull();
    expect(toolInputSummary({ command: ' ' })).toBeNull();
  });
});
