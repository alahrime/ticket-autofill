// Typed values -> clean ticket fields (tickets.py: text, money, cents, normalize). Messages match Python's.
import {
  DEPOSIT_DAYS,
  type Deposit,
  type Line,
  LONG,
  MAX_DEPOSITS,
  MAX_LINES,
  MAX_MONEY,
  MAX_QTY,
  METHODS,
  REQUIRED,
  TEXT,
  type Ticket,
  UPPER,
} from './ticket.js';

// ---- Python string helpers (whitespace is str.isspace(), not JS \s) ----

const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, 'u');
const PY_SPACE_ENDS = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu');
const len = (s: string): number => [...s].length; // code points, as Python counts

export const pyStrip = (s: string): string => s.replace(PY_SPACE_ENDS, '');
export const pySplit = (s: string): string[] => pyStrip(s).split(PY_SPACE_RUN).filter(Boolean);

/** Single spaces between words, no spaces at the ends; null/undefined/0/false -> "". */
export function squash(s: unknown): string {
  return pySplit(s ? String(s) : '').join(' ');
}

/** Local time, ISO, seconds, no offset: 2026-11-18T14:03:09 (Python's datetime.now().isoformat(timespec="seconds")). */
export function nowIso(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const isoDay = (d: Date): string => `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A typed value as a stripped string ('' for null); throws for lists/objects/booleans or over `limit` characters. */
export function text(v: unknown, name: string, limit = 80): string {
  if (v !== null && v !== undefined && typeof v !== 'string' && typeof v !== 'number') {
    throw new Error(`${name} must be text`);
  }
  const s = v === null || v === undefined ? '' : pyStrip(String(v));
  if (len(s) > limit) throw new Error(`${name} is too long (max ${limit})`);
  return s;
}

// ---- exact decimals: digits and a power of ten, never a float ----

export type Dec = { neg: boolean; mant: bigint; exp: number };

const DIG = '\\d+(?:_\\d+)*';
const DEC_RE = new RegExp(`^([+-]?)(?:(${DIG})(?:\\.(${DIG})?)?|\\.(${DIG}))(?:[eE]([+-]?${DIG}))?$`);

/** Python's Decimal(str) for finite numbers; null for anything else (NaN, Infinity, junk). */
export function parseDec(s: string): Dec | null {
  const m = DEC_RE.exec(pyStrip(s));
  if (!m) return null;
  const whole = (m[2] ?? '').replace(/_/g, '');
  const frac = (m[3] ?? m[4] ?? '').replace(/_/g, '');
  const exp = Number((m[5] ?? '0').replace(/_/g, '')) - frac.length;
  return { neg: m[1] === '-', mant: BigInt(`${whole}${frac}` || '0'), exp };
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Round half-up (away from zero on ties) to whole cents: the decimal x 100. Returns signed cents. */
export function toCents(d: Dec): bigint {
  const e = d.exp + 2;
  let c: bigint;
  if (d.mant === 0n) {
    c = 0n;
  } else if (e >= 0) {
    if (e > 1000) throw new Error('number too large');
    c = d.mant * pow10(e);
  } else if (-e > String(d.mant).length + 1) {
    c = 0n; // far below half a cent
  } else {
    const p = pow10(-e);
    c = d.mant / p + (2n * (d.mant % p) >= p ? 1n : 0n);
  }
  return d.neg ? -c : c;
}

/** Decimal digits of `x` compared with the whole number `top`: is |x| > top? */
function above(d: Dec, top: number): boolean {
  if (d.mant === 0n) return false;
  const digits = String(d.mant).length;
  if (d.exp >= 0) {
    if (digits + d.exp > 40) return true;
    return d.mant * pow10(d.exp) > BigInt(top);
  }
  if (-d.exp > digits + 40) return false;
  return d.mant > BigInt(top) * pow10(-d.exp);
}

/** Python's format(x, 'g'): 6 significant digits, e.g. 1e+06, 10000. */
export function formatG(x: number): string {
  if (x === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp < -4 || exp >= 6) {
    const [mant, e] = x.toExponential(5).split('e') as [string, string];
    const sign = e.startsWith('-') ? '-' : '+';
    return `${mant.replace(/\.?0+$/, '')}e${sign}${e.replace(/^[+-]/, '').padStart(2, '0')}`;
  }
  const s = x.toPrecision(6);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** '12.5', '$1,200', 3 -> cents-rounded number; '' / null -> null. Throws Error with the message. */
export function money(v: unknown, name: string, top: number = MAX_MONEY): number | null {
  const s = text(v, name, 40).replace(/\$/g, '').replace(/,/g, '');
  if (!s) return null;
  const x = parseDec(s);
  if (!x) throw new Error(`${name} must be a number`);
  if (x.neg && x.mant !== 0n) throw new Error(`${name} can't be negative`);
  if (above(x, top)) throw new Error(`${name} must be ${formatG(top)} or less`);
  return Number(toCents(x)) / 100; // half-up on the typed digits, not the binary float
}

