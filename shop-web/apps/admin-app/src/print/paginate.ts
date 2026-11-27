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
 * at spaces) in Chromium: the 3.3in labor description cell holds about 40 and the 1.9in parts one about 20. The
 * constants keep a margin for words that break early: a line counted that isn't there only leaves blank space at
 * the foot of a page, while one not counted pushes the page over. The print CSS keeps those two cell widths.
 */
export const LABOR_CPL = 36;
export const PARTS_CPL = 18;

/**
 * The page height (letter, 0.4in margins: 10.2in) is shared by the header, the column headings, the rows (0.2in
 * a line) and, on the last page, the bottom block (approval, signature, fine print and totals). The header is
 * estimated from its text: each piece's width is summed from rough per-letter widths (W and M widest), so long
 * or wide values add lines and take rows from the page, never the other way round.
 */
export const PAGE_IN = 10.2; // letter less its 0.4in margins: what one sheet may take (print.css)
export const ROW_IN = 0.2;
export const BOTTOM_IN = 2.7; // measured 2.67in in Chromium (the fine print column is the tallest)
export const MIN_ROWS = 3;

/** Header geometry (inches), matching print.css. */
const TEXT_COL_IN = 5.0; // the shop name, address and contact lines, left of the 2.4in logo box
const CUST_VAL_IN = 1.3; // a customer value, right of its label
const VEH_WIDE_VAL_IN = 3.4; // Year / Make / Model's value
const VEH_LEFT_VAL_IN = 1.1; // License, Mechanic
const VEH_RIGHT_VAL_IN = 1.9; // Odometer, VIN
const TITLE_LINE_IN = 0.34;
const SMALL_LINE_IN = 0.18; // 10pt at line-height 1.3
const KV_LINE_IN = 0.18;
const LOGO_IN = 0.8;
const TOP_EXTRA_IN = 0.14; // the rule under the name and the gaps around it (measured 0.13)
const INFO_EXTRA_IN = 0.25; // the info box's padding, borders and top margin (measured)
const BAR_IN = 0.35; // the invoice bar (measured)
const FIXED_IN = 0.29 + 0.2; // the column headings and the lines box's borders, the two gaps around it (never scaled)

/**
 * The sizes a header may print at (CSS zoom on .head): full size, unless even MIN_ROWS rows would not fit beside
 * it; then the largest smaller one that leaves room. Only an absurd header (shop text at its 80-character caps)
 * gets there; it prints smaller rather than spilling off the page or being cut.
 */
export const HEAD_SCALES = [1, 0.8, 0.65, 0.5] as const;

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

/**
 * The rows left on a page beside this header printed at `scale` (and the bottom block), unclamped: below MIN_ROWS
 * means the header is too tall at that size. A zoomed header lays its text out in boxes 1/scale as wide (fewer
 * lines), then everything is `scale` as tall.
 */
export function rowsLeft(title: string, h: HeaderText, scale = 1): number {
  const lines = (text: string, widthIn: number, font: Font): number => estLines(text, widthIn / scale, font);
  const text =
    lines(title, TEXT_COL_IN, TITLE) * TITLE_LINE_IN +
    (lines(h.addressLine, TEXT_COL_IN, ADDRESS) + lines(h.contactLine, TEXT_COL_IN, CONTACT)) * SMALL_LINE_IN +
    TOP_EXTRA_IN;
  const cust = h.customer.reduce((n, v) => n + lines(v, CUST_VAL_IN, VALUE), 0);
  const [ymm = '', lic = '', mech = '', odo = '', vin = ''] = h.vehicle;
  const col = (w: number, a: string, b: string): number => lines(a, w, VALUE) + lines(b, w, VALUE);
  const veh = lines(ymm, VEH_WIDE_VAL_IN, VALUE) + Math.max(col(VEH_LEFT_VAL_IN, lic, mech), col(VEH_RIGHT_VAL_IN, odo, vin));
  const head = scale * (Math.max(LOGO_IN, text) + Math.max(cust, veh) * KV_LINE_IN + INFO_EXTRA_IN + BAR_IN) + FIXED_IN;
  return Math.floor((PAGE_IN - head - BOTTOM_IN) / ROW_IN);
}

/** The size this bill's header prints at: the first of HEAD_SCALES that leaves MIN_ROWS rows (else the smallest). */
export function headScale(title: string, h: HeaderText): number {
  return HEAD_SCALES.find((k) => rowsLeft(title, h, k) >= MIN_ROWS) ?? HEAD_SCALES[HEAD_SCALES.length - 1];
}

/** How many lines a page of this bill may hold, its header at `scale`: ROWS_PER_PAGE, less what the header takes. Never below MIN_ROWS. */
export function pageBudget(title: string, h: HeaderText, scale = 1): number {
  return Math.max(MIN_ROWS, Math.min(ROWS_PER_PAGE, rowsLeft(title, h, scale)));
}

/** A half-open range of row numbers: [from, to). */
export type Slice = [number, number];

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
