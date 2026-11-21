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

const cents = (b: Buffer, at: number): number => Math.round(real48(b, at) * 100);

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

export function decodeInvoice(rec: Buffer): ImInvoice {
  const name = shortString(rec, 78, 28).trim();
  const words = name.split(/\s+/).filter(Boolean);
  const last = words.length > 0 ? words[words.length - 1] : '';
  const first = words.slice(0, -1).join(' ');
  const a1 = shortString(rec, 284, 28).trim();
  const a2 = shortString(rec, 313, 28).trim();
  return {
    invoice_no: shortString(rec, 5, 8).trim(),
    date: invoiceDate(shortString(rec, 23, 8).trim()),
    key: shortString(rec, 14, 8).trim(),
    name,
    first,
    last,
    phone: phoneDigits(shortString(rec, 107, 14)),
    plate: normalPlate(shortString(rec, 60, 8)),
    address: a2 ? `${a1}, ${a2}` : a1,
    parts: cents(rec, 415),
    labor: cents(rec, 403),
    supplies: cents(rec, 445),
    discount: cents(rec, 204),
    deposit: cents(rec, 409),
    tax: cents(rec, 172),
    total: cents(rec, 136),
    balance: cents(rec, 142),
    tax_rate: Math.round(real48(rec, 372) * 1e6) / 1e6,
    hash: createHash('sha256').update(rec).digest('hex'),
  };
}

type Decoded = { line: ImLine & { date: string }; order: number; badNumbers: number };

function decode(rec: Buffer): Decoded {
  const code = shortString(rec, 13, 8).trim();
  const ref = shortString(rec, 96, 12).trim();
  const kindByte = String.fromCharCode(rec[111]);
  const qtyN = textNumber(shortString(rec, 63, 8));
  const unitN = textNumber(shortString(rec, 127, 13));
  const qty = qtyN ?? 0;
  const unit = Math.round((unitN ?? 0) * 100);
  const payment = (ref !== '' && textNumber(ref) === null) || code.toUpperCase() === 'DEPOSIT';
  const kind = payment ? 'other' : kindByte === 'M' ? 'part' : kindByte === 'L' ? 'labor' : 'other';
  return {
    line: {
      invoice_no: shortString(rec, 4, 8).trim(),
      line_no: 0,
      code,
      description: shortString(rec, 162, 50).trim(),
      kind,
      qty,
      unit,
      amount: Math.round(qty * unit),
      vehicle: shortString(rec, 22, 30).trim(),
      date: lineDate(shortString(rec, 256, 8).trim()),
    },
    order: rec[81],
    badNumbers: (qtyN === null ? 1 : 0) + (unitN === null ? 1 : 0),
  };
}

export function decodeDetail(rec: Buffer): ImLine & { date: string } {
  return decode(rec).line;
}

/** The importer treats anything else as odd (LAYOUT.md: 1-7 digits). */
const INVOICE_NO = /^\d{1,7}$/;

export function readInvoiceFiles(
  invoiceFile: Buffer,
  detailFile: Buffer,
): {
  invoices: ImInvoice[];
  lines: ImLine[];
  headerCounts: { invoice: number; detail: number };
  /** Text numbers in DETAIL that would not parse (read as 0). */
  badNumbers: number;
  /** Records (INVOICE + DETAIL) whose invoice number is not 1-7 digits; kept as typed. */
  oddNumbers: number;
} {
  const inv = readBtrieve(invoiceFile);
  const det = readBtrieve(detailFile);
  const invoices = inv.records.map((r) => decodeInvoice(r));
  let oddNumbers = invoices.filter((x) => !INVOICE_NO.test(x.invoice_no)).length;

  let badNumbers = 0;
  const groups = new Map<string, { d: Decoded; seq: number }[]>();
  det.records.forEach((r, seq) => {
    const d = decode(r);
    if (!INVOICE_NO.test(d.line.invoice_no)) oddNumbers++;
    badNumbers += d.badNumbers;
    const g = groups.get(d.line.invoice_no);
    if (g) g.push({ d, seq });
    else groups.set(d.line.invoice_no, [{ d, seq }]);
  });

  // A handful of odd numbers is how the shop's data is (a letter suffix, a minus sign). When many are,
  // the record walk is wrong, so stop.
  const total = invoices.length + det.records.length;
  if (oddNumbers > 0 && oddNumbers / total > 0.01) {
    throw new BtrieveError(`${oddNumbers} of ${total} records have an invoice number that is not 1-7 digits`);
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

  return { invoices, lines, headerCounts: { invoice: inv.headerCount, detail: det.headerCount }, badNumbers, oddNumbers };
}
