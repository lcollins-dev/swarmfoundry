import { describe, expect, it } from 'vitest';

import { cron, integer } from './config.builders';

describe('integer', () => {
  it('falls back on a blank value', () => {
    expect(integer(100, 1).parse('')).toBe(100);
  });

  it('accepts a value at its minimum', () => {
    expect(integer(100, 1).parse('1')).toBe(1);
  });

  it('refuses a value below its minimum', () => {
    expect(integer(100, 1).safeParse('0').success).toBe(false);
  });

  it('accepts any integer without a minimum', () => {
    expect(integer(5).parse('-3')).toBe(-3);
  });
});

describe('cron', () => {
  it('falls back on a blank value', () => {
    expect(cron('0 * * * *').parse('  ')).toBe('0 * * * *');
  });

  it('accepts a cron expression', () => {
    expect(cron('0 * * * *').parse('17 3 * * 1')).toBe('17 3 * * 1');
  });

  it('refuses a value that is not a cron expression', () => {
    const parsed = cron('0 * * * *').safeParse('every hour');

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe('must be a cron expression such as 17 * * * *');
  });
});
