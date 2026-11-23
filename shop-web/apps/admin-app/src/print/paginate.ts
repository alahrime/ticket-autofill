// How many rows of a bill's two columns (labor on the left, parts on the right) go on each printed page.

/**
 * Rows per column on a page. Letter paper with 0.4in margins leaves 10.2in of height. The header and the column
 * headings take about 2.2in, the bottom block (approval box, notices, signature, liability and authorization
 * boxes, and the totals) about 3.6in, and a row is 0.2in, so 20 rows (4.0in) still fit above the totals with a
 * little to spare. Every page holds at most this many rows, the last page included, so the full totals block
 * always fits under them. Change it together with `--row` in print.css.
 */
export const ROWS_PER_PAGE = 20;

/** A half-open range of row numbers: [from, to). */
export type Slice = [number, number];

export type PageSlice = { labor: Slice; parts: Slice };

/**
 * Each page's slice of the rows, for `labor` labor rows and `parts` part rows. The first and middle pages hold
 * `perPage` rows per column; the bill has as many pages as its longer column needs (at least one). The totals
 * go on the last page only (the caller's job).
 */
export function paginate(labor: number, parts: number, perPage: number): PageSlice[] {
  if (!Number.isInteger(perPage) || perPage < 1) throw new RangeError('perPage must be a whole number of at least 1');
  const pages = Math.max(1, Math.ceil(Math.max(labor, parts) / perPage));
  const slice = (count: number, page: number): Slice => [Math.min(count, page * perPage), Math.min(count, (page + 1) * perPage)];
  return Array.from({ length: pages }, (_, page) => ({ labor: slice(labor, page), parts: slice(parts, page) }));
}