const isRecord = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null && !Array.isArray(d);
const has = (o: object, k: string): boolean => Object.hasOwn(o, k);

/** An item's id: a whole number up to 1e9, else 0 (it is renumbered). */
function itemId(d: Record<string, unknown>): number {
  const v = d['id'];
  let n = 0;
  if (typeof v === 'number') n = Number.isFinite(v) ? Math.trunc(v) : 0;
  else if (typeof v === 'boolean') n = v ? 1 : 0;
  else if (typeof v === 'string') {
    const s = pyStrip(v);
    n = /^[+-]?\d+(?:_\d+)*$/.test(s) ? Number(s.replace(/_/g, '')) : 0;
  }
  return n > 0 && n <= 1e9 ? n : 0;
}

function cleanLine(d: unknown): Line {
  if (!isRecord(d)) throw new Error('bad line');
  const desc = pySplit(text(d['desc'], 'description', 200)).join(' ');
  if (!desc) throw new Error('description is required');
  const q = d['qty'];
  const qty = money(q === undefined || q === null || q === '' ? 1 : q, 'qty', MAX_QTY);
  if (!qty) throw new Error('qty must be more than 0');
  return {
    desc,
    qty,
    price: money(d['price'], 'price'),
    labor: money(d['labor'], 'labor'),
    code: text(d['code'], 'code', 40).toUpperCase(),
    id: itemId(d),
  };
}

const daysFrom = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 86_400_000;

/** `kept`: ids of deposits already stored; only new ones must be dated within DEPOSIT_DAYS of today. */
function cleanDeposit(d: unknown, kept: ReadonlySet<number>, today: Date): Deposit {
  if (!isRecord(d)) throw new Error('bad deposit');
  const amount = money(d['amount'], 'amount');
  if (!amount) throw new Error('amount must be more than 0');
  const method = text(d['method'], 'method', 20).toLowerCase() || 'cash';
  if (!(METHODS as readonly string[]).includes(method)) throw new Error(`method must be ${METHODS.join(', ')}`);
  const day = text(d['date'], 'date', 10) || isoDay(today);
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(day);
  const [y, mo, dd] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
  const real = m !== null && y >= 1 && mo >= 1 && mo <= 12 && dd >= 1 && dd <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (!real) throw new Error('date must be a real day, YYYY-MM-DD');
  const id = itemId(d);
  const away = daysFrom(y, mo, dd) - daysFrom(today.getFullYear(), today.getMonth() + 1, today.getDate());
  if (!kept.has(id) && Math.abs(away) > DEPOSIT_DAYS) throw new Error('date must be within a year of today'); // a typo in the year
  return { amount, method: method as Deposit['method'], date: day, note: text(d['note'], 'note', 200), id };
}

/** Keep each item's id; new (0) or repeated ones get the next free number, so ids stay stable. */
function renumber<T extends { id: number }>(items: T[]): T[] {
  let top = Math.max(0, ...items.filter((x) => x.id > 0).map((x) => x.id));
  const seen = new Set<number>();
  for (const x of items) {
    if (x.id <= 0 || seen.has(x.id)) x.id = ++top;
    seen.add(x.id);
  }
  return items;
}

