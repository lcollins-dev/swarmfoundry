import { TranscriptEventType } from '@libs/dto';

import type { TranscriptEventBody } from '@/core/task/types/transcript.types';

/** A page's events keep this much of each long field, so a page of tool output fits an agent's context. */
export const PAGE_FIELD_CHARS = 2000;

export const EVENT_FIELD_CHARS = 40_000;

/** A clipped field starts this far before the first match, so the match shows with what led up to it. */
const MATCH_LEAD_CHARS = 200;

export interface IClip {
  offset: number;
  maxChars: number;
  /** Starts each field's window just before its first match, when the match falls outside the window from `offset`. */
  query?: string;
}

/** A cut field: the characters from `from` up to `to` of its `length`. */
export interface ITruncation {
  field: string;
  from: number;
  to: number;
  length: number;
}

/**
 * The event with each long field cut to its window. The fields hold only transcript text; `truncated` lists each cut
 * with where its window sits, so a reader goes on with `get_event` from `to`.
 */
export function clipEvent<Event extends TranscriptEventBody>(
  event: Event,
  clip: IClip
): Event & { truncated?: ITruncation[] } {
  const truncated: ITruncation[] = [];

  const clipField = (field: string, text: string): string => {
    const from = Math.min(windowStart(text, clip), text.length);
    const to = Math.min(from + clip.maxChars, text.length);

    if (from > 0 || to < text.length) {
      truncated.push({ field, from, to, length: text.length });
    }

    return text.slice(from, to);
  };

  const result = clipFields(event, clipField);

  return truncated.length > 0 ? { ...result, truncated } : result;
}

function clipFields<Event extends TranscriptEventBody>(
  event: Event,
  clipField: (field: string, text: string) => string
): Event {
  switch (event.type) {
    case TranscriptEventType.ASSISTANT_TEXT:
      return { ...event, text: clipField('text', event.text) };
    case TranscriptEventType.TOOL_CALL:
      return { ...event, input: mapStrings(event.input, 'input', clipField) };
    case TranscriptEventType.TOOL_RESULT:
      return { ...event, content: clipField('content', event.content) };
    case TranscriptEventType.RESULT:
      return { ...event, text: event.text === null ? null : clipField('text', event.text) };
    case TranscriptEventType.UNKNOWN:
      return { ...event, raw: clipField('raw', event.raw) };
    default:
      return event;
  }
}

function windowStart(text: string, { offset, maxChars, query }: IClip): number {
  if (query === undefined) {
    return offset;
  }

  const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());

  return matchIndex === -1 || matchIndex + query.length <= offset + maxChars
    ? offset
    : Math.max(0, matchIndex - MATCH_LEAD_CHARS);
}

function mapStrings<Value>(value: Value, path: string, map: (field: string, text: string) => string): Value;
function mapStrings(value: unknown, path: string, map: (field: string, text: string) => string): unknown {
  if (typeof value === 'string') {
    return map(path, value);
  }

  if (Array.isArray(value)) {
    const items: unknown[] = value;

    return items.map((item, index) => mapStrings(item, `${path}.${index}`, map));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, `${path}.${key}`, map)])
    );
  }

  return value;
}
