import { TranscriptEventType, type TranscriptEventDto } from '@libs/dto';

import type { TagType } from '@/components/ui';

import { formatDayTime, formatDuration } from './format/date';
import { formatUsd } from './format/number';

export const TRANSCRIPT_EVENT_LABELS: Record<TranscriptEventType, string> = {
  [TranscriptEventType.SYSTEM_INIT]: 'Session start',
  [TranscriptEventType.ASSISTANT_TEXT]: 'Assistant',
  [TranscriptEventType.TOOL_CALL]: 'Tool call',
  [TranscriptEventType.TOOL_RESULT]: 'Tool result',
  [TranscriptEventType.RATE_LIMIT]: 'Rate limit',
  [TranscriptEventType.RESULT]: 'Final result',
  [TranscriptEventType.UNKNOWN]: 'Other',
};

/** A tool result or a final result that errored. */
export const eventErrored = (event: TranscriptEventDto): boolean =>
  (event.type === TranscriptEventType.TOOL_RESULT || event.type === TranscriptEventType.RESULT) && event.isError;

export const eventLabel = (event: TranscriptEventDto): string =>
  event.type === TranscriptEventType.TOOL_RESULT && event.isError ? 'Tool error' : TRANSCRIPT_EVENT_LABELS[event.type];

export const eventTagType = (event: TranscriptEventDto): TagType => {
  if (eventErrored(event)) {
    return 'error';
  }

  if (event.type === TranscriptEventType.RATE_LIMIT) {
    return 'warning';
  }

  return event.type === TranscriptEventType.RESULT ? 'success' : 'default';
};

// The fields that name what a built-in tool acts on, in the order they are looked for.
const TOOL_INPUT_SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'];

/** What a tool call acts on, such as a command or a path. Null when no known field holds text. */
export const toolInputSummary = (input: Record<string, unknown>): string | null => {
  for (const key of TOOL_INPUT_SUMMARY_KEYS) {
    const value = input[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }

  return null;
};

const firstLine = (text: string): string => text.trimStart().split('\n', 1)[0];

const joinParts = (parts: (string | null)[]): string => parts.filter(part => part !== null).join(' · ');

export interface IEventSummary {
  text: string;
  mono: boolean;
}

export const eventSummary = (event: TranscriptEventDto): IEventSummary => {
  switch (event.type) {
    case TranscriptEventType.SYSTEM_INIT:
      return {
        text: joinParts([event.model, `${event.tools.length} tools`, event.permissionMode]),
        mono: false,
      };
    case TranscriptEventType.ASSISTANT_TEXT:
      return { text: event.text, mono: false };
    case TranscriptEventType.TOOL_CALL:
      return { text: toolInputSummary(event.input) ?? firstLine(JSON.stringify(event.input)), mono: true };
    case TranscriptEventType.TOOL_RESULT:
      return { text: firstLine(event.content), mono: true };
    case TranscriptEventType.RATE_LIMIT:
      if (event.retryDelayMs !== null) {
        return { text: `Retrying in ${formatDuration(event.retryDelayMs)}`, mono: false };
      }

      return {
        text: joinParts([
          event.status,
          event.resetsAt === null ? null : `resets ${formatDayTime(new Date(event.resetsAt * 1000))}`,
        ]),
        mono: false,
      };
    case TranscriptEventType.RESULT:
      return {
        text:
          event.text ??
          joinParts([
            event.subtype,
            event.turns === null ? null : `${event.turns} turns`,
            event.costUsd === null ? null : formatUsd(event.costUsd),
          ]),
        mono: false,
      };
    case TranscriptEventType.UNKNOWN:
      return { text: firstLine(event.raw), mono: true };
  }
};

export interface IEventDetail {
  prose: string | null;
  fields: [string, string][];
  block: string | null;
}

const orDash = (value: string | number | null): string => (value === null ? '-' : String(value));

export const eventDetail = (event: TranscriptEventDto): IEventDetail => {
  const detail: IEventDetail = { prose: null, fields: [], block: null };

  switch (event.type) {
    case TranscriptEventType.SYSTEM_INIT:
      return {
        ...detail,
        fields: [
          ['model', orDash(event.model)],
          ['cwd', orDash(event.cwd)],
          ['permissionMode', orDash(event.permissionMode)],
          ['tools', event.tools.join(', ')],
          ['session_id', orDash(event.sessionId)],
        ],
      };
    case TranscriptEventType.ASSISTANT_TEXT:
      return { ...detail, prose: event.text };
    case TranscriptEventType.TOOL_CALL:
      return {
        ...detail,
        fields: Object.entries(event.input).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        ]),
      };
    case TranscriptEventType.TOOL_RESULT:
      return { ...detail, block: event.content === '' ? null : event.content };
    case TranscriptEventType.RATE_LIMIT:
      return {
        ...detail,
        fields: [
          ['status', orDash(event.status)],
          ['resets_at', event.resetsAt === null ? '-' : formatDayTime(new Date(event.resetsAt * 1000))],
          ['retry_delay_ms', orDash(event.retryDelayMs)],
        ],
      };
    case TranscriptEventType.RESULT:
      return {
        ...detail,
        prose: event.text,
        fields: [
          ['subtype', event.subtype],
          ['num_turns', orDash(event.turns)],
          ['duration_ms', orDash(event.durationMs)],
          ['total_cost_usd', event.costUsd === null ? '-' : event.costUsd.toFixed(4)],
        ],
      };
    case TranscriptEventType.UNKNOWN:
      return { ...detail, block: event.raw };
  }
};

export const hasDetail = (detail: IEventDetail): boolean =>
  detail.prose !== null || detail.fields.length > 0 || detail.block !== null;

/** The subagent a tool call started, named by its `subagent_type` when it has one. */
export const subagentName = (input: Record<string, unknown> | undefined): string => {
  const type = input?.subagent_type;

  return typeof type === 'string' && type.trim() !== '' ? type : 'Subagent';
};
