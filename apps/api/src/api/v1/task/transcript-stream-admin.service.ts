import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { Observable, type Subscriber } from 'rxjs';

import type { TranscriptEventType, TranscriptStreamMessageDto } from '@libs/dto';

import { TRANSCRIPT_PAGE_EVENTS, TRANSCRIPT_PAGE_LINES } from './task-admin.service';
import { TaskReadService } from '@/core/task/task-read.service';

import type { TranscriptEvent } from '@/core/task/types/transcript.types';

export const TRANSCRIPT_POLL_MS = 1000;

const END_MESSAGE: TranscriptStreamMessageDto = { type: 'end' };

/** The guard checks a stream only when it opens, so each one ends after this and the client reconnects through it. */
export const TRANSCRIPT_STREAM_MAX_MS = 5 * 60 * 1000;

export interface ITranscriptFollow {
  runId: number;
  /** The last line the client holds. */
  afterLine: number;
  /** Every type when undefined. */
  types: readonly TranscriptEventType[] | undefined;
}

@Injectable()
export class TranscriptStreamAdminService {
  private readonly logger = new Logger(TranscriptStreamAdminService.name);

  constructor(private readonly taskReadService: TaskReadService) {}

  /**
   * Each stored line after `afterLine` with its kept events, then each line as the runner stores it, until the run is
   * judged or the stream reaches its age. Refuses a missing run before the stream opens.
   */
  async followTranscript(follow: ITranscriptFollow): Promise<Observable<MessageEvent>> {
    await this.taskReadService.findRunWithThrow(follow.runId);

    return new Observable<MessageEvent>(subscriber => {
      let cursor = follow.afterLine;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;

      const poll = () => {
        this.sendNewLines(follow, cursor, subscriber)
          .then(({ lastLine, ended }) => {
            cursor = lastLine;

            if (subscriber.closed) {
              return;
            }

            if (ended) {
              subscriber.next({ data: END_MESSAGE });
              subscriber.complete();

              return;
            }

            pollTimer = setTimeout(poll, TRANSCRIPT_POLL_MS);
          })
          .catch((error: unknown) => {
            this.logger.error({ error, runId: follow.runId }, 'followTranscript(): Failed to read new lines');

            // Nest would send the error's message to the client, so end quietly and let it reconnect.
            subscriber.complete();
          });
      };

      const ageTimer = setTimeout(() => subscriber.complete(), TRANSCRIPT_STREAM_MAX_MS);

      poll();

      return () => {
        clearTimeout(ageTimer);

        if (pollTimer !== null) {
          clearTimeout(pollTimer);
        }
      };
    });
  }

  private async sendNewLines(
    follow: ITranscriptFollow,
    afterLine: number,
    subscriber: Subscriber<MessageEvent>
  ): Promise<{ lastLine: number; ended: boolean }> {
    // Read before the lines: the runner stores every line before the run is judged, so a judged run has none left.
    const run = await this.taskReadService.findRunWithThrow(follow.runId);
    const ended = run.outcome !== null;

    let lastLine = afterLine;
    let hasMore = true;

    while (hasMore && !subscriber.closed) {
      const page = await this.taskReadService.readTranscript(follow.runId, {
        fromLine: lastLine + 1,
        types: follow.types,
        eventLimit: TRANSCRIPT_PAGE_EVENTS,
        lineLimit: TRANSCRIPT_PAGE_LINES,
      });

      for (const [lineNumber, events] of groupByLine(page.events)) {
        subscriber.next(lineMessage(lineNumber, events));
      }

      lastLine = page.nextLine - 1;
      hasMore = page.hasMore;
    }

    return { lastLine, ended };
  }
}

const lineMessage = (lineNumber: number, events: TranscriptEvent[]): MessageEvent => {
  const data: TranscriptStreamMessageDto = { type: 'line', lineNumber, events };

  return { id: String(lineNumber), data };
};

function groupByLine(events: readonly TranscriptEvent[]): Map<number, TranscriptEvent[]> {
  const lines = new Map<number, TranscriptEvent[]>();

  for (const event of events) {
    lines.set(event.lineNumber, [...(lines.get(event.lineNumber) ?? []), event]);
  }

  return lines;
}
