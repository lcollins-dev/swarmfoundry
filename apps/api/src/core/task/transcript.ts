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
} from './schema/stream-json';

const RATE_LIMIT_STATUS = 429;

export type TranscriptEventBody =
  | {
      type: TranscriptEventType.SYSTEM_INIT;
      sessionId: string | null;
      model: string | null;
      cwd: string | null;
      tools: string[];
      permissionMode: string | null;
    }
  | { type: TranscriptEventType.ASSISTANT_TEXT; text: string }
  | { type: TranscriptEventType.TOOL_CALL; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: TranscriptEventType.TOOL_RESULT; toolUseId: string; content: string; isError: boolean }
  | {
      type: TranscriptEventType.RATE_LIMIT;
      status: string | null;
      resetsAt: number | null;
      retryDelayMs: number | null;
    }
  | {
      type: TranscriptEventType.RESULT;
      subtype: string;
      isError: boolean;
      text: string | null;
      turns: number | null;
      durationMs: number | null;
      costUsd: number | null;
    }
  | { type: TranscriptEventType.UNKNOWN; raw: string };

/** Null `parentToolUseId` for the main agent's event. */
export type ParsedTranscriptEvent = TranscriptEventBody & { parentToolUseId: string | null };

export type TranscriptEvent = ParsedTranscriptEvent & { lineNumber: number; index: number; storedDate: Date };

export interface ITranscriptPage {
  events: TranscriptEvent[];
  nextLine: number;
  hasMore: boolean;
}

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