export type NormalizeOpts = {
  create?: boolean; // first/last/phone/year/make/model are required
  kept?: ReadonlySet<number>; // ids of the stored deposits (exempt from the date window)
  today?: Date; // injectable local "today" for the year range and deposit dates
};

/**
 * Typed fields -> clean values and errors {field: message}. Only known keys are kept.
 * At create the required fields must be there; on an edit they can't be blanked.
 */
export function normalize(
  fields: Record<string, unknown>,
  opts: NormalizeOpts = {},
): { clean: Partial<Ticket>; errors: Record<string, string> } {
  const { create = false, kept = new Set<number>(), today = new Date() } = opts;
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const raw: Record<string, string> = {};
  const asText = (f: unknown, k: string, limit: number): void => {
    try {
      raw[k] = text(f, k, limit);
    } catch (e) {
      errors[k] = (e as Error).message;
    }
  };
  for (const k of [...UPPER, ...TEXT, 'phone', 'year']) {
    if (has(fields, k)) asText(fields[k], k, LONG.includes(k) ? 2000 : 80);
  }
  for (const [k, v] of Object.entries(raw)) {
    if ((UPPER as readonly string[]).includes(k)) out[k] = pySplit(v).join(' ').toUpperCase();
    else if (k === 'mechanic') out[k] = pySplit(v).join(' ');
    else if ((TEXT as readonly string[]).includes(k)) out[k] = v;
  }
  if (typeof out['odometer'] === 'string') {
    const odo = out['odometer'].replace(/,/g, '').replace(/ /g, '');
    out['odometer'] = odo;
    if (!/^[0-9]{0,7}$/.test(odo)) errors['odometer'] = 'odometer must be up to 7 digits';
  }
  if (typeof out['vin'] === 'string') {
    // no lookalike swaps: a person typed it
    const vin = out['vin'].replace(new RegExp(`[${PY_SPACE}\\ufeff]`, 'gu'), '').toUpperCase();
    out['vin'] = vin;
    if (len(vin) > 80) errors['vin'] = 'vin is too long (max 80)'; // upper() can lengthen: ß -> SS
  }
  if (raw['phone'] !== undefined) {
    const digits = raw['phone'].replace(/[^0-9]/g, '');
    if (digits.length === 10) out['phone'] = `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
    else if (digits) errors['phone'] = 'phone needs 10 digits';
    else out['phone'] = '';
  }
  if (raw['year'] !== undefined) {
    const y = raw['year'];
    const last = today.getFullYear() + 1;
    if (!y) out['year'] = '';
    else if (/^[0-9]{4}$/.test(y) && Number(y) >= 1950 && Number(y) <= last) out['year'] = y;
    else errors['year'] = `year must be 1950 to ${last}`;
  }
  if (has(fields, 'lines')) {
    const lines = fields['lines'];
    if (!Array.isArray(lines)) errors['lines'] = 'lines must be a list';
    else if (lines.length > MAX_LINES) errors['lines'] = `at most ${MAX_LINES} lines`;
    else {
      const clean: Line[] = [];
      for (const [i, d] of lines.entries()) {
        try {
          clean.push(cleanLine(d));
        } catch (e) {
          errors['lines'] = `line ${i + 1}: ${(e as Error).message}`;
          break;
        }
      }
      out['lines'] = renumber(clean);
    }
  }
  if (has(fields, 'deposits')) {
    const deps = fields['deposits'];
    if (!Array.isArray(deps)) errors['deposits'] = 'deposits must be a list';
    else if (deps.length > MAX_DEPOSITS) errors['deposits'] = `at most ${MAX_DEPOSITS} deposits`;
    else {
      const clean: Deposit[] = [];
      for (const [i, d] of deps.entries()) {
        try {
          clean.push(cleanDeposit(d, kept, today));
        } catch (e) {
          errors['deposits'] = `deposit ${i + 1}: ${(e as Error).message}`;
          break;
        }
      }
      out['deposits'] = renumber(clean);
    }
  }
  for (const k of REQUIRED) {
    if (!(k in errors) && (create || k in out) && !out[k]) errors[k] = `${k} is required`;
  }
  return { clean: out as Partial<Ticket>, errors };
}
