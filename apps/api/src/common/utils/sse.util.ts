import { MessageEvent } from '@nestjs/common';
import { Observable, defer, endWith, interval, map, merge, takeWhile } from 'rxjs';

import type { IHeartbeatOptions } from '../types/sse.types';

/** A stream can sit still for hours, and a quiet connection is one an intermediary will close. */
const HEARTBEAT_MS = 5000;

/**
 * Nest omits the data line for an empty string, and a browser's event-stream parser never
 * dispatches an event whose data buffer is empty, so a beat without this is silently discarded.
 */
const HEARTBEAT_DATA = 'beat';

/** Marks the payloads' completion inside the merge, and is never sent. */
const PAYLOADS_ENDED: MessageEvent = { data: HEARTBEAT_DATA };

/**
 * Every `@Sse()` route belongs behind this. A client watchdog remakes a connection that has gone
 * silent, so a stream that never beat would be torn down and reconnected for as long as it ran.
 */
export const withHeartbeat = (
  messages: Observable<MessageEvent>,
  options: IHeartbeatOptions = {}
): Observable<MessageEvent> =>
  defer(() => {
    let lastEventId = options.lastEventId;

    const withId = (message: MessageEvent): MessageEvent => {
      if (message.id !== undefined) {
        lastEventId = message.id;

        return message;
      }

      return lastEventId === undefined ? message : { ...message, id: lastEventId };
    };

    const sent = messages.pipe(map(withId));
    const beats = interval(HEARTBEAT_MS).pipe(map(() => withId({ type: 'heartbeat', data: HEARTBEAT_DATA })));

    if (options.endWithPayloads !== true) {
      return merge(sent, beats);
    }

    return merge(sent.pipe(endWith(PAYLOADS_ENDED)), beats).pipe(takeWhile(message => message !== PAYLOADS_ENDED));
  });
