// Our own bills (own billing): the invoice number, Approve (number, fill, store) and Fix (a new revision under the
// same number), all in tickets.db. A bill is an invoice_finals row with source 'ours' plus one snapshot per
// revision in own_bill_revisions, only ever inserted: what a reprint prints. Money is integer cents here.
import type { DatabaseSync } from 'node:sqlite';
import {
  billAmounts,
  type BillAmounts,
  billRows,
  type Deposit,
  edit,
  type LaborRow,
  type Line,
  normalize,
  nowIso,
  type PartRow,
  Refused,
  squash,
  Stale,
  type Ticket,
} from '@shop/domain';
import type { Config } from '../config';
import { AlreadyBilled, BadInput, NotConfirmed, NotFound } from '../errors';
import { ensureFinals } from '../history/links';
import { TicketStore } from '../store';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS own_bill_revisions (
  invoice_no TEXT,
  revision INTEGER,
  snapshot TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (invoice_no, revision)
);
CREATE TABLE IF NOT EXISTS own_bill_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_no INTEGER NOT NULL,
  confirmed_at TEXT NOT NULL,
  confirmed_by TEXT NOT NULL
);
`;

/** Everything a bill prints, as stored for one revision (cents). */
export type BillSnapshot = {
  invoice_no: string;
  revision: number;
  /** YYYY-MM-DD, local: the day it was first approved (every revision keeps it). */
  date: string;
  /** HH:MM, 24 h, local: when it was first approved. */
  time: string;
  customer: { first: string; last: string; phone: string };
  vehicle: { year: string; make: string; model: string; plate: string; vin: string; odometer: string };
  mechanic: string;
  labor: LaborRow[];
  parts: PartRow[];
  amounts: BillAmounts;
  shop: Config['shopInfo'];
};

export type BillRevision = { revision: number; at: string; by: string };
type StoredRevision = BillRevision & { snapshot: string };
/** One revision's snapshot, every revision's when and who, and the bill's ticket. */
export type OwnBill = { bill: BillSnapshot; revisions: BillRevision[]; ticket_id: number };

/** InvoMax's bills from this many days back count toward the highest number used. */
export const INVOMAX_DAYS = 400;
/**
 * An InvoMax number more than this far above the median of those window's 7-digit numbers is left out: a typo
 * in InvoMax, not the run. The rule, checked once against the import data (numbers only, kept out of git): the
 * window holds one 7-digit run that grows by about 2000 a year and spans about 2500 numbers, while the odd
 * numbers in the history sit tens of thousands to millions away from their run. So a margin of 10000 keeps the
 * whole run and drops a mistyped jump. The median, not the mean, so one such number can't move it.
 */
export const INVOMAX_OUTLIER = 10_000;
/** Our numbers continue InvoMax's run: 7 digits, no leading zero. */
export const OWN_NO = /^[1-9]\d{6}$/;
// exactly 7 digits (InvoMax's run; the 8-digit outlier and odd numbers are left out)
const SEVEN = "'[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'";

/** Where the highest number used came from: what the first-number dialog shows, so an odd one is caught. */
export type HighestFrom = {
  source: 'invomax' | 'typed' | 'ours' | 'counter' | 'none';
  invoice_no: string | null;
  /** An InvoMax bill's date; else null. */
  date: string | null;
  /** A typed final's or our bill's ticket; else null. */
  ticket_id: number | null;
};

const ymd = (d: Date): string =>
  `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const isCents = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/**
 * The bill's lines, deposits and amounts from the ticket as stored, checked rather than trusted: the raw JSON must
 * hold lists, every line and deposit must pass the ticket rules again, and every amount must be whole cents, 0 or
 * more. Anything else is BadInput: the desk fixes the ticket first. `raw` is the stored data column; `sent`: what
 * a fix replaced with a list the ticket rules checked (its raw value no longer counts).
 */
function billable(
  t: Ticket,
  raw: string,
  sent: { lines?: boolean; deposits?: boolean } = {},
): { lines: Line[]; deposits: Deposit[]; amounts: BillAmounts } {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    d = null;
  }
  const o = d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
  if (!o) throw new BadInput("the ticket's data is damaged: fix it before billing");
  if (!sent.lines && !Array.isArray(o['lines'])) throw new BadInput("the ticket's lines are damaged: fix them before billing");
  if (!sent.deposits && o['deposits'] !== undefined && !Array.isArray(o['deposits']))
    throw new BadInput("the ticket's deposits are damaged: fix them before billing");
  if (!squash(t.mechanic)) throw new BadInput('pick the mechanic before billing');
  if (!t.lines.length) throw new BadInput('add at least one line before billing');
  const { clean, errors } = normalize(
    { lines: t.lines, deposits: t.deposits },
    { kept: new Set(t.deposits.map((x) => x.id)) }, // stored deposits keep their dates
  );
  const bad = errors['lines'] ?? errors['deposits'];
  if (bad || !clean.lines || !clean.deposits) throw new BadInput(`the ticket can't be billed as it is (${bad ?? 'damaged'})`);
  let amounts: BillAmounts;
  try {
    amounts = billAmounts({ lines: clean.lines, deposits: clean.deposits });
  } catch {
    throw new BadInput("the ticket's amounts can't be worked out: fix its lines before billing");
  }
  const { balance, ...rest } = amounts;
  if (!Object.values(rest).every(isCents) || !Number.isSafeInteger(balance))
    throw new BadInput("the ticket's amounts are out of range: fix its lines before billing");
  return { lines: clean.lines, deposits: clean.deposits, amounts };
}

