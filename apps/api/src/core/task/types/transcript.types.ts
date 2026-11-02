import type { TranscriptEventType } from '@libs/dto';

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

/** Covers the lines from `firstLine` up to `nextLine`, with the events of each that the filter keeps. */
export interface ITranscriptPage {
  events: TranscriptEvent[];
  firstLine: number;
  hasEarlier: boolean;
  nextLine: number;
  hasMore: boolean;
}
