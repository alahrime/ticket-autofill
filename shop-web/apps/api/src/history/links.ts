// Which InvoMax bill belongs to which filled ticket. Tables live in tickets.db (made here, if missing); the
// bills are read from invomax.db. Money is integer cents; dates are local YYYY-MM-DD.
import type { DatabaseSync } from 'node:sqlite';
import { nowIso, Refused, totals, type Ticket } from '@shop/domain';
import { normalPlate, phoneDigits } from '@shop/invomax';
import { BadInput, NotFound } from '../errors';
import { TicketStore } from '../store';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invoice_finals (
  ticket_id INTEGER PRIMARY KEY,
  invoice_no TEXT UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('invomax','typed','none')),
  linked_at TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  parts INTEGER, labor INTEGER, supplies INTEGER, tax INTEGER, total INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS invoice_unlinked (
  ticket_id INTEGER,
  invoice_no TEXT,
  PRIMARY KEY (ticket_id, invoice_no)
);
`;

export type Candidate = {
  invoice_no: string;
  date: string;
  name: string;
  plate: string;
  total: number;
  why: 'plate' | 'phone';
};

export type NeedsBill = {
  ticket_id: number;
  name: string;
  vehicle: string;
  plate: string;
  filled: string;
  /** Parts + labor on the ticket, in cents. */
  subtotal: number;
  candidates: Candidate[];
};

export type TypedFinal = {
  invoice_no?: string;
  parts: number;
  labor: number;
  supplies: number;
  tax: number;
  total: number;
};

type Bill = { invoice_no: string; date: string; name: string; phone: string; plate: string; total: number };

const AUTO_BEFORE = 1;
const AUTO_AFTER = 3;
const NEAR_DAYS = 14;
const MAX_CANDIDATES = 5;

const ymd = (d: Date): string =>
  `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** `day` (YYYY-MM-DD) moved by `n` days, on the local calendar. */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
}

const filledDay = (t: Ticket): string => t.updated.slice(0, 10);

export class LinkStore {
  private readonly tickets: TicketStore;

  constructor(
    private readonly db: DatabaseSync,
    private readonly im: DatabaseSync,
  ) {
    this.db.exec(SCHEMA);
    this.tickets = new TicketStore(db);
  }

  /** Filled tickets with no invoice_finals row, newest filled first. */
  private unlinkedFilled(): Ticket[] {
    const have = new Set(
      (this.db.prepare('SELECT ticket_id FROM invoice_finals').all() as { ticket_id: number }[]).map((r) => r.ticket_id),
    );
    return this.tickets
      .list(['filled'])
      .filter((t) => !have.has(t.id))
      .sort((a, b) => b.updated.localeCompare(a.updated) || b.id - a.id);
  }

  private taken(): Set<string> {
    const rows = this.db.prepare('SELECT invoice_no FROM invoice_finals WHERE invoice_no IS NOT NULL').all();
    return new Set((rows as { invoice_no: string }[]).map((r) => r.invoice_no));
  }

  /** "ticket|bill" pairs an admin unlinked. */
  private unlinkedPairs(): Set<string> {
    const rows = this.db.prepare('SELECT ticket_id, invoice_no FROM invoice_unlinked').all();
    return new Set((rows as { ticket_id: number; invoice_no: string }[]).map((r) => `${r.ticket_id}|${r.invoice_no}`));
  }

  /** Non-gone bills dated from `from` to `to` (uses the date index). */
  private billsBetween(from: string, to: string): Bill[] {
    return this.im
      .prepare(
        `SELECT invoice_no, "date" AS date, name, phone, plate, total FROM im_invoices
         WHERE "date" BETWEEN ? AND ? AND gone_at = ''`,
      )
      .all(from, to) as Bill[];
  }

  private transaction<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = f();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Links each filled, unlinked ticket that has exactly one free bill with its plate dated from the day before
   * it was filled to three days after. Tickets are taken oldest first and a bill goes to one ticket only.
   * Returns the number linked.
   */
  autoLink(now: Date): number {
    return this.transaction(() => {
      const taken = this.taken();
      const unlinked = this.unlinkedPairs();
      const at = nowIso(now);
      const insert = this.db.prepare(
        "INSERT INTO invoice_finals (ticket_id, invoice_no, source, linked_at, linked_by) VALUES (?, ?, 'invomax', ?, 'auto')",
      );
      let n = 0;
      for (const t of this.unlinkedFilled().reverse()) {
        const plate = normalPlate(t.plate);
        if (!plate) continue;
        const day = filledDay(t);
        const hits = this.billsBetween(addDays(day, -AUTO_BEFORE), addDays(day, AUTO_AFTER)).filter(
          (b) => normalPlate(b.plate) === plate && !taken.has(b.invoice_no) && !unlinked.has(`${t.id}|${b.invoice_no}`),
        );
        if (hits.length !== 1) continue;
        insert.run(t.id, hits[0].invoice_no, at);
        taken.add(hits[0].invoice_no);
        n++;
      }
      return n;
    });
  }

