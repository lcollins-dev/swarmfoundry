import type { z } from 'zod';

import { TranscriptEventType } from '@libs/dto';

import {
  apiRetryLineSchema,
  messageLineSchema,
  rateLimitLineSchema,
  resultLineSchema,
  systemInitLineSchema,
  textBlockSchema,
  toolResultBlockSchema,
  toolUseBlockSchema,
} from '../schema/stream-json';
import type { ParsedTranscriptEvent, TranscriptEventBody } from '../types/transcript.types';

const RATE_LIMIT_STATUS = 429;

/** One event per content block of a message line, and one for any other line. Never throws. */
export function parseTranscriptLine(line: string): ParsedTranscriptEvent[] {
  const json = parseJson(line);
  const event = parseLineEvent(json);

  if (event !== null) {
    return [{ ...event, parentToolUseId: null }];
  }

  const message = messageLineSchema.safeParse(json);

  if (!message.success || message.data.message.content.length === 0) {
    return [{ ...unknownEvent(line), parentToolUseId: null }];
  }

  const parentToolUseId = message.data.parent_tool_use_id ?? null;
  const parseBlock = message.data.type === 'assistant' ? parseAssistantBlock : parseUserBlock;

  return message.data.message.content.map(block => ({ ...parseBlock(block), parentToolUseId }));
}

/** Whether the event's own text holds `query`, in any case. JSON keys, a block's `type` and escapes never match. */
export function eventMatches(event: TranscriptEventBody, query: string): boolean {
  const needle = query.toLowerCase();

  return eventTexts(event).some(text => text.toLowerCase().includes(needle));
}

function eventTexts(event: TranscriptEventBody): string[] {
  switch (event.type) {
    case TranscriptEventType.SYSTEM_INIT:
      return [event.sessionId, event.model, event.cwd, event.permissionMode, ...event.tools].filter(
        text => text !== null
      );
    case TranscriptEventType.ASSISTANT_TEXT:
      return [event.text];
    case TranscriptEventType.TOOL_CALL:
      return [event.name, ...stringsOf(event.input)];
    case TranscriptEventType.TOOL_RESULT:
      return [event.content];
    case TranscriptEventType.RATE_LIMIT:
      return event.status === null ? [] : [event.status];
    case TranscriptEventType.RESULT:
      return event.text === null ? [event.subtype] : [event.subtype, event.text];
    case TranscriptEventType.UNKNOWN:
      return unknownTexts(event.raw);
  }
}

/** An unknown line or block's string values, its keys and `type` left out, or the text itself when it is not JSON. */
function unknownTexts(raw: string): string[] {
  const json = parseJson(raw);

  if (typeof json !== 'object' || json === null) {
    return [raw];
  }

  return Object.entries(json).flatMap(([key, value]) => (key === 'type' ? [] : stringsOf(value)));
}

/** Every string a JSON value holds, its object keys left out. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => stringsOf(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(item => stringsOf(item));
  }

  return [];
}

function parseLineEvent(json: unknown): TranscriptEventBody | null {
  const init = systemInitLineSchema.safeParse(json);

  if (init.success) {
    return {
      type: TranscriptEventType.SYSTEM_INIT,
      sessionId: init.data.session_id ?? null,
      model: init.data.model ?? null,
      cwd: init.data.cwd ?? null,
      tools: init.data.tools ?? [],
      permissionMode: init.data.permissionMode ?? null,
    };
  }

  const retry = apiRetryLineSchema.safeParse(json);

  if (retry.success && retry.data.error_status === RATE_LIMIT_STATUS) {
    return {
      type: TranscriptEventType.RATE_LIMIT,
      status: null,
      resetsAt: null,
      retryDelayMs: retry.data.retry_delay_ms ?? null,
    };
  }

  const rateLimit = rateLimitLineSchema.safeParse(json);

  if (rateLimit.success) {
    return {
      type: TranscriptEventType.RATE_LIMIT,
      status: rateLimit.data.rate_limit_info?.status ?? null,
      resetsAt: rateLimit.data.rate_limit_info?.resetsAt ?? null,
      retryDelayMs: null,
    };
  }

  const result = resultLineSchema.safeParse(json);

  if (result.success) {
    return {
      type: TranscriptEventType.RESULT,
      subtype: result.data.subtype,
      isError: result.data.is_error ?? false,
      text: result.data.result ?? null,
      turns: result.data.num_turns ?? null,
      durationMs: result.data.duration_ms ?? null,
      costUsd: result.data.total_cost_usd ?? null,
    };
  }

  return null;
}

function parseAssistantBlock(block: unknown): TranscriptEventBody {
  const text = textBlockSchema.safeParse(block);

  if (text.success) {
    return { type: TranscriptEventType.ASSISTANT_TEXT, text: text.data.text };
  }

  const toolUse = toolUseBlockSchema.safeParse(block);

  if (toolUse.success) {
    const { id, name, input } = toolUse.data;

    return { type: TranscriptEventType.TOOL_CALL, toolUseId: id, name, input };
  }

  return unknownEvent(JSON.stringify(block));
}

function parseUserBlock(block: unknown): TranscriptEventBody {
  const toolResult = toolResultBlockSchema.safeParse(block);

  if (!toolResult.success) {
    return unknownEvent(JSON.stringify(block));
  }

  const { tool_use_id: toolUseId, content, is_error: isError } = toolResult.data;

  return { type: TranscriptEventType.TOOL_RESULT, toolUseId, content: contentText(content), isError: isError ?? false };
}

function contentText(content: z.output<typeof toolResultBlockSchema>['content']): string {
  if (content === undefined || typeof content === 'string') {
    return content ?? '';
  }

  const texts: string[] = [];

  for (const part of content) {
    const text = textBlockSchema.safeParse(part);

    if (!text.success) {
      return JSON.stringify(content);
    }

    texts.push(text.data.text);
  }

  return texts.join('\n');
}

function unknownEvent(raw: string): TranscriptEventBody {
  return { type: TranscriptEventType.UNKNOWN, raw };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
