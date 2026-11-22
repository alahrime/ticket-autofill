// INVOICE and DETAIL records, decoded as described in ../LAYOUT.md. Money is integer cents.
import { createHash } from 'node:crypto';
import { BtrieveError, readBtrieve, real48, shortString } from './btrieve.js';
import { normalPlate, phoneDigits } from './vehicle.js';

export type ImInvoice = {
  invoice_no: string;
  date: string;
  key: string;
  name: string;
  first: string;
  last: string;
  phone: string;
  plate: string;
  address: string;
  parts: number;
  labor: number;
  supplies: number;
  discount: number;
  deposit: number;
  tax: number;
  total: number;
  balance: number;
  tax_rate: number;
  hash: string;
};

export type ImLine = {
  invoice_no: string;
  line_no: number;
  code: string;
  description: string;
  kind: 'part' | 'labor' | 'other';
  qty: number;
  unit: number;
  amount: number;
  vehicle: string;
};

/** Codes whose job is named only in the description (LAYOUT.md): one group per description, not per code. */
export const GENERIC_CODES: readonly string[] = ['LABOR', 'INSTALL-'];

const MAX_QTY = 10000;
const MAX_CENTS = 1e11; // $1 billion: anything beyond is garbage

/** Cents from dollars; out of range (or not a number) is 0 and counted in `bad`. */
function money(dollars: number, bad: { n: number }): number {
  return range(Math.round(dollars * 100), bad);
}

/** An integer cents value in range, else 0 (counted in `bad`); -0 becomes 0. */
function range(c: number, bad: { n: number }): number {
  if (!Number.isSafeInteger(c) || Math.abs(c) > MAX_CENTS) {
    bad.n++;
    return 0;
  }
  return c === 0 ? 0 : c;
}

/** Control characters become spaces; prose fields also collapse runs of spaces. */
function clean(s: string, prose = false): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\x00-\x1f\x7f]/g, ' ');
  return (prose ? t.replace(/ {2,}/g, ' ') : t).trim();
}

const text = (b: Buffer, at: number, max: number, prose = false): string => clean(shortString(b, at, max), prose);

const INVOICE_LENGTH = 498;
const DETAIL_LENGTH = 265;

function needLength(rec: Buffer, n: number, what: string): void {
  if (rec.length < n) throw new BtrieveError(`${what} record is ${rec.length} bytes, expected ${n}`);
}

/** MMDDYYYY -> ISO, or '' when it is not a real date. */
function invoiceDate(s: string): string {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(s);
  return m ? isoOrEmpty(Number(m[3]), Number(m[1]), Number(m[2])) : '';
}

/** YYMMDD -> ISO (YY 00-40 is 20YY), or '' when it is not a real date. */
function lineDate(s: string): string {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return '';
  const yy = Number(m[1]);
  return isoOrEmpty(yy <= 40 ? 2000 + yy : 1900 + yy, Number(m[2]), Number(m[3]));
}

