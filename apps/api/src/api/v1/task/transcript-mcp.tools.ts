import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TranscriptDirection, TranscriptEventType } from '@libs/dto';

import { McpTools } from '@/api/mcp/decorators/mcp-tools.decorator';

import { TaskAdminService, TRANSCRIPT_PAGE_EVENTS, TRANSCRIPT_PAGE_LINES } from './task-admin.service';
import {
  DATE_RANGE_MAX_DAYS,
  TranscriptSearchService,
  type ITranscriptSearchCursor,
} from '@/core/task/transcript-search.service';

import { toRunDto } from './utils/run.util';
import { clipEvent, EVENT_FIELD_CHARS, PAGE_FIELD_CHARS } from './utils/transcript-clip.util';
import { MCP_FILTER_MAX_LENGTH, MCP_ID_MAX, mcpDate, mcpId } from '@/api/mcp/schema/tool-fields';
import type { IMcpToolProvider } from '@/api/mcp/types/mcp.types';
import { registerReadTool } from '@/api/mcp/utils/read-tool.util';

export const EVENT_MISSING_MESSAGE = "This event doesn't exist. Check its run, line number and index.";

/** Most clients cap a tool's answer at a few tens of thousands of tokens, which a full page of tool output passes. */
const DEFAULT_EVENT_LIMIT = 50;

const QUERY_MIN_LENGTH = 2;
const CURSOR_PATTERN = /^(\d+):(\d+)(?::(\d+))?$/;
const SEARCH_CONTEXT_MAX = 5;

const PAGE_CLIP = { offset: 0, maxChars: PAGE_FIELD_CHARS };

const eventTypes = () =>
  z
    .array(z.enum(TranscriptEventType))
    .min(1)
    .optional()
    .describe('Keeps only these event types. Every type when absent.');

const eventLimit = () =>
  z
    .int()
    .min(1)
    .max(TRANSCRIPT_PAGE_EVENTS)
    .default(DEFAULT_EVENT_LIMIT)
    .describe("The most events to return. A page holds whole lines, so it may run a line's events over.");

@Injectable()
@McpTools()
export class TranscriptMcpTools implements IMcpToolProvider {
  constructor(
    private readonly taskAdminService: TaskAdminService,
    private readonly transcriptSearchService: TranscriptSearchService
  ) {}

  register(server: McpServer): void {
    this.registerGetTranscript(server);
    this.registerGetEvent(server);
    this.registerSearchTranscripts(server);
  }

  private registerGetTranscript(server: McpServer): void {
    registerReadTool(
      server,
      'get_transcript',
      {
        title: 'Get a transcript page',
        description:
          "Returns a page of a run's transcript as parsed events, keyed by line number and index. Reads forward " +
          'from `fromLine`, or backward before `beforeLine` or from the end. Go on with `fromLine: nextLine` while ' +
          '`hasMore`, or `beforeLine: firstLine` while `hasEarlier`. Filter by type to skim, such as toolCall and ' +
          `result. Each long text field is cut to ${PAGE_FIELD_CHARS} characters; the event's \`truncated\` lists ` +
          'each cut field with the characters it holds (`from`, `to`) and its full `length`. Read on with get_event ' +
          'from `to`.',
        inputSchema: {
          runId: mcpId(),
          direction: z.enum(TranscriptDirection).default(TranscriptDirection.FORWARD),
          fromLine: mcpId().optional().describe('Reading forward, the first line. The first line stored when absent.'),
          beforeLine: mcpId().optional().describe('Reading backward, the line to stop before. The end when absent.'),
          types: eventTypes(),
          limit: eventLimit(),
        },
      },
      async ({ runId, direction, fromLine, beforeLine, types, limit }) => {
        if ((direction === TranscriptDirection.FORWARD ? beforeLine : fromLine) !== undefined) {
          throw new BadRequestException('Give fromLine to read forward, or beforeLine to read backward.');
        }

        const page = await this.taskAdminService.getTranscript(
          runId,
          { direction, fromLine, beforeLine, types },
          limit
        );

        return { ...page, events: page.events.map(event => clipEvent(event, PAGE_CLIP)) };
      }
    );
  }

  private registerGetEvent(server: McpServer): void {
    registerReadTool(
      server,
      'get_event',
      {
        title: 'Get a transcript event',
        description:
          `Returns one transcript event with up to ${EVENT_FIELD_CHARS} characters of each text field, such as a ` +
          'tool result a page cut short. When `truncated` still lists a field, read on with `offset` set to its `to`.',
        inputSchema: {
          runId: mcpId(),
          lineNumber: mcpId(),
          index: z.int().min(0).max(MCP_ID_MAX).default(0).describe("The event's place within its line, from 0."),
          offset: z.int().min(0).max(MCP_ID_MAX).default(0).describe('The character each text field starts from.'),
        },
      },
      async ({ runId, lineNumber, index, offset }) => {
        const page = await this.taskAdminService.getTranscript(
          runId,
          { direction: TranscriptDirection.FORWARD, fromLine: lineNumber },
          1
        );
        const event = page.events.find(candidate => candidate.lineNumber === lineNumber && candidate.index === index);

        if (event === undefined) {
          throw new BadRequestException(EVENT_MISSING_MESSAGE);
        }

        return clipEvent(event, { offset, maxChars: EVENT_FIELD_CHARS });
      }
    );
  }