  /** Filled tickets with no final yet, newest filled first, each with up to 5 bills that might be theirs. */
  needsBill(): NeedsBill[] {
    const taken = this.taken();
    const unlinked = this.unlinkedPairs();
    return this.unlinkedFilled().map((t) => {
      const day = filledDay(t);
      const plate = normalPlate(t.plate);
      const phone = phoneDigits(t.phone);
      const subtotal = Math.round(totals(t).total * 100);
      const candidates: Candidate[] = [];
      for (const b of this.billsBetween(addDays(day, -NEAR_DAYS), addDays(day, NEAR_DAYS))) {
        if (taken.has(b.invoice_no) || unlinked.has(`${t.id}|${b.invoice_no}`)) continue;
        const why = plate && normalPlate(b.plate) === plate ? 'plate' : phone && b.phone === phone ? 'phone' : null;
        if (why) candidates.push({ invoice_no: b.invoice_no, date: b.date, name: b.name, plate: b.plate, total: b.total, why });
      }
      candidates.sort(
        (a, b) => Math.abs(a.total - subtotal) - Math.abs(b.total - subtotal) || a.invoice_no.localeCompare(b.invoice_no),
      );
      return {
        ticket_id: t.id,
        name: `${t.first} ${t.last}`.trim(),
        vehicle: [t.year, t.make, t.model].filter(Boolean).join(' '),
        plate: t.plate,
        filled: day,
        subtotal,
        candidates: candidates.slice(0, MAX_CANDIDATES),
      };
    });
  }

  private filled(ticketId: number): void {
    const t = this.tickets.get(ticketId);
    if (t?.status !== 'filled') throw new NotFound(`no filled ticket ${ticketId}`);
  }

  private checkFree(ticketId: number, invoiceNo: string): void {
    const row = this.db
      .prepare('SELECT ticket_id FROM invoice_finals WHERE invoice_no = ? AND ticket_id != ?')
      .get(invoiceNo, ticketId) as { ticket_id: number } | undefined;
    if (row) throw new Refused(`that bill is linked to ticket ${row.ticket_id}`);
  }

  /** Writes the ticket's row: a new one, or over the old with version + 1. */
  private put(ticketId: number, invoiceNo: string | null, source: string, by: string, m?: TypedFinal): void {
    this.db
      .prepare(
        `INSERT INTO invoice_finals (ticket_id, invoice_no, source, linked_at, linked_by, parts, labor, supplies, tax, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ticket_id) DO UPDATE SET invoice_no = excluded.invoice_no, source = excluded.source,
           linked_at = excluded.linked_at, linked_by = excluded.linked_by, parts = excluded.parts,
           labor = excluded.labor, supplies = excluded.supplies, tax = excluded.tax, total = excluded.total,
           version = version + 1`,
      )
      .run(
        ticketId,
        invoiceNo,
        source,
        nowIso(),
        by,
        m?.parts ?? null,
        m?.labor ?? null,
        m?.supplies ?? null,
        m?.tax ?? null,
        m?.total ?? null,
      );
  }

  /** Ties the ticket to the bill. Refused if another ticket has it; NotFound if either is missing. */
  link(ticketId: number, invoiceNo: string, by: string): void {
    this.transaction(() => {
      this.filled(ticketId);
      const bill = this.im.prepare("SELECT 1 AS ok FROM im_invoices WHERE invoice_no = ? AND gone_at = ''").get(invoiceNo);
      if (!bill) throw new NotFound(`no bill ${invoiceNo}`);
      this.checkFree(ticketId, invoiceNo);
      this.db.prepare('DELETE FROM invoice_unlinked WHERE ticket_id = ? AND invoice_no = ?').run(ticketId, invoiceNo);
      this.put(ticketId, invoiceNo, 'invomax', by);
    });
  }

  /** Drops the ticket's final; a linked bill is remembered so autoLink won't pick that pair again. */
  unlink(ticketId: number, by: string): void {
    void by; // who unlinked is not kept: invoice_unlinked has no column for it
    this.transaction(() => {
      const row = this.db.prepare('SELECT invoice_no, source FROM invoice_finals WHERE ticket_id = ?').get(ticketId) as
        | { invoice_no: string | null; source: string }
        | undefined;
      if (!row) throw new NotFound(`ticket ${ticketId} has no link`);
      this.db.prepare('DELETE FROM invoice_finals WHERE ticket_id = ?').run(ticketId);
      if (row.source === 'invomax' && row.invoice_no)
        this.db
          .prepare('INSERT OR IGNORE INTO invoice_unlinked (ticket_id, invoice_no) VALUES (?, ?)')
          .run(ticketId, row.invoice_no);
    });
  }

  /** The ticket has no bill in InvoMax. */
  markNone(ticketId: number, by: string): void {
    this.transaction(() => {
      this.filled(ticketId);
      this.put(ticketId, null, 'none', by);
    });
  }

  /**
   * The bill typed in by hand. `version` is the stored row's (null: no row yet); any other is
   * Refused('changed on another device').
   */
  typedFinal(ticketId: number, n: TypedFinal, version: number | null, by: string): void {
    for (const k of ['parts', 'labor', 'supplies', 'tax', 'total'] as const)
      if (!Number.isInteger(n[k])) throw new BadInput(`${k} must be whole cents`);
    this.transaction(() => {
      this.filled(ticketId);
      const row = this.db.prepare('SELECT version FROM invoice_finals WHERE ticket_id = ?').get(ticketId) as
        | { version: number }
        | undefined;
      if ((row?.version ?? null) !== version) throw new Refused('changed on another device');
      const no = n.invoice_no?.trim() || null;
      if (no) this.checkFree(ticketId, no);
      this.put(ticketId, no, 'typed', by, n);
    });
  }
}
