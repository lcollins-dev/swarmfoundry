import { MessageEvent } from '@nestjs/common';
import { Subject, Subscription } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withHeartbeat } from '@/common/utils/sse.util';

describe('withHeartbeat', () => {
  let messages: Subject<MessageEvent>;
  let seen: MessageEvent[];
  let subscription: Subscription;

  beforeEach(() => {
    vi.useFakeTimers();

    messages = new Subject<MessageEvent>();
    seen = [];

    subscription = withHeartbeat(messages).subscribe(event => seen.push(event));
  });

  afterEach(() => {
    subscription.unsubscribe();
    vi.useRealTimers();
  });

  it('passes a message through with its id, so a client can resume after it', () => {
    messages.next({ id: '7', data: { value: 42 } });

    expect(seen).toEqual([{ id: '7', data: { value: 42 } }]);
  });

  it('beats often enough to hold a connection an intermediary would otherwise close', () => {
    vi.advanceTimersByTime(5000);

    expect(seen).toEqual([{ type: 'heartbeat', data: 'beat' }]);
  });

  it('carries data and no id on every beat, so a client neither discards it nor moves its resume point', () => {
    vi.advanceTimersByTime(100000);

    expect(seen).toHaveLength(20);
    expect(seen.every(event => typeof event.data === 'string' && event.data.length > 0 && event.id === undefined)).toBe(
      true
    );
  });

  it('keeps beating after the messages complete, so the response stays open until the client leaves', () => {
    messages.complete();

    vi.advanceTimersByTime(5000);

    expect(seen).toEqual([{ type: 'heartbeat', data: 'beat' }]);
  });

  it('completes with the messages where asked to, so a stream that has said everything ends its response', () => {
    const ending = new Subject<MessageEvent>();
    const ended: MessageEvent[] = [];
    let completed = false;

    withHeartbeat(ending, { endWithPayloads: true }).subscribe({
      next: event => ended.push(event),
      complete: () => (completed = true),
    });

    ending.next({ data: { value: 1 } });
    ending.complete();
    vi.advanceTimersByTime(100000);

    expect(completed).toBe(true);
    expect(ended).toEqual([{ data: { value: 1 } }]);
  });

  describe('with a resume point', () => {
    it('repeats the last id sent on every message without one, since Nest would number it', () => {
      const resumable = new Subject<MessageEvent>();
      const sent: MessageEvent[] = [];

      const resumed = withHeartbeat(resumable, { lastEventId: '12' }).subscribe(event => sent.push(event));

      vi.advanceTimersByTime(5000);
      resumable.next({ id: '14', data: { value: 1 } });
      resumable.next({ data: { value: 2 } });
      vi.advanceTimersByTime(5000);

      resumed.unsubscribe();

      expect(sent.map(event => event.id)).toEqual(['12', '14', '14', '14']);
    });
  });

  it('stops beating once the connection ends, so a closed stream leaves no timer behind', () => {
    subscription.unsubscribe();

    vi.advanceTimersByTime(100000);

    expect(seen).toEqual([]);
  });
});