export class OwnBills {
  private readonly tickets: TicketStore;

  /** `db`: tickets.db (the tables are made here if missing); `im`: invomax.db, only read. */
  constructor(
    private readonly db: DatabaseSync,
    private readonly im: DatabaseSync,
    private readonly config: Pick<Config, 'shopInfo'>,
    private readonly clock: () => Date = () => new Date(),
  ) {
    ensureFinals(db);
    db.exec(SCHEMA);
    this.tickets = new TicketStore(db);
  }

  private transaction<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE'); // the write lock first: no other device or process numbers in between
    try {
      const out = f();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private counter(): { next_no: number } | undefined {
    return this.db.prepare('SELECT next_no FROM own_bill_counter WHERE id = 1').get() as { next_no: number } | undefined;
  }

  /**
   * The highest number used and where it came from: InvoMax's exactly-7-digit numbers on bills dated within
   * INVOMAX_DAYS, but none more than INVOMAX_OUTLIER above their median; every all-digit number of a typed final
   * or ours; and the counter's last (next_no - 1). Numbers are text, compared as numbers. `now` dates the window
   * (approve's own time; else the clock). On a tie the first of InvoMax, a final, the counter names it.
   */
  private highestUsed(now: Date = this.clock()): { n: number; from: HighestFrom } {
    const since = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - INVOMAX_DAYS));
    const run = this.im
      .prepare(
        `SELECT CAST(invoice_no AS INTEGER) AS n, invoice_no, "date" AS date FROM im_invoices
         WHERE invoice_no GLOB ${SEVEN} AND "date" >= ? ORDER BY n`,
      )
      .all(since) as { n: number; invoice_no: string; date: string }[];
    const median = run.length ? (run[Math.floor((run.length - 1) / 2)] as { n: number }).n : 0;
    const im = run.filter((r) => r.n <= median + INVOMAX_OUTLIER).at(-1);
    const fin = this.db
      .prepare(
        `SELECT CAST(invoice_no AS INTEGER) AS n, invoice_no, source, ticket_id FROM invoice_finals
         WHERE source IN ('typed', 'ours') AND invoice_no GLOB '[0-9]*' AND invoice_no NOT GLOB '*[^0-9]*'
           AND length(invoice_no) <= 15
         ORDER BY n DESC LIMIT 1`,
      )
      .get() as { n: number; invoice_no: string; source: 'typed' | 'ours'; ticket_id: number } | undefined;
    const next = this.counter()?.next_no;
    let best: { n: number; from: HighestFrom } = { n: 0, from: { source: 'none', invoice_no: null, date: null, ticket_id: null } };
    if (im && im.n > best.n) best = { n: im.n, from: { source: 'invomax', invoice_no: im.invoice_no, date: im.date, ticket_id: null } };
    if (fin && fin.n > best.n)
      best = { n: fin.n, from: { source: fin.source, invoice_no: fin.invoice_no, date: null, ticket_id: fin.ticket_id } };
    if (next !== undefined && next - 1 > best.n)
      best = { n: next - 1, from: { source: 'counter', invoice_no: String(next - 1), date: null, ticket_id: null } };
    return best;
  }

  /** Whether any bill anywhere (InvoMax's, of any date, or a final) already has this number. */
  private taken(no: string): boolean {
    return (
      this.im.prepare('SELECT 1 AS x FROM im_invoices WHERE invoice_no = ?').get(no) !== undefined ||
      this.db.prepare('SELECT 1 AS x FROM invoice_finals WHERE invoice_no = ?').get(no) !== undefined
    );
  }

  /**
   * Whether the first number was confirmed, the number the next bill would get (or the one to propose), and
   * where the highest number used came from.
   */
  firstNumber(): { confirmed: boolean; proposed: string; from: HighestFrom } {
    const high = this.highestUsed();
    return { confirmed: this.counter() !== undefined, proposed: String(high.n + 1), from: high.from };
  }

  /**
   * Confirms the first number, once: BadInput unless 7 digits above the highest used; Refused (409) once
   * confirmed. The import, when on, runs before this (the route's job).
   */
  confirmFirst(no: string, by: string): void {
    if (typeof no !== 'string' || !OWN_NO.test(no)) throw new BadInput('invoice_no must be 7 digits');
    this.transaction(() => {
      if (this.counter()) throw new Refused('the first invoice number is already confirmed');
      const high = this.highestUsed().n;
      if (Number(no) <= high) throw new BadInput(`invoice_no must be above ${high}, the highest number used`);
      this.db
        .prepare('INSERT INTO own_bill_counter (id, next_no, confirmed_at, confirmed_by) VALUES (1, ?, ?, ?)')
        .run(Number(no), nowIso(this.clock()), by);
    });
  }

  /** The next number free everywhere, InvoMax's window dated by `now`; call inside the transaction. */
  private takeNumber(now: Date): string {
    let n = this.highestUsed(now).n + 1;
    while (this.taken(String(n))) n++; // an old InvoMax bill outside the window
    if (!OWN_NO.test(String(n))) throw new BadInput('no 7-digit invoice number is left');
    return String(n);
  }

  /** `when` and `shop`: revision 1's (a fix keeps what the original printed); approve passes its own. */
  private snapshot(
    t: Ticket,
    no: string,
    revision: number,
    when: { date: string; time: string },
    shop: Config['shopInfo'],
    lines: Line[],
    amounts: BillAmounts,
  ): BillSnapshot {
    const rows = billRows(lines);
    return {
      invoice_no: no,
      revision,
      date: when.date,
      time: when.time,
      customer: { first: t.first, last: t.last, phone: t.phone },
      vehicle: { year: t.year, make: t.make, model: t.model, plate: t.plate, vin: t.vin, odometer: t.odometer },
      mechanic: t.mechanic,
      labor: rows.labor,
      parts: rows.parts,
      amounts,
      shop: { ...shop, address: [...shop.address] },
    };
  }

  private putRevision(b: BillSnapshot, at: string, by: string): void {
    this.db
      .prepare('INSERT INTO own_bill_revisions (invoice_no, revision, snapshot, at, by) VALUES (?, ?, ?, ?, ?)')
      .run(b.invoice_no, b.revision, JSON.stringify(b), at, by);
  }

  /** The stored ticket and its raw data column; NotFound if missing. */
  private ticketRow(id: number): { t: Ticket; raw: string } {
    const row = this.db.prepare('SELECT data FROM tickets WHERE id = ?').get(id) as { data: string } | undefined;
    const t = row ? this.tickets.get(id) : null;
    if (!row || !t) throw new NotFound(`no ticket ${id}`);
    return { t, raw: row.data };
  }

  /**
   * Bills the ticket: in one transaction it checks the version, takes the number, saves the ticket as filled,
   * writes the invoice_finals row and revision 1, and moves the counter. NotConfirmed (428) before the first
   * number; AlreadyBilled (409, its number) when the ticket has our bill; Stale for another version; Refused for a
   * filled or deleted ticket; BadInput with no mechanic, no line or lines that won't bill.
   */
  approve(ticketId: number, version: number, by: string, now: Date): BillSnapshot {
    return this.transaction(() => {
      if (!this.counter()) throw new NotConfirmed();
      const { t, raw } = this.ticketRow(ticketId);
      const fin = this.db.prepare('SELECT invoice_no, source FROM invoice_finals WHERE ticket_id = ?').get(ticketId) as
        | { invoice_no: string | null; source: string }
        | undefined;
      if (fin?.source === 'ours' && fin.invoice_no) throw new AlreadyBilled(fin.invoice_no);
      if (t.status === 'deleted') throw new Refused("can't bill a deleted ticket");
      if (t.status === 'filled' || fin) throw new Refused('this ticket is already filled');
      // 1. the version (saveTx checks it again, in this transaction)
      if (t.version !== version) throw new Stale(t);
      const { lines, deposits, amounts } = billable(t, raw);
      // 2. the number
      const no = this.takeNumber(now);
      // 3. the ticket, filled, holding exactly the lines billed
      t.lines = lines;
      t.deposits = deposits;
      t.status = 'filled';
      t.back_note = '';
      this.tickets.saveTx(t, version);
      // 4. the final and revision 1
      const at = nowIso(now);
      const bill = this.snapshot(
        t,
        no,
        1,
        { date: at.slice(0, 10), time: at.slice(11, 16) },
        this.config.shopInfo,
        lines,
        amounts,
      );
      this.db
        .prepare(
          `INSERT INTO invoice_finals (ticket_id, invoice_no, source, linked_at, linked_by, parts, labor, supplies, tax, total)
           VALUES (?, ?, 'ours', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ticketId, no, at, by, amounts.parts, amounts.labor, amounts.supplies, amounts.tax, amounts.total);
      this.putRevision(bill, at, by);
      // 5. the counter
      this.db.prepare('UPDATE own_bill_counter SET next_no = ? WHERE id = 1').run(Number(no) + 1);
      return bill;
    });
  }

  /** Our bill's row: its ticket and the stored final; NotFound unless `no` is ours. */
  private ours(no: string): { ticket_id: number } {
    const row = this.db.prepare("SELECT ticket_id FROM invoice_finals WHERE invoice_no = ? AND source = 'ours'").get(no) as
      | { ticket_id: number }
      | undefined;
    if (!row) throw new NotFound(`no bill ${no}`);
    return row;
  }

  private revisionsOf(no: string): StoredRevision[] {
    return this.db
      .prepare('SELECT revision, at, by, snapshot FROM own_bill_revisions WHERE invoice_no = ? ORDER BY revision')
      .all(no) as StoredRevision[];
  }

  /**
   * A fix: the desk's edit of the billed ticket (as the edit route, a filled ticket allowed), then a new revision
   * under the same number with revision 1's date, time and shop details, and the final's amounts updated, in one transaction.
   * Earlier revisions are never changed. NotFound unless `no` is ours; Stale; Invalid / BadInput as approve.
   */
  fix(no: string, fields: Record<string, unknown>, version: number, by: string, now: Date): BillSnapshot {
    return this.transaction(() => {
      const { ticket_id } = this.ours(no);
      const revs = this.revisionsOf(no);
      const first = revs[0];
      const last = revs[revs.length - 1];
      if (!first || !last) throw new NotFound(`no bill ${no}`);
      const { t, raw } = this.ticketRow(ticket_id);
      if (t.version !== version) throw new Stale(t);
      if (t.status !== 'filled') throw new Refused('this bill\'s ticket is not filled');
      const d: Record<string, unknown> = { ...fields };
      for (const k of ['version', 'who', 'status']) delete d[k];
      const depositsSent = Object.hasOwn(d, 'deposits');
      edit(t, d, 'desk', () => nowIso(now), now, { billFix: true });
      // checked as approve does; lines or deposits sent (checked by edit) replace the stored ones
      const { lines, deposits, amounts } = billable(t, raw, { lines: Object.hasOwn(d, 'lines'), deposits: depositsSent });
      t.lines = lines;
      t.deposits = deposits;
      this.tickets.saveTx(t, version, { depositsSent });
      const was = JSON.parse(first.snapshot) as BillSnapshot;
      const bill = this.snapshot(t, no, last.revision + 1, { date: was.date, time: was.time }, was.shop, lines, amounts);
      const at = nowIso(now);
      this.db
        .prepare(
          `UPDATE invoice_finals SET parts = ?, labor = ?, supplies = ?, tax = ?, total = ?, version = version + 1
           WHERE ticket_id = ? AND source = 'ours'`,
        )
        .run(amounts.parts, amounts.labor, amounts.supplies, amounts.tax, amounts.total, ticket_id);
      this.putRevision(bill, at, by);
      return bill;
    });
  }

  /** The ticket's own bill number (ours, source 'ours'), or null: no bill, or one InvoMax made. */
  ofTicket(ticketId: number): string | null {
    const row = this.db
      .prepare("SELECT invoice_no FROM invoice_finals WHERE ticket_id = ? AND source = 'ours' AND invoice_no IS NOT NULL")
      .get(ticketId) as { invoice_no: string } | undefined;
    return row ? row.invoice_no : null;
  }

  /** Our bill's latest revision, every revision's when and who, and its ticket; null unless `no` is ours. */
  latest(no: string): OwnBill | null {
    return this.read(no, (revs) => revs[revs.length - 1]);
  }

  /**
   * Revision `rev` of our bill as it was stored (what that print showed: read-only), every revision's when and
   * who, and its ticket; null unless `no` is ours and has that revision.
   */
  revision(no: string, rev: number): OwnBill | null {
    return this.read(no, (revs) => revs.find((r) => r.revision === rev));
  }

  private read(no: string, pick: (revs: StoredRevision[]) => StoredRevision | undefined): OwnBill | null {
    const row = this.db.prepare("SELECT ticket_id FROM invoice_finals WHERE invoice_no = ? AND source = 'ours'").get(no) as
      | { ticket_id: number }
      | undefined;
    if (!row) return null;
    const revs = this.revisionsOf(no);
    const got = pick(revs);
    if (!got) return null;
    return {
      bill: JSON.parse(got.snapshot) as BillSnapshot,
      revisions: revs.map(({ revision, at, by }) => ({ revision, at, by })),
      ticket_id: row.ticket_id,
    };
  }
}
