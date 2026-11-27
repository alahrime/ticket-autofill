import { describe, expect, it } from 'vitest';
import { chunks, type HeaderText, linesOf, MIN_ROWS, pageBudget, paginatePairs, ROWS_PER_PAGE } from './paginate';

describe('paginatePairs', () => {
  const ones = (n: number): number[] => Array<number>(n).fill(1);

  it('the page size print uses is 24', () => {
    expect(ROWS_PER_PAGE).toBe(24);
  });

  it('an empty bill is one empty page', () => {
    expect(paginatePairs([], 24)).toEqual([[0, 0]]);
  });

  it('24 one-line pairs are one page; 25 take a second', () => {
    expect(paginatePairs(ones(24), 24)).toEqual([[0, 24]]);
    expect(paginatePairs(ones(25), 24)).toEqual([
      [0, 24],
      [24, 25],
    ]);
  });

  it('a wrapped pair counts its taller side: [1, 3, 1] at 4 lines a page is two pages', () => {
    expect(paginatePairs([1, 3, 1], 4)).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });

  it('a pair heavier than a page still gets a page of its own (never lost)', () => {
    expect(paginatePairs([30], 24)).toEqual([[0, 1]]);
    expect(paginatePairs([1, 30, 1], 24)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('refuses a page size below 1', () => {
    expect(() => paginatePairs([1], 0)).toThrow(RangeError);
  });
});

describe('linesOf and chunks', () => {
  it('counts lines, at least one', () => {
    expect([linesOf('', 30), linesOf('A', 30), linesOf('A'.repeat(30), 30), linesOf('A'.repeat(31), 30)]).toEqual([1, 1, 1, 2]);
  });

  it('cuts a description too long for a page into pieces that rejoin to all of it', () => {
    const text = Array.from({ length: 60 }, (_, i) => `WORD${i}`).join(' ');
    const parts = chunks(text, 100);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(' ')).toBe(text);
  });

  it('cuts an unbroken string anywhere, none of it lost', () => {
    const text = 'Q'.repeat(250);
    const parts = chunks(text, 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(parts.join('')).toBe(text);
    expect(chunks('SHORT', 100)).toEqual(['SHORT']);
  });
});

describe('pageBudget', () => {
  const typical: HeaderText = {
    addressLine: '3413 WILSON BLVD | ARLINGTON, VA 22201',
    contactLine: 'TEL (703) 522-3100 HOURS MON–FRI 8:00 AM – 6:00 PM',
    customer: ['JANE DOE', '(555) 010-0000'],
    vehicle: ['2019 CADILLAC XT5', 'XKS-4827', 'Al Fixit', '48215', '1GYKNCRS5KZ000000'],
  };
  const W = 'W'.repeat(80);

  it('a typical header keeps the full page: 24 rows', () => {
    expect(pageBudget('JAPANESE AUTO SERVICE', typical)).toBe(ROWS_PER_PAGE);
  });

  it('a header at the caps (80 W characters, 5 address lines) gets fewer rows, never under the minimum', () => {
    const caps: HeaderText = {
      addressLine: Array(5).fill(W).join(' | '),
      contactLine: `TEL ${W} HOURS ${W}`,
      customer: [`${W} ${W}`, W],
      vehicle: [`2015 ${W} ${W}`, W, W, W, W],
    };
    const n = pageBudget(W, caps);
    expect(n).toBeLessThan(ROWS_PER_PAGE);
    expect(n).toBeGreaterThanOrEqual(MIN_ROWS);
  });

  it('a longer shop name costs rows only when it wraps', () => {
    expect(pageBudget('JAPANESE AUTO', typical)).toBe(ROWS_PER_PAGE);
    expect(pageBudget('W'.repeat(40), typical)).toBeLessThan(ROWS_PER_PAGE);
  });
});
