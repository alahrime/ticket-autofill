import { describe, expect, it } from 'vitest';
import { chunks, LABOR_CPL, linesOf, MIN_ROWS, pageBudget, paginate, ROWS_PER_PAGE } from './paginate';

describe('paginate', () => {
  it('a short bill is one page holding every row', () => {
    expect(paginate(3, 2, 22)).toEqual([{ labor: [0, 3], parts: [0, 2] }]);
  });

  it('40 labor lines and 5 parts: two pages, the second holding labor rows 22-39 and no parts', () => {
    expect(paginate(40, 5, 22)).toEqual([
      { labor: [0, 22], parts: [0, 5] },
      { labor: [22, 40], parts: [5, 5] },
    ]);
  });

  it('first and middle pages hold perPage rows per column; the parts column can run longer than labor', () => {
    expect(paginate(5, 50, 22)).toEqual([
      { labor: [0, 5], parts: [0, 22] },
      { labor: [5, 5], parts: [22, 44] },
      { labor: [5, 5], parts: [44, 50] },
    ]);
  });

  it('exactly perPage rows is still one page', () => {
    expect(paginate(22, 22, 22)).toHaveLength(1);
    expect(paginate(23, 0, 22)).toHaveLength(2);
  });

  it('an empty bill is one page', () => {
    expect(paginate(0, 0, 22)).toEqual([{ labor: [0, 0], parts: [0, 0] }]);
  });

  it('refuses a page size below 1', () => {
    expect(() => paginate(1, 1, 0)).toThrow();
  });

  it('the page size print uses is a whole number', () => {
    expect(Number.isInteger(ROWS_PER_PAGE) && ROWS_PER_PAGE > 0).toBe(true);
  });
});

describe('paginate with wrapped rows', () => {
  it('a row of 2 lines counts twice: 20 rows of 2 lines need 2 pages of 22 lines', () => {
    const pages = paginate(Array<number>(20).fill(2), 0, 22);
    expect(pages.map((p) => p.labor)).toEqual([
      [0, 11],
      [11, 20],
    ]);
  });

  it('20 rows of a 120-character description need more pages than 20 one-line rows', () => {
    const w = Array<number>(20).fill(linesOf('X'.repeat(120), LABOR_CPL));
    expect(w[0]).toBe(Math.ceil(120 / LABOR_CPL));
    expect(paginate(20, 0, ROWS_PER_PAGE)).toHaveLength(1);
    const pages = paginate(w, 20, ROWS_PER_PAGE);
    expect(pages.length).toBeGreaterThan(1);
    // every page holds at most the budget in lines, and every row is on exactly one page
    for (const p of pages) expect(w.slice(...p.labor).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(ROWS_PER_PAGE);
    expect(pages.reduce((n, p) => n + p.labor[1] - p.labor[0], 0)).toBe(20);
  });

  it('a row that does not fit what is left of a page starts the next one', () => {
    expect(paginate([3, 3, 3], 0, 7).map((p) => p.labor)).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });

  it('a single row heavier than a page still gets a page of its own (never lost)', () => {
    expect(paginate([1, 50, 1], 0, 10).map((p) => p.labor)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
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
  const typical: [string[], string[], string[]] = [
    ['JANE DOE', '(555)010-0000'],
    ['1 TEST ST', 'TESTVILLE, VA 22000', '(555)010-0001', 'M-F 8.00 AM TO 5.00 PM'],
    ['Year Make. 2015 Make Model', 'License XKS-4827', 'MLG in/out 123456 / 123456', 'Vin TESTVIN0000000001', 'Al Fixit'],
  ];
  const long = 'W'.repeat(80);

  it('a typical header keeps the full page', () => {
    expect(pageBudget('TEST SHOP', typical)).toBe(ROWS_PER_PAGE);
  });

  it('a header at the caps (80-character strings, 5 address lines) gets fewer rows, never under the minimum', () => {
    const caps: [string[], string[], string[]] = [[long, long], [long, long, long, long, long, long, long], [long, long, long, long, long]];
    const n = pageBudget(long, caps);
    expect(n).toBeLessThan(ROWS_PER_PAGE);
    expect(n).toBeGreaterThanOrEqual(MIN_ROWS);
  });
});
