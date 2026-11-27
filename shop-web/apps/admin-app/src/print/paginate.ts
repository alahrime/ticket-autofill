// How many rows of a bill's two columns (labor on the left, parts on the right) go on each printed page.
// A row that wraps onto more printed lines counts for more than one, so a page never outgrows the paper.

/**
 * The most printed lines per page (a one-line row is one line; a wrapped description takes more). Labor line N
 * and parts line N share a row, so a page counts rows by the taller side. A bill's own budget can be lower: see
 * pageBudget. Change it together with LABOR_CPL / PARTS_CPL below.
 */
export const ROWS_PER_PAGE = 24;

/**
 * Characters of a description that fit on one printed line of each side (9pt Arial, upper-case words breaking
 * at spaces) in Chromium: the 3.3in labor description cell holds 40 and the 1.9in parts one 20 (measured with a
 * 120-character description of 8-letter words; lower-case holds more). The constants keep a margin for words
 * that break early. The print CSS keeps those two cell widths.
 */
export const LABOR_CPL = 36;
export const PARTS_CPL = 18;

/**
 * The page height (letter, 0.4in margins: 10.2in) is shared by the header, the column headings, the rows (0.2in
 * a line) and, on the last page, the bottom block (approval, signature, fine print and totals). The header is
 * estimated from its text: each piece's width is summed from rough per-letter widths (W and M widest), so long
 * or wide values add lines and take rows from the page, never the other way round.
 */
export const SHEET_IN = 10.2;
export const ROW_IN = 0.2;
export const BOTTOM_IN = 2.95;
export const MIN_ROWS = 3;

/** Header geometry (inches), matching print.css. */
const TEXT_COL_IN = 5.0; // the shop name, address and contact lines, left of the 2.4in logo box
const CUST_VAL_IN = 1.3; // a customer value, right of its label
const VEH_WIDE_VAL_IN = 3.4; // Year / Make / Model's value
const VEH_LEFT_VAL_IN = 1.1; // License, Mechanic
const VEH_RIGHT_VAL_IN = 1.9; // Odometer, VIN
const TITLE_LINE_IN = 0.34;
const SMALL_LINE_IN = 0.16;
const KV_LINE_IN = 0.18;
const LOGO_IN = 0.8;
const TOP_EXTRA_IN = 0.12; // the rule under the name, its gap
const INFO_EXTRA_IN = 0.12; // the info box's padding and borders
const FIXED_IN = 0.3 + 0.27 + 0.3; // the invoice bar, the column headings, the gaps between blocks

/** A text: the shop's name (22pt Times bold, letter-spaced), the address and contact lines (10pt Arial) or values (9pt Arial bold). */
type Font = { pt: number; spacingPt: number; capEm: number };
const TITLE: Font = { pt: 22, spacingPt: 1.4, capEm: 0.68 }; // Times bold capitals: measured 310pt for JAPANESE AUTO SERVICE
const ADDRESS: Font = { pt: 10, spacingPt: 1.2, capEm: 0.74 };
const CONTACT: Font = { pt: 10, spacingPt: 0.5, capEm: 0.74 };
const VALUE: Font = { pt: 9, spacingPt: 0, capEm: 0.74 };

/** A rough width of one character in ems: generous, so the estimate errs high. */
function em(c: string, capEm: number): number {
  if (c === 'W' || c === 'M') return 0.95;
  if (/[\s.,:;|()\-/'1Iij!]/.test(c)) return 0.35;
  if (/[0-9]/.test(c)) return 0.56;
  if (/[a-z]/.test(c)) return 0.56;
  return capEm;
}

/** Lines `text` takes in a box `widthIn` wide (at least 1). */
export function estLines(text: string, widthIn: number, font: Font): number {
  let pt = 0;
  for (const c of text) pt += em(c, font.capEm) * font.pt + font.spacingPt;
  return Math.max(1, Math.ceil((pt * 1.05) / (widthIn * 72)));
}

/** The header's text, as printed: the address on one line, the contact line, and the values of the info box. */
export type HeaderText = {
  addressLine: string;
  contactLine: string;
  /** Name, phone. */
  customer: string[];
  /** Year / Make / Model, then License, Mechanic (left column), then Odometer, VIN (right column). */
  vehicle: string[];
};

/** How many lines a page of this bill may hold: ROWS_PER_PAGE, less what a long header takes. Never below MIN_ROWS. */
export function pageBudget(title: string, h: HeaderText): number {
  const text =
    estLines(title, TEXT_COL_IN, TITLE) * TITLE_LINE_IN +
    (estLines(h.addressLine, TEXT_COL_IN, ADDRESS) + estLines(h.contactLine, TEXT_COL_IN, CONTACT)) * SMALL_LINE_IN +
    TOP_EXTRA_IN;
  const cust = h.customer.reduce((n, v) => n + estLines(v, CUST_VAL_IN, VALUE), 0);
  const [ymm = '', lic = '', mech = '', odo = '', vin = ''] = h.vehicle;
  const col = (w: number, a: string, b: string): number => estLines(a, w, VALUE) + estLines(b, w, VALUE);
  const veh = estLines(ymm, VEH_WIDE_VAL_IN, VALUE) + Math.max(col(VEH_LEFT_VAL_IN, lic, mech), col(VEH_RIGHT_VAL_IN, odo, vin));
  const head = Math.max(LOGO_IN, text) + Math.max(cust, veh) * KV_LINE_IN + INFO_EXTRA_IN + FIXED_IN;
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
 * The page breaks of a bill's rows, each row a labor line beside a parts line: `weights[i]` is the printed lines
 * the taller side of row i takes. A row that doesn't fit what is left of a page starts the next one; a row
 * heavier than a page gets a page of its own. At least one page, even for an empty bill.
 */
export function paginatePairs(weights: number[], perPage: number): Slice[] {
  if (!Number.isInteger(perPage) || perPage < 1) throw new RangeError('perPage must be a whole number of at least 1');
  return column(weights, perPage);
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
