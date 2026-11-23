import { describe, expect, it } from 'vitest';
import { paginate, ROWS_PER_PAGE } from './paginate';

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
