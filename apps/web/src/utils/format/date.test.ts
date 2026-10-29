import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDate, formatDay, formatDayTime, formatDuration, formatRelativeDate, toIsoDate } from './date';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

describe('formatDay', () => {
  const NOW = new Date(2026, 8, 30, 14, 0);

  it('calls a time earlier the same day today', () => {
    expect(formatDay(new Date(2026, 8, 30, 0, 5), NOW)).toBe('Today');
  });

  it('calls the day before yesterday', () => {
    expect(formatDay(new Date(2026, 8, 29, 23, 59), NOW)).toBe('Yesterday');
  });

  it('writes out anything older as day, short month and year', () => {
    expect(formatDay(new Date(2026, 2, 2, 10, 0), NOW)).toBe('2 Mar 2026');
  });
});

describe('formatDate', () => {
  it('renders the date as day/month/short year', () => {
    expect(formatDate(new Date(2026, 4, 15))).toBe('15/05/26');
  });

  it('pads a single-digit day and month', () => {
    expect(formatDate(new Date(2026, 0, 2))).toBe('02/01/26');
  });

  it('ignores the time of day', () => {
    expect(formatDate(new Date(2026, 4, 15, 23, 59))).toBe('15/05/26');
  });

  it('rolls the year over at the turn of the century', () => {
    expect(formatDate(new Date(2000, 0, 1))).toBe('01/01/00');
  });
});

describe('formatDayTime', () => {
  it('writes the date and the 24-hour time', () => {
    expect(formatDayTime(new Date(2026, 9, 5, 9, 12))).toBe('5 Oct 2026, 09:12');
  });
});

describe('formatRelativeDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a recent date in minutes', () => {
    expect(formatRelativeDate(new Date(Date.now() - 25 * MINUTE_MS))).toBe('25 minutes ago');
  });

  it('renders an older date in hours', () => {
    expect(formatRelativeDate(new Date(Date.now() - 2 * HOUR_MS))).toBe('2 hours ago');
  });

  it('renders a much older date in days', () => {
    expect(formatRelativeDate(new Date(Date.now() - 3 * DAY_MS))).toBe('3 days ago');
  });

  it('renders a future date as time remaining', () => {
    expect(formatRelativeDate(new Date(Date.now() + 2 * HOUR_MS))).toBe('in 2 hours');
  });
});

describe('formatDuration', () => {
  it('gives a tenth of a second under ten seconds', () => {
    expect(formatDuration(0)).toBe('0.0 s');
    expect(formatDuration(420)).toBe('0.4 s');
    expect(formatDuration(9940)).toBe('9.9 s');
  });

  it('rounds to whole seconds under a minute', () => {
    expect(formatDuration(12400)).toBe('12 s');
  });

  it('gives minutes and seconds under an hour', () => {
    expect(formatDuration(185_000)).toBe('3 min 5 s');
  });

  it('gives hours and minutes beyond that', () => {
    expect(formatDuration(3_845_000)).toBe('1 h 4 min');
  });

  it('rounds up into the next unit rather than past its end', () => {
    expect(formatDuration(9960)).toBe('10 s');
    expect(formatDuration(59_600)).toBe('1 min 0 s');
  });

  it('reads a negative span, from a clock stepped back, as none', () => {
    expect(formatDuration(-500)).toBe('0.0 s');
  });
});

describe('toIsoDate', () => {
  it('renders the date as an iso calendar date', () => {
    expect(toIsoDate(new Date(2026, 4, 15))).toBe('2026-05-15');
  });

  it('pads a single-digit day and month', () => {
    expect(toIsoDate(new Date(2026, 0, 2))).toBe('2026-01-02');
  });

  it('reads the local calendar day rather than the utc one', () => {
    expect(toIsoDate(new Date(2026, 4, 15, 23, 59))).toBe('2026-05-15');
  });
});