function isoOrEmpty(y: number, mo: number, d: number): string {
  if (y < 1980 || y > 2099 || mo < 1 || mo > 12 || d < 1) return '';
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A right-aligned decimal text. Blank is 0; null when it does not parse. */
function textNumber(s: string): number | null {
  const t = s.trim();
  if (t === '') return 0;
  return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
}

function decodeInvoiceCounted(rec: Buffer): { inv: ImInvoice; bad: number } {
  needLength(rec, INVOICE_LENGTH, 'INVOICE');
  const bad = { n: 0 };
  const name = text(rec, 78, 28, true);
  const words = name.split(' ').filter(Boolean);
  const last = words.length > 0 ? words[words.length - 1] : '';
  const first = words.slice(0, -1).join(' ');
  const a1 = text(rec, 284, 28, true);
  const a2 = text(rec, 313, 28, true);
  const m = (at: number): number => money(real48(rec, at), bad);
  const rate = real48(rec, 372);
  let tax_rate = Math.round(rate * 1e6) / 1e6;
  if (!(tax_rate >= 0 && tax_rate <= 1)) {
    tax_rate = 0;
    bad.n++;
  }
  const inv: ImInvoice = {
    invoice_no: text(rec, 5, 8),
    date: invoiceDate(text(rec, 23, 8)),
    key: text(rec, 14, 8),
    name,
    first,
    last,
    phone: phoneDigits(text(rec, 107, 14)),
    plate: normalPlate(text(rec, 60, 8)),
    address: a2 ? `${a1}, ${a2}` : a1,
    parts: m(415),
    labor: m(403),
    supplies: m(445),
    discount: m(204),
    deposit: m(409),
    tax: m(172),
    total: m(136),
    balance: m(142),
    tax_rate,
    hash: createHash('sha256').update(rec).digest('hex'),
  };
  return { inv, bad: bad.n };
}

export function decodeInvoice(rec: Buffer): ImInvoice {
  return decodeInvoiceCounted(rec).inv;
}

type Decoded = { line: ImLine & { date: string }; order: number; badNumbers: number };

function decode(rec: Buffer): Decoded {
  needLength(rec, DETAIL_LENGTH, 'DETAIL');
  const bad = { n: 0 };
  const code = text(rec, 13, 8);
  const ref = text(rec, 96, 12);
  const kindByte = String.fromCharCode(rec[111]);
  const qtyN = textNumber(text(rec, 63, 8));
  const unitN = textNumber(text(rec, 127, 13));
  if (qtyN === null) bad.n++;
  if (unitN === null) bad.n++;
  let qty = qtyN ?? 0;
  if (!(Math.abs(qty) <= MAX_QTY)) {
    qty = 0;
    bad.n++;
  }
  const unit = money(unitN ?? 0, bad);
  const amount = range(Math.round(qty * unit), bad);
  const payment = (ref !== '' && textNumber(ref) === null) || code.toUpperCase() === 'DEPOSIT';
  const kind = payment ? 'other' : kindByte === 'M' ? 'part' : kindByte === 'L' ? 'labor' : 'other';
  return {
    line: {
      invoice_no: text(rec, 4, 8),
      line_no: 0,
      code,
      description: text(rec, 162, 50, true),
      kind,
      qty,
      unit,
      amount,
      vehicle: text(rec, 22, 30, true),
      date: lineDate(text(rec, 256, 8)),
    },
    order: rec[81],
    badNumbers: bad.n,
  };
}

export function decodeDetail(rec: Buffer): ImLine & { date: string } {
  return decode(rec).line;
}

/** The importer treats anything else as odd (LAYOUT.md: 1-7 digits). */
const INVOICE_NO = /^\d{1,7}$/;

export type InvoiceFiles = {
  invoices: ImInvoice[];
  lines: ImLine[];
  headerCounts: { invoice: number; detail: number };
  /** Numbers in the records that were out of range or would not parse (read as 0). */
  badNumbers: number;
  /** Records (INVOICE + DETAIL) whose invoice number is not 1-7 digits; kept as typed. */
  oddNumbers: number;
  /** The first 20 odd invoice numbers. */
  oddSamples: string[];
  /** INVOICE records whose number was already seen; the last record wins. */
  duplicates: number;
};

export function readInvoiceFiles(invoiceFile: Buffer, detailFile: Buffer): InvoiceFiles {
  const inv = readBtrieve(invoiceFile);
  const det = readBtrieve(detailFile);
  if (inv.recordLength !== INVOICE_LENGTH || det.recordLength !== DETAIL_LENGTH) {
    throw new BtrieveError(
      `record lengths are ${inv.recordLength} and ${det.recordLength}, expected ${INVOICE_LENGTH} and ${DETAIL_LENGTH}`,
    );
  }

  let badNumbers = 0;
  let oddInvoice = 0;
  let oddDetail = 0;
  let duplicates = 0;
  const oddSamples: string[] = [];
  const odd = (no: string): void => {
    if (oddSamples.length < 20) oddSamples.push(no);
  };

  const byNumber = new Map<string, ImInvoice>();
  for (const r of inv.records) {
    const { inv: x, bad } = decodeInvoiceCounted(r);
    badNumbers += bad;
    if (!INVOICE_NO.test(x.invoice_no)) {
      oddInvoice++;
      odd(x.invoice_no);
    }
    if (byNumber.has(x.invoice_no)) {
      duplicates++;
      byNumber.delete(x.invoice_no); // the later record wins, and takes the later position
    }
    byNumber.set(x.invoice_no, x);
  }
  const invoices = [...byNumber.values()];

  const groups = new Map<string, { d: Decoded; seq: number }[]>();
  det.records.forEach((r, seq) => {
    const d = decode(r);
    if (!INVOICE_NO.test(d.line.invoice_no)) {
      oddDetail++;
      odd(d.line.invoice_no);
    }
    badNumbers += d.badNumbers;
    const g = groups.get(d.line.invoice_no);
    if (g) g.push({ d, seq });
    else groups.set(d.line.invoice_no, [{ d, seq }]);
  });

  // A handful of odd numbers is how the shop's data is (a letter suffix, a minus sign). When many are
  // in one file, the record walk is wrong, so stop.
  if (oddInvoice > inv.records.length * 0.01 || oddDetail > det.records.length * 0.01) {
    throw new BtrieveError(
      `${oddInvoice} of ${inv.records.length} INVOICE and ${oddDetail} of ${det.records.length} DETAIL records have an invoice number that is not 1-7 digits`,
    );
  }

  const lines: ImLine[] = [];
  const firstDate = new Map<string, string>();
  for (const [no, g] of groups) {
    g.sort((a, b) => a.d.order - b.d.order || a.seq - b.seq);
    firstDate.set(no, g[0].d.line.date);
    g.forEach(({ d }, i) => {
      const line: ImLine & { date?: string } = { ...d.line, line_no: i + 1 };
      delete line.date;
      lines.push(line);
    });
  }
  for (const x of invoices) if (!x.date) x.date = firstDate.get(x.invoice_no) ?? '';

  return {
    invoices,
    lines,
    headerCounts: { invoice: inv.headerCount, detail: det.headerCount },
    badNumbers,
    oddNumbers: oddInvoice + oddDetail,
    oddSamples,
    duplicates,
  };
}
