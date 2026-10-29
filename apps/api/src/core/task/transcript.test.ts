import { describe, expect, it } from 'vitest';

import { TranscriptEventType } from '@libs/dto';

import { parseTranscriptLine } from './transcript';

const line = (event: Record<string, unknown>): string => JSON.stringify(event);

describe('parseTranscriptLine', () => {
  it('reads system init', () => {
    const events = parseTranscriptLine(
      line({
        type: 'system',
        subtype: 'init',
        session_id: 'session-1',
        model: 'claude-opus-5-5',
        cwd: '/workspace',
        tools: ['Bash', 'Read'],
        permissionMode: 'bypassPermissions',
        plugins: [],
      })
    );

    expect(events).toEqual([
      {
        type: TranscriptEventType.SYSTEM_INIT,
        sessionId: 'session-1',
        model: 'claude-opus-5-5',
        cwd: '/workspace',
        tools: ['Bash', 'Read'],
        permissionMode: 'bypassPermissions',
        parentToolUseId: null,
      },
    ]);
  });

  it('reads a malformed init field as absent rather than failing the line', () => {
    const [event] = parseTranscriptLine(line({ type: 'system', subtype: 'init', model: 7, tools: 'Bash' }));

    expect(event).toMatchObject({ type: TranscriptEventType.SYSTEM_INIT, model: null, tools: [] });
  });

  it('reads each block of an assistant line in order, marking a subagent', () => {
    const events = parseTranscriptLine(
      line({
        type: 'assistant',
        parent_tool_use_id: 'toolu_task',
        message: {
          content: [
            { type: 'text', text: 'Running the tests.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      })
    );

    expect(events).toEqual([
      { type: TranscriptEventType.ASSISTANT_TEXT, text: 'Running the tests.', parentToolUseId: 'toolu_task' },
      {
        type: TranscriptEventType.TOOL_CALL,
        toolUseId: 'toolu_1',
        name: 'Bash',
        input: { command: 'npm test' },
        parentToolUseId: 'toolu_task',
      },
    ]);
  });

  it("reads a main agent's line, with a null or no parent, as the main agent's", () => {
    const content = [{ type: 'text', text: 'Hi' }];

    expect(parseTranscriptLine(line({ type: 'assistant', parent_tool_use_id: null, message: { content } }))).toEqual([
      { type: TranscriptEventType.ASSISTANT_TEXT, text: 'Hi', parentToolUseId: null },
    ]);
    expect(parseTranscriptLine(line({ type: 'assistant', message: { content } }))[0].parentToolUseId).toBeNull();
  });

  it('keeps a block of another kind, such as thinking, as an unknown event in its place', () => {
    const thinking = { type: 'thinking', thinking: 'Hmm', signature: 'sig' };

    const events = parseTranscriptLine(
      line({ type: 'assistant', message: { content: [thinking, { type: 'text', text: 'Done' }] } })
    );

    expect(events).toEqual([
      { type: TranscriptEventType.UNKNOWN, raw: JSON.stringify(thinking), parentToolUseId: null },
      { type: TranscriptEventType.ASSISTANT_TEXT, text: 'Done', parentToolUseId: null },
    ]);
  });

  it('reads a tool result, marked when it errored', () => {
    const events = parseTranscriptLine(
      line({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Tests: 1 failed', is_error: true },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' },
          ],
        },
      })
    );

    expect(events).toEqual([
      {
        type: TranscriptEventType.TOOL_RESULT,
        toolUseId: 'toolu_1',
        content: 'Tests: 1 failed',
        isError: true,
        parentToolUseId: null,
      },
      {
        type: TranscriptEventType.TOOL_RESULT,
        toolUseId: 'toolu_2',
        content: 'ok',
        isError: false,
        parentToolUseId: null,
      },
    ]);
  });

  it('joins the text parts of a tool result', () => {
    const [event] = parseTranscriptLine(
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'text', text: 'one' },
                { type: 'text', text: 'two' },
              ],
            },
          ],
        },
      })
    );

    expect(event).toMatchObject({ type: TranscriptEventType.TOOL_RESULT, content: 'one\ntwo' });
  });

  it('keeps a tool result holding another part, such as an image, as JSON', () => {
    const content = [
      { type: 'text', text: 'Screenshot' },
      { type: 'image', source: { type: 'base64', data: 'AAAA' } },
    ];

    const [event] = parseTranscriptLine(
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] } })
    );

    expect(event).toMatchObject({ type: TranscriptEventType.TOOL_RESULT, content: JSON.stringify(content) });
  });

  it('reads a rate limit event', () => {
    const events = parseTranscriptLine(
      line({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', resetsAt: 1793000000, rateLimitType: 'five_hour' },
      })
    );

    expect(events).toEqual([
      {
        type: TranscriptEventType.RATE_LIMIT,
        status: 'allowed_warning',
        resetsAt: 1793000000,
        retryDelayMs: null,
        parentToolUseId: null,
      },
    ]);
  });

  it('reads a retry after a 429 as a rate limit, and a retry after another error as unknown', () => {
    const rateLimited = line({ type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 42000 });
    const overloaded = line({ type: 'system', subtype: 'api_retry', error_status: 529, retry_delay_ms: 1000 });

    expect(parseTranscriptLine(rateLimited)).toEqual([
      {
        type: TranscriptEventType.RATE_LIMIT,
        status: null,
        resetsAt: null,
        retryDelayMs: 42000,
        parentToolUseId: null,
      },
    ]);
    expect(parseTranscriptLine(overloaded)).toEqual([
      { type: TranscriptEventType.UNKNOWN, raw: overloaded, parentToolUseId: null },
    ]);
  });

  it('reads the final result', () => {
    const events = parseTranscriptLine(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Opened !124',
        num_turns: 41,
        duration_ms: 1460000,
        total_cost_usd: 3.21,
      })
    );

    expect(events).toEqual([
      {
        type: TranscriptEventType.RESULT,
        subtype: 'success',
        isError: false,
        text: 'Opened !124',
        turns: 41,
        durationMs: 1460000,
        costUsd: 3.21,
        parentToolUseId: null,
      },
    ]);
  });

  it('reads an error result without text', () => {
    const [event] = parseTranscriptLine(line({ type: 'result', subtype: 'error_max_turns', is_error: true }));

    expect(event).toMatchObject({ type: TranscriptEventType.RESULT, isError: true, text: null, turns: null });
  });

  it.each([
    ['text that is not JSON', 'Claude started'],
    ['a piece of an over-long line', '{"type":"assistant","message":{"content":[{"type":"text","text":"abc'],
    ['a line of another type', line({ type: 'stream_event', event: { type: 'content_block_delta' } })],
    ['a user line with a string prompt', line({ type: 'user', message: { content: 'Implement it' } })],
    ['an assistant line with no blocks', line({ type: 'assistant', message: { content: [] } })],
    ['JSON that is not an object', '42'],
  ])('keeps %s as one unknown event holding the line', (_name, raw) => {
    expect(parseTranscriptLine(raw)).toEqual([{ type: TranscriptEventType.UNKNOWN, raw, parentToolUseId: null }]);
  });
});