  private registerSearchTranscripts(server: McpServer): void {
    registerReadTool(
      server,
      'search_transcripts',
      {
        title: 'Search transcripts',
        description:
          'Finds transcript events whose text holds a query, in any case, grouped by run, newest run first. ' +
          'Requires a scope: a run, a task, a trigger, or a date range of runs started within it. A date range ' +
          `alone spans at most ${DATE_RANGE_MAX_DAYS} days. Use \`output: "runs"\` to list only the matching runs ` +
          "with this page's match counts, then search one run for its events; a run marked continuesOnNextPage " +
          'has more matches on the next page. Pass the returned cursor to go on. With context, the events around ' +
          'each match count toward the limit. Long fields are cut around the first match; read one in full with ' +
          'get_event.',
        inputSchema: {
          query: z.string().min(QUERY_MIN_LENGTH).max(MCP_FILTER_MAX_LENGTH),
          runId: mcpId().optional(),
          taskId: mcpId().optional(),
          trigger: z.string().min(1).max(MCP_FILTER_MAX_LENGTH).optional().describe("The trigger's name, exactly."),
          since: mcpDate().optional().describe('Starts the date range, as an ISO 8601 date or date-time.'),
          until: mcpDate().optional().describe('Ends the date range, leaving it out. Now when absent.'),
          types: eventTypes(),
          output: z
            .enum(['events', 'runs'])
            .default('events')
            .describe(
              "events: the matching events. runs: each matching run with this page's match count and no events."
            ),
          context: z
            .int()
            .min(0)
            .max(SEARCH_CONTEXT_MAX)
            .default(0)
            .describe(
              'With events, the lines either side of each match to add, of the types asked for, each event marked match or not. They count toward the limit.'
            ),
          cursor: z
            .string()
            .regex(CURSOR_PATTERN)
            .refine(cursor => cursor.split(':').every(part => Number(part) <= MCP_ID_MAX), {
              error: 'Pass the cursor a previous page returned.',
            })
            .optional()
            .describe('The cursor a previous page returned.'),
          limit: eventLimit().describe(
            'With events, the most events to return, context included. A page holds whole lines or windows, so it ' +
              'may run over. Ignored for runs.'
          ),
        },
      },
      async ({ query, runId, taskId, trigger, since, until, types, output, context, cursor, limit }) => {
        const listRuns = output === 'runs';

        const search = {
          query,
          scope: {
            runId,
            taskId,
            triggerName: trigger,
            since: since === undefined ? undefined : new Date(since),
            until: until === undefined ? undefined : new Date(until),
          },
          types,
          after: cursor === undefined ? null : parseCursor(cursor),
          eventLimit: listRuns ? Number.POSITIVE_INFINITY : limit,
          lineLimit: TRANSCRIPT_PAGE_LINES,
          contextLines: listRuns ? 0 : context,
        };
        const page = await this.transcriptSearchService.search(search);
        const continuingRunId =
          listRuns && page.next !== null && (await this.transcriptSearchService.hasMatchAfter(search, page.next))
            ? page.next.runId
            : null;

        return {
          runs: page.runs.map(({ run, events }) => ({
            run: toRunDto(run),
            triggerName: run.task?.triggerName ?? null,
            projectPath: run.task?.projectPath ?? null,
            ...(listRuns
              ? { matchCount: events.length, continuesOnNextPage: run.id === continuingRunId }
              : {
                  events: events.map(event =>
                    clipEvent(event, { ...PAGE_CLIP, query: event.match ? query : undefined })
                  ),
                }),
          })),
          cursor: page.next === null ? null : formatCursor(page.next),
        };
      }
    );
  }
}

function parseCursor(cursor: string): ITranscriptSearchCursor {
  const parts = cursor.split(':').map(Number);
  const [runId, lineNumber, returnedThrough] = parts;

  return parts.length === 3 ? { runId, lineNumber, returnedThrough } : { runId, lineNumber };
}

function formatCursor({ runId, lineNumber, returnedThrough }: ITranscriptSearchCursor): string {
  return returnedThrough === undefined ? `${runId}:${lineNumber}` : `${runId}:${lineNumber}:${returnedThrough}`;
}
