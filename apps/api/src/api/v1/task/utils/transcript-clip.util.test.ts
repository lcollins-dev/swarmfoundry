import { describe, expect, it } from 'vitest';

import { TranscriptEventType } from '@libs/dto';

import { clipEvent } from './transcript-clip.util';

const result = (content: string) =>
  ({ type: TranscriptEventType.TOOL_RESULT, toolUseId: 't', content, isError: false, parentToolUseId: null }) as const;

describe('clipEvent', () => {
  it('leaves a field that fits alone, unmarked', () => {
    expect(clipEvent(result('short'), { offset: 0, maxChars: 10 })).toEqual(result('short'));
  });

  it('cuts a long field to its window, listing the cut beside it', () => {
    expect(clipEvent(result('abcdefghij'), { offset: 0, maxChars: 4 })).toEqual({
      ...result('abcd'),
      truncated: [{ field: 'content', from: 0, to: 4, length: 10 }],
    });
  });

  it('reads from an offset', () => {
    expect(clipEvent(result('abcdefghij'), { offset: 4, maxChars: 4 })).toMatchObject({
      content: 'efgh',
      truncated: [{ field: 'content', from: 4, to: 8, length: 10 }],
    });
  });

  it('starts the window just before a match that falls outside it', () => {
    const text = `${'x'.repeat(1000)}NEEDLE${'y'.repeat(1000)}`;
    const clipped = clipEvent(result(text), { offset: 0, maxChars: 300, query: 'needle' });

    expect(clipped.content).toContain('NEEDLE');
    expect(clipped.truncated).toEqual([{ field: 'content', from: 800, to: 1100, length: 2006 }]);
  });

  it('keeps the start when the match already shows in it', () => {
    const clipped = clipEvent(result(`ab NEEDLE ${'y'.repeat(100)}`), { offset: 0, maxChars: 20, query: 'needle' });

    expect(clipped.content.startsWith('ab NEEDLE')).toBe(true);
  });

  it("cuts every string in a tool call's input, naming each by its path", () => {
    const call = {
      type: TranscriptEventType.TOOL_CALL,
      toolUseId: 't',
      name: 'Write',
      input: { path: 'a.ts', content: 'abcdefghij', lines: [1, 'abcdefghij'] },
      parentToolUseId: null,
    } as const;

    expect(clipEvent(call, { offset: 0, maxChars: 5 })).toEqual({
      ...call,
      input: { path: 'a.ts', content: 'abcde', lines: [1, 'abcde'] },
      truncated: [
        { field: 'input.content', from: 0, to: 5, length: 10 },
        { field: 'input.lines.1', from: 0, to: 5, length: 10 },
      ],
    });
  });

  it("cuts a final result's text and an unknown event's raw line", () => {
    const final = {
      type: TranscriptEventType.RESULT,
      subtype: 'success',
      isError: false,
      text: 'abcdefghij',
      turns: 3,
      durationMs: 10,
      costUsd: null,
      parentToolUseId: null,
    } as const;
    const unknown = { type: TranscriptEventType.UNKNOWN, raw: 'abcdefghij', parentToolUseId: null } as const;

    expect(clipEvent(final, { offset: 0, maxChars: 3 })).toMatchObject({
      text: 'abc',
      truncated: [{ field: 'text', to: 3 }],
    });
    expect(clipEvent(unknown, { offset: 0, maxChars: 3 })).toMatchObject({
      raw: 'abc',
      truncated: [{ field: 'raw', to: 3 }],
    });
  });
});
