import { describe, expect, it } from 'vitest';

import { formatNumber, formatNumberAbbreviated } from './number';

describe('formatNumber', () => {
  it('renders an integer with locale grouping', () => {
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('rounds decimals to nearest integer', () => {
    expect(formatNumber(1234.6)).toBe('1,235');
  });
});

describe('formatNumberAbbreviated', () => {
  it('renders under-thousands as plain integers', () => {
    expect(formatNumberAbbreviated(0)).toBe('0');
    expect(formatNumberAbbreviated(999)).toBe('999');
  });

  it('renders thousands with a k suffix', () => {
    expect(formatNumberAbbreviated(1500)).toBe('1.5k');
    expect(formatNumberAbbreviated(12000)).toBe('12k');
  });

  it('renders millions with an M suffix', () => {
    expect(formatNumberAbbreviated(1_500_000)).toBe('1.5M');
    expect(formatNumberAbbreviated(2_000_000)).toBe('2M');
  });
});
