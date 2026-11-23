// Who may change a ticket and how it moves (tickets.py: edit, move, totals). Pure: no storage.
import { normalize, nowIso, parseDec, pyStrip, squash, toCents } from './clean.js';
import {
  Invalid,
  MECHANIC_EDITS,
  MECHANIC_KEYS,
  MOVES,
  REQUIRED,
  Refused,
  TEXT,
  type Ticket,
  UPPER,
} from './ticket.js';

const KNOWN = new Set<string>([...UPPER, ...TEXT, ...REQUIRED, 'lines', 'deposits']);

/** Python's repr() of a string, enough for an error message. */
function repr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').split(q).join(`\\${q}`) + q;
}

/** edit()'s options. billFix: the desk fixes our own bill, so a filled ticket may change (the desk only). */
export type EditOpts = { billFix?: boolean };

/**
 * Merge typed fields onto `t` in place. who: "desk" (any field until the ticket is filled; a filled one too with
 * opts.billFix) or "mechanic" (working or approved: lines, odometer, vin, notes). Unknown keys are ignored, as
 * in normalize. Throws Refused (not allowed now / not theirs to change) or Invalid (bad values).
 */
export function edit(
  t: Ticket,
  fields: Record<string, unknown>,
  who: 'desk' | 'mechanic',
  now: () => string = () => nowIso(),
  today?: Date,
  opts: EditOpts = {},
): Ticket {
  const known = Object.keys(fields).filter((k) => KNOWN.has(k));
  const billFix = who === 'desk' && opts.billFix === true && t.status === 'filled';
  if (who === 'desk') {
    if (t.status === 'deleted') throw new Refused("can't change a deleted ticket"); // restore it first
    if (t.status === 'filled' && !billFix) throw new Refused(`the desk can't change a ${t.status} ticket`); // it's in InvoMax now
  } else if (who === 'mechanic') {
    if (!(MECHANIC_EDITS as readonly string[]).includes(t.status)) {
      throw new Refused(`the phone can't change a ${t.status} ticket`);
    }
    const bad = known.filter((k) => !MECHANIC_KEYS.has(k)).sort();
    if (bad.length) throw new Refused(`the phone can't change ${bad.join(', ')}`);
  } else {
    throw new Error(`who must be desk or mechanic, not ${repr(String(who))}`);
  }
  // stored deposits keep their dates
  const { clean, errors } = normalize(fields, { kept: new Set(t.deposits.map((x) => x.id)), today });
  if (clean.lines && !clean.lines.length && (t.status === 'review' || t.status === 'approved' || billFix)) {
    errors['lines'] ??= 'keep at least one line'; // finishing needed one; don't bill an empty ticket
  }
  const sent = t.status === 'approved';
  if ((sent || billFix) && clean.mechanic !== undefined && !clean.mechanic) {
    errors['mechanic'] ??= 'an invoice needs its mechanic';
  }
  if (
    sent &&
    who === 'mechanic' &&
    clean.lines?.length &&
    totals(t).total > 0 &&
    totals({ ...t, lines: clean.lines }).total === 0
  ) {
    errors['lines'] ??= "the phone can't take every charge off a sent invoice; ask the desk";
  }
  if (Object.keys(errors).length) throw new Invalid(errors);
  Object.assign(t, clean);
  if (who === 'desk') t.mech_edit = ''; // the desk has it open and saved: seen
  else if (sent) t.mech_edit = now(); // the desk and the shop PC show that the mechanic changed a sent invoice
  return t;
}

/** Change `t.status` in place, or throw Refused saying why not. */
export function move(t: Ticket, to: string, mechanic?: string | null, note?: string | null): Ticket {
  const frm = t.status;
  if (!MOVES.has(`${frm}>${to}`)) throw new Refused(`can't go from ${frm} to ${to}`);
  if (to === 'approved') {
    // from waiting, working or review: an invoice needs who did it and what was done
    if (!squash(t.mechanic)) throw new Refused('pick the mechanic before sending to InvoMax');
    if (!t.lines.length) throw new Refused('add at least one line before sending to InvoMax');
    t.back_note = '';
  } else if (frm === 'waiting') {
    const who = squash(mechanic);
    if (!who) throw new Refused('pick a mechanic to accept');
    t.mechanic = who;
  } else if (frm === 'working') {
    if (!t.lines.length) throw new Refused('add at least one line before finishing');
    t.back_note = '';
  } else if (to === 'working') {
    const why = pyStrip(note ? String(note) : '');
    if (!why) throw new Refused('say what to fix when sending back');
    t.back_note = why;
  }
  t.status = to;
  return t;
}

export const dec = (v: number | string): bigint => {
  const d = parseDec(String(v));
  if (!d) throw new Error(`not a number: ${String(v)}`);
  return toCents(d);
};

/**
 * parts (sum of qty*price), labor, total (parts + labor) and deposits (paid), each line rounded half-up to
 * cents. No tax or supplies: InvoMax adds those, so the balance due is InvoMax's total less the deposits.
 */
export function totals(t: Pick<Ticket, 'lines' | 'deposits'>): {
  parts: number;
  labor: number;
  total: number;
  deposits: number;
} {
  let parts = 0n;
  let labor = 0n;
  let paid = 0n;
  for (const ln of t.lines) {
    // qty x price exactly: qty has 2 decimals, price 2 decimals; one half-up rounding per line
    if (ln.price !== null && ln.price !== undefined) parts += mulCents(ln.qty, ln.price);
    if (ln.labor !== null && ln.labor !== undefined) labor += dec(ln.labor);
  }
  for (const x of t.deposits) paid += dec(x.amount);
  const n = (c: bigint): number => Number(c) / 100;
  return { parts: n(parts), labor: n(labor), total: n(parts + labor), deposits: n(paid) };
}

/** round-half-up cents of qty x price, both as typed decimals */
export function mulCents(qty: number, price: number): bigint {
  const a = parseDec(String(qty));
  const b = parseDec(String(price));
  if (!a || !b) throw new Error(`not a number: ${String(a ? price : qty)}`);
  const sign = a.neg !== b.neg;
  return toCents({ neg: sign, mant: a.mant * b.mant, exp: a.exp + b.exp });
}
