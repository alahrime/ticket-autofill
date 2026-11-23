// How many rows of a bill's two columns (labor on the left, parts on the right) go on each printed page.
// A row that wraps onto more printed lines counts for more than one, so a page never outgrows the paper.

/**
 * The most printed lines per column on a page (a one-line row is one line; a wrapped description takes more).
 * A bill's own budget can be lower: see pageBudget. Change it together with LABOR_CPL / PARTS_CPL below.
 */
export const ROWS_PER_PAGE = 20;

/**
 * Characters of a description that fit on one printed line of each column (9pt Arial, upper-case words breaking
 * at spaces) in Chromium: the 3.3in labor description cell holds 40 and the 1.9in parts one 20 (measured with a
 * 120-character description of 8-letter words; lower-case holds more). The constants keep a margin for words
 * that break early.
 */
export const LABOR_CPL = 36;
export const PARTS_CPL = 18;

/**
 * The page height (letter, 0.4in margins: 10.2in; the sheet is 10.1in) is shared by the header, the column
 * headings, the rows (0.2in a line) and, on the last page, the bottom block (notices and totals, measured 3.42in).
 * The header grows with long shop strings (at most 80 characters, 5 address lines), so the page's row budget
 * shrinks to fit. The header is estimated from its text: a line of its columns is 0.15in; its three columns hold
 * at most HEAD_CPL characters a line (the widest letters, W, in the 1.9, 2.7 and 2.9in columns, so the estimate
 * errs high; measured at the caps: 4.15in for 80-character words, 5.5in for 80 unbroken W against estimates of 4.9 and 6.1in); the 20pt title is 0.31in a line, TITLE_CPL characters wide; the rest (numbers row, rules, gaps) is 0.5in.
 */
export const SHEET_IN = 10.1;
export const BOTTOM_IN = 3.5;
export const ROW_IN = 0.2;
export const HEAD_CPL = [16, 22, 24] as const;
export const TITLE_CPL = 28;
export const HEAD_LINE_IN = 0.15;
export const TITLE_LINE_IN = 0.31;
export const HEAD_REST_IN = 0.5 + 0.2 + 0.1 + 0.1; // + column headings, gap, safety
export const MIN_ROWS = 3;

/** Lines a column of header strings takes, each wrapped at `cpl` characters. */
const colLines = (strings: string[], cpl: number): number => strings.reduce((n, t) => n + Math.max(1, Math.ceil(t.length / cpl)), 0);

/**
 * How many lines each column may hold on a page of this bill: ROWS_PER_PAGE, less what a long header (the shop
 * `title`, then the three header columns of strings) takes from the page. Never below MIN_ROWS.
 */
export function pageBudget(title: string, columns: readonly [string[], string[], string[]]): number {
  const head =
    Math.max(1, Math.ceil(title.length / TITLE_CPL)) * TITLE_LINE_IN +
    Math.max(...columns.map((c, i) => colLines(c, HEAD_CPL[i]))) * HEAD_LINE_IN +
    HEAD_REST_IN;
  const rows = Math.floor((SHEET_IN - head - BOTTOM_IN) / ROW_IN);
  return Math.max(MIN_ROWS, Math.min(ROWS_PER_PAGE, rows));
}

/** A half-open range of row numbers: [from, to). */
export type Slice = [number, number];

export type PageSlice = { labor: Slice; parts: Slice };

/** Printed lines a description takes in a column `cpl` characters wide (at least 1). */
export const linesOf = (desc: string, cpl: number): number => Math.max(1, Math.ceil(desc.length / cpl));

/**
 * `desc` cut into pieces of at most `max` characters, at a space where there is one in the last fifth of a piece
 * (otherwise anywhere): a description too long for one page is printed over several rows, none of it lost.
 */
export function chunks(desc: string, max: number): string[] {
  const out: string[] = [];
  let rest = desc;
  while (rest.length > max) {
    const at = rest.lastIndexOf(' ', max);
    const cut = at > max * 0.8 ? at : max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

/** The page breaks of one column: the row ranges that fit `perPage` lines each (a row heavier than that fills a page). */
function column(weights: number[], perPage: number): Slice[] {
  const pages: Slice[] = [];
  let from = 0;
  let used = 0;
  weights.forEach((w, i) => {
    const lines = Math.min(w, perPage);
    if (used > 0 && used + lines > perPage) {
      pages.push([from, i]);
      from = i;
      used = 0;
    }
    used += lines;
  });
  pages.push([from, weights.length]);
  return pages;
}

/**
 * Each page's slice of the rows. `labor` and `parts` are the lines each row takes (an array), or just a row count
 * (every row one line). The first and middle pages hold up to `perPage` lines per column; the bill has as many
 * pages as its longer column needs (at least one). The totals go on the last page only (the caller's job).
 */
export function paginate(labor: number | number[], parts: number | number[], perPage: number): PageSlice[] {
  if (!Number.isInteger(perPage) || perPage < 1) throw new RangeError('perPage must be a whole number of at least 1');
  const ones = (n: number | number[]): number[] => (typeof n === 'number' ? Array<number>(n).fill(1) : n);
  const l = column(ones(labor), perPage);
  const p = column(ones(parts), perPage);
  const end = (cols: Slice[], page: number, count: number): Slice =>
    page < cols.length ? cols[page] : [count, count];
  const lCount = l[l.length - 1][1];
  const pCount = p[p.length - 1][1];
  return Array.from({ length: Math.max(l.length, p.length) }, (_, page) => ({
    labor: end(l, page, lCount),
    parts: end(p, page, pCount),
  }));
}
