// Bill history: our filled tickets and InvoMax's bills, side by side. Reads tickets.db on its own read-only
// connection with invomax.db attached read-only as `im`; each call is one read transaction, so it sees one
// snapshot of both even while the import rewrites bills (invomax.db is WAL). Money out is in dollars.
import { existsSync } from 'node:fs';
import type { DatabaseSync as Db } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { type Line, type Ticket, totals } from '@shop/domain';
import { normalPlate, phoneDigits } from '@shop/invomax';
import { openImDb } from '../invomax/imdb';
import { TicketStore } from '../store';

export const PER_PAGE = 50;

export type BillRow = {
  key: string;
  date: string;
  invoice_no: string | null;
  ticket_id: number | null;
  name: string;
  phone: string;
  vehicle: string;
  plate: string;
  /** Dollars; null for a filled ticket with no bill. */
  total: number | null;
};

export type ImLineOut = { code: string; description: string; kind: 'part' | 'labor' | 'other'; qty: number; unit: number; amount: number };

export type Bill = {
  key: string;
  /** Who and what, from our ticket when there is one, else from InvoMax's bill. */
  customer: { name: string; phone: string; vehicle: string; plate: string };
  before: { ticket_id: number; lines: Line[]; parts: number; labor: number; subtotal: number } | null;
  after: {
    invoice_no: string | null;
    date: string;
    parts: number;
    labor: number;
    supplies: number;
    discount: number;
    deposit: number;
    tax: number;
    total: number;
    balance: number;
    lines: ImLineOut[];
    source: 'invomax' | 'typed';
    gone: boolean;
  } | null;
  link: { source: 'invomax' | 'typed' | 'none'; linked_by: string; linked_at: string; version: number } | null;
  /** Our subtotal less InvoMax's parts + labor, in dollars; null unless both sides are there. */
  difference: number | null;
};

export type Search = { tag?: string; name?: string; phone?: string; vin?: string; from?: string; to?: string; page?: number };

export type Customer = { phone: string; vehicles: { plate: string; vin: string; vehicle: string; bills: BillRow[] }[] };

/** A BillRow as queried: total in cents, plus what customer() groups by. */
type Row = BillRow & { pn: string; vin: string; im_no: string | null };
type Final = {
  ticket_id: number;
  invoice_no: string | null;
  source: 'invomax' | 'typed' | 'none';
  linked_at: string;
  linked_by: string;
  parts: number | null;
  labor: number | null;
  supplies: number | null;
  tax: number | null;
  total: number | null;
  version: number;
};
type ImInvoice = {
  invoice_no: string;
  date: string;
  name: string;
  first: string;
  last: string;
  phone: string;
  plate: string;
  parts: number;
  labor: number;
  supplies: number;
  discount: number;
  deposit: number;
  tax: number;
  total: number;
  balance: number;
  gone_at: string;
};

const dollars = (cents: number): number => Math.round(cents) / 100;
const cents = (d: number): number => Math.round(d * 100);
/** %x% for LIKE ... ESCAPE '\': the user's % and _ are plain text. */
const contains = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const like = (col: string, param: string): string => `${col} LIKE ${param} ESCAPE '\\'`;

// Filled tickets as columns (a row whose JSON won't parse is left out, never an error).
const TICKETS = `SELECT id,
    coalesce(CAST(json_extract(data, '$.first') AS TEXT), '') AS first,
    coalesce(CAST(json_extract(data, '$.last') AS TEXT), '') AS last,
    coalesce(CAST(json_extract(data, '$.phone') AS TEXT), '') AS phone,
    coalesce(CAST(json_extract(data, '$.plate') AS TEXT), '') AS plate,
    coalesce(CAST(json_extract(data, '$.vin') AS TEXT), '') AS vin,
    trim(coalesce(CAST(json_extract(data, '$.year') AS TEXT), '') || ' ' || coalesce(CAST(json_extract(data, '$.make') AS TEXT), '')
      || ' ' || coalesce(CAST(json_extract(data, '$.model') AS TEXT), '')) AS vehicle,
    substr(coalesce(CAST(json_extract(data, '$.updated') AS TEXT), ''), 1, 10) AS day
  FROM main.tickets WHERE status = 'filled' AND json_valid(data)`;

type Where = { im: string[]; t: string[]; args: Record<string, string> };

/** The SQL conditions for a search, for the InvoMax side (i, with its linked ticket t) and the ticket side (t). */
function conditions(q: Search & { phoneIs?: string }): Where {
  const w: Where = { im: [], t: [], args: {} };
  const name = (q.name ?? '').trim().replace(/\s+/g, ' ');
  if (name) {
    w.args['name'] = contains(name);
    const ours = `(${like('t.first', '$name')} OR ${like('t.last', '$name')} OR ${like("(t.first || ' ' || t.last)", '$name')})`;
    w.im.push(
      `(${like('i.name', '$name')} OR ${like('i."first"', '$name')} OR ${like('i."last"', '$name')} OR ` +
        `${like(`(i."first" || ' ' || i."last")`, '$name')} OR (t.id IS NOT NULL AND ${ours}))`,
    );
    w.t.push(ours);
  }
  const phone = phoneDigits(q.phone ?? '');
  if (phone) {
    w.args['phone'] = contains(phone);
    w.im.push(`(${like('i.phone', '$phone')} OR (t.id IS NOT NULL AND ${like('digits(t.phone)', '$phone')}))`);
    w.t.push(like('digits(t.phone)', '$phone'));
  }
  if (q.phoneIs) {
    w.args['phoneIs'] = q.phoneIs;
    w.im.push(`(i.phone = $phoneIs OR (t.id IS NOT NULL AND digits(t.phone) = $phoneIs))`);
    w.t.push('digits(t.phone) = $phoneIs');
  }
  const tag = normalPlate(q.tag ?? '');
  if (tag) {
    w.args['tag'] = contains(tag);
    w.im.push(`(${like('i.plate_norm', '$tag')} OR (t.id IS NOT NULL AND ${like('plate_norm(t.plate)', '$tag')}))`);
    w.t.push(like('plate_norm(t.plate)', '$tag'));
  }
  const vin = (q.vin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (vin) {
    // InvoMax keeps no VIN: only bills with one of our tickets can match
    w.args['vin'] = contains(vin);
    w.im.push(`(t.id IS NOT NULL AND ${like('upper(t.vin)', '$vin')})`);
    w.t.push(like('upper(t.vin)', '$vin'));
  }
  if (q.from) {
    w.args['from'] = q.from;
    w.im.push('i."date" >= $from');
    w.t.push('t.day >= $from');
  }
  if (q.to) {
    w.args['to'] = q.to;
    w.im.push('i."date" <= $to');
    w.t.push('t.day <= $to');
  }
  return w;
}

const and = (list: string[]): string => (list.length ? ` AND ${list.join(' AND ')}` : '');

/** Every matching row (bill or bill-less filled ticket), as one query: WITH t, r. */
function rowsSql(w: Where): string {
  return `WITH t AS (${TICKETS}),
  r AS (
    SELECT 'im' || i.invoice_no AS key, i."date" AS date, i.invoice_no AS invoice_no, t.id AS ticket_id,
      CASE WHEN t.id IS NULL THEN coalesce(nullif(trim(i."first" || ' ' || i."last"), ''), i.name)
        ELSE trim(t.first || ' ' || t.last) END AS name,
      i.phone AS phone,
      CASE WHEN t.id IS NULL THEN '' ELSE t.vehicle END AS vehicle,
      CASE WHEN t.id IS NULL OR t.plate = '' THEN i.plate ELSE t.plate END AS plate,
      i.total AS total,
      CASE WHEN t.id IS NULL OR t.plate = '' THEN i.plate_norm ELSE plate_norm(t.plate) END AS pn,
      coalesce(t.vin, '') AS vin, i.invoice_no AS im_no
    FROM im.im_invoices i
    LEFT JOIN main.invoice_finals f ON f.invoice_no = i.invoice_no AND f.source = 'invomax'
    LEFT JOIN t ON t.id = f.ticket_id
    WHERE 1${and(w.im)}
    UNION ALL
    SELECT 't' || t.id, t.day, f.invoice_no, t.id, trim(t.first || ' ' || t.last), digits(t.phone), t.vehicle, t.plate,
      CASE WHEN f.source = 'typed' THEN f.total END, plate_norm(t.plate), t.vin, NULL
    FROM t LEFT JOIN main.invoice_finals f ON f.ticket_id = t.id
    WHERE (f.ticket_id IS NULL OR f.source <> 'invomax'
      OR NOT EXISTS (SELECT 1 FROM im.im_invoices x WHERE x.invoice_no = f.invoice_no))${and(w.t)}
  )`;
}

const ORDER = 'ORDER BY date DESC, key DESC';

export class History {
  private readonly db: Db;
  private readonly tickets: TicketStore;

  /** tickets.db must exist (with invoice_finals: LinkStore makes it); an empty invomax.db is made if missing. */
  constructor(ticketsDb: string, invomaxDb: string) {
    if (!existsSync(invomaxDb)) openImDb(invomaxDb).close();
    this.db = new DatabaseSync(ticketsDb, { readOnly: true });
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.prepare('ATTACH DATABASE ? AS im').run(`${pathToFileURL(invomaxDb).href}?mode=ro`);
      this.db.function('digits', { deterministic: true }, (s) => phoneDigits(String(s ?? '')));
      this.db.function('plate_norm', { deterministic: true }, (s) => normalPlate(String(s ?? '')));
    } catch (e) {
      this.db.close();
      throw e;
    }
    this.tickets = new TicketStore(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** f inside one read transaction: one snapshot of both files. */
  private read<T>(f: () => T): T {
    this.db.exec('BEGIN');
    try {
      return f();
    } finally {
      if (this.db.isTransaction) this.db.exec('COMMIT');
    }
  }

  /** Rows of a page (or all with page 0), each im-only row given the vehicle of its first line that has one. */
  private rows(q: Search & { phoneIs?: string }, page: number): Row[] {
    const w = conditions(q);
    const limit = page > 0 ? ` LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}` : '';
    const rows = this.db.prepare(`${rowsSql(w)} SELECT * FROM r ${ORDER}${limit}`).all(w.args) as unknown as Row[];
    for (const r of rows) if (!r.vehicle && r.im_no) r.vehicle = this.firstVehicle(r.im_no);
    return rows;
  }

  private static out(r: Row): BillRow {
    return {
      key: r.key,
      date: r.date,
      invoice_no: r.invoice_no,
      ticket_id: r.ticket_id,
      name: r.name,
      phone: r.phone,
      vehicle: r.vehicle,
      plate: r.plate,
      total: r.total === null ? null : dollars(r.total),
    };
  }

  /** One page (50) of matching rows, newest first, and how many match in all. */
  search(q: Search): { rows: BillRow[]; total: number; page: number; per_page: typeof PER_PAGE } {
    const page = q.page ?? 1;
    return this.read(() => {
      const w = conditions(q);
      const { n } = this.db.prepare(`${rowsSql(w)} SELECT count(*) AS n FROM r`).get(w.args) as { n: number };
      return { rows: this.rows(q, page).map(History.out), total: n, page, per_page: PER_PAGE };
    });
  }

  /** A customer by phone digits: their vehicles (by plate, else VIN, else description), each with its bills. */
  customer(phone: string): Customer | null {
    const digits = phoneDigits(phone);
    if (!digits) return null;
    return this.read(() => {
      const rows = this.rows({ phoneIs: digits }, 0);
      if (!rows.length) return null;
      const byVehicle = new Map<string, Customer['vehicles'][number]>();
      for (const r of rows) {
        const id = r.pn ? `p:${r.pn}` : r.vin ? `v:${r.vin}` : `d:${r.vehicle.toUpperCase()}`;
        let v = byVehicle.get(id);
        if (!v) byVehicle.set(id, (v = { plate: r.plate, vin: r.vin, vehicle: r.vehicle, bills: [] }));
        if (!v.vin && r.vin) v.vin = r.vin;
        if (!v.vehicle && r.vehicle) v.vehicle = r.vehicle;
        v.bills.push(History.out(r));
      }
      return { phone: digits, vehicles: [...byVehicle.values()] };
    });
  }

  /** The newest import, or null before any. */
  lastImport(): { finished: string; ok: boolean; invoices: number } | null {
    const r = this.db.prepare('SELECT finished, ok, invoices FROM im.im_imports ORDER BY id DESC LIMIT 1').get() as
      | { finished: string; ok: number; invoices: number }
      | undefined;
    return r ? { finished: r.finished, ok: r.ok === 1, invoices: r.invoices } : null;
  }

  private invoice(no: string): ImInvoice | null {
    return (
      (this.db
        .prepare(
          `SELECT invoice_no, "date" AS date, name, "first" AS first, "last" AS last, phone, plate, parts, labor, supplies,
             discount, deposit, tax, total, balance, gone_at FROM im.im_invoices WHERE invoice_no = ?`,
        )
        .get(no) as ImInvoice | undefined) ?? null
    );
  }

  private finalOf(col: 'ticket_id' | 'invoice_no', value: number | string): Final | null {
    const extra = col === 'invoice_no' ? " AND source = 'invomax'" : '';
    return (
      (this.db
        .prepare(
          `SELECT ticket_id, invoice_no, source, linked_at, linked_by, parts, labor, supplies, tax, total, version
           FROM main.invoice_finals WHERE ${col} = ?${extra}`,
        )
        .get(value) as Final | undefined) ?? null
    );
  }

  private lines(no: string): ImLineOut[] {
    const rows = this.db
      .prepare('SELECT code, description, kind, qty, unit, amount FROM im.im_lines WHERE invoice_no = ? ORDER BY line_no')
      .all(no) as ImLineOut[];
    return rows.map((l) => ({ code: l.code, description: l.description, kind: l.kind, qty: l.qty, unit: dollars(l.unit), amount: dollars(l.amount) }));
  }

  /**
   * One row's both sides. `im<no>`: that bill (gone ones too) and the ticket linked to it; `t<id>`: a filled
   * ticket (or one with a final), which, when linked to a bill InvoMax has, is that pair (keyed im<no>). Else null.
   */
  bill(key: string): Bill | null {
    return this.read(() => {
      let inv: ImInvoice | null = null;
      let fin: Final | null = null;
      let ticket: Ticket | null = null;
      const im = /^im(\d{1,7})$/.exec(key);
      const t = /^t(\d{1,9})$/.exec(key);
      if (im) {
        inv = this.invoice(im[1] as string);
        if (!inv) return null;
        fin = this.finalOf('invoice_no', inv.invoice_no);
        ticket = fin ? this.tickets.get(fin.ticket_id) : null;
      } else if (t) {
        const id = Number(t[1]);
        ticket = this.tickets.get(id);
        fin = this.finalOf('ticket_id', id);
        if (!ticket || (ticket.status !== 'filled' && !fin)) return null;
        if (fin?.source === 'invomax' && fin.invoice_no) inv = this.invoice(fin.invoice_no);
      } else return null;

      const before = ticket ? History.before(ticket) : null;
      const after = inv
        ? {
            invoice_no: inv.invoice_no,
            date: inv.date,
            parts: dollars(inv.parts),
            labor: dollars(inv.labor),
            supplies: dollars(inv.supplies),
            discount: dollars(inv.discount),
            deposit: dollars(inv.deposit),
            tax: dollars(inv.tax),
            total: dollars(inv.total),
            balance: dollars(inv.balance),
            lines: this.lines(inv.invoice_no),
            source: 'invomax' as const,
            gone: inv.gone_at !== '',
          }
        : fin?.source === 'typed'
          ? History.typed(fin, ticket)
          : null;
      const link = fin
        ? { source: fin.source, linked_by: fin.linked_by, linked_at: fin.linked_at, version: fin.version }
        : null;
      const difference =
        before && after ? (cents(before.subtotal) - cents(after.parts) - cents(after.labor)) / 100 : null;
      const customer = ticket
        ? {
            name: `${ticket.first} ${ticket.last}`.trim(),
            phone: phoneDigits(ticket.phone),
            vehicle: [ticket.year, ticket.make, ticket.model].filter(Boolean).join(' '),
            plate: ticket.plate,
          }
        : {
            name: `${inv?.first ?? ''} ${inv?.last ?? ''}`.trim() || (inv?.name ?? ''),
            phone: inv?.phone ?? '',
            vehicle: inv ? this.firstVehicle(inv.invoice_no) : '',
            plate: inv?.plate ?? '',
          };
      return { key: inv ? `im${inv.invoice_no}` : `t${ticket?.id ?? ''}`, customer, before, after, link, difference };
    });
  }

  private firstVehicle(no: string): string {
    const r = this.db
      .prepare("SELECT vehicle FROM im.im_lines WHERE invoice_no = ? AND vehicle <> '' ORDER BY line_no LIMIT 1")
      .get(no) as { vehicle: string } | undefined;
    return (r?.vehicle ?? '').trim();
  }

  private static before(t: Ticket): NonNullable<Bill['before']> {
    const tot = totals(t);
    const lines = t.lines.map((l) => ({ desc: l.desc, qty: l.qty, price: l.price, labor: l.labor, code: l.code, id: l.id }));
    return { ticket_id: t.id, lines, parts: tot.parts, labor: tot.labor, subtotal: tot.total };
  }

  /** A typed final as the after side: no lines; the deposits are the ticket's, the balance what is left. */
  private static typed(f: Final, t: Ticket | null): NonNullable<Bill['after']> {
    const c = (x: number | null): number => x ?? 0;
    const paid = t ? cents(totals(t).deposits) : 0;
    return {
      invoice_no: f.invoice_no,
      date: f.linked_at.slice(0, 10),
      parts: dollars(c(f.parts)),
      labor: dollars(c(f.labor)),
      supplies: dollars(c(f.supplies)),
      discount: 0,
      deposit: dollars(paid),
      tax: dollars(c(f.tax)),
      total: dollars(c(f.total)),
      balance: dollars(c(f.total) - paid),
      lines: [],
      source: 'typed',
      gone: false,
    };
  }
}
