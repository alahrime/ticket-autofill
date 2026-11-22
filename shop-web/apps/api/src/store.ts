// Tickets in SQLite, shared with Python's tickets.Store: id, indexed status, the rest as JSON.
import type { DatabaseSync } from 'node:sqlite';
import {
  type Deposit,
  Invalid,
  type Line,
  newTicket,
  normalize,
  nowIso,
  holdsDeposits,
  purgeable,
  purgeOn,
  Stale,
  type Ticket,
} from '@shop/domain';
import { NotFound } from './errors';
import { pyDumps } from './py-json';

type Row = { id: number; status: string; data: string };
type Json = Record<string, unknown>;

// Dataclass defaults, in field order: spreading stored JSON over them fills what old rows lack (as
// tickets.from_dict does) and keeps Python's key order, with unknown keys after the known ones.
const lineDefaults = (): Json => ({ desc: undefined, qty: 1, price: null, labor: null, code: '', id: 0 });
const depositDefaults = (): Json => ({ amount: undefined, method: 'cash', date: '', note: '', id: 0 });

const items = <T>(list: unknown, defaults: () => Json): T[] =>
  Array.isArray(list) ? list.map((x) => ({ ...defaults(), ...(x as Json) }) as T) : [];

/** Dataclass defaults and order under `d`; unknown keys kept. */
function complete(d: Json): Ticket {
  const t = { ...newTicket({}, ''), ...d } as Ticket;
  t.lines = items<Line>(t.lines, lineDefaults);
  t.deposits = items<Deposit>(t.deposits, depositDefaults);
  return t;
}

// Per ticket read: whether its stored deposits hold one, judged on the raw JSON before complete() turns a
// damaged value (null, one object, text) into []. R10 fails safe on it: such a row is kept, never purged.
const heldDeposits = new WeakMap<Ticket, boolean>();

/** True unless the stored data is an object whose deposits key is missing or an empty list. */
const rawHolds = (raw: unknown): boolean =>
  typeof raw !== 'object' || raw === null || Array.isArray(raw) || holdsDeposits((raw as Json)['deposits']);

function fromRow(row: Row): Ticket {
  const raw = JSON.parse(row.data) as unknown;
  const t = complete({ ...(raw as Json), id: row.id, status: row.status });
  heldDeposits.set(t, rawHolds(raw));
  return t;
}

/** Whether `t`'s deposits, as stored, hold one. A ticket the store never read or wrote fails closed: it does. */
const holds = (t: Ticket): boolean => heldDeposits.get(t) ?? true;

/** A stored deposits value this side can't read (present, not a list), to write back as it was; else undefined. */
function unreadDeposits(data: string): { value: unknown } | undefined {
  const raw = JSON.parse(data) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  if (!Object.hasOwn(raw, 'deposits')) return undefined;
  const value = (raw as Json)['deposits'];
  return Array.isArray(value) ? undefined : { value };
}

/**
 * The data column: every field but id and status, unknown keys included, as Python's json.dumps. `keep`: a
 * stored deposits value to write back verbatim (R12) in place of t.deposits, which shows it as [].
 */
function toData(t: Ticket, keep?: { value: unknown }): string {
  const d: Json = complete(t);
  delete d['id'];
  delete d['status'];
  if (keep) d['deposits'] = keep.value;
  return pyDumps(d);
}

/** save()'s options. depositsSent: the desk's edit set deposits from a validated list, which replaces any. */
export type SaveOpts = { depositsSent?: boolean };

const SELECT = 'SELECT id, status, data FROM tickets';

export class TicketStore {
  constructor(private readonly db: DatabaseSync) {}

  /** New waiting ticket from desk fields; throws Invalid. */
  create(fields: Record<string, unknown>): Ticket {
    const { clean, errors } = normalize(fields, { create: true });
    if (Object.keys(errors).length) throw new Invalid(errors);
    const t = newTicket(clean, nowIso());
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO tickets (status, data) VALUES (?, ?)')
      .run(t.status, toData(t));
    t.id = Number(lastInsertRowid);
    heldDeposits.set(t, holdsDeposits(t.deposits)); // stored as written: normalize's list
    return t;
  }

  get(id: number): Ticket | null {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** A cheap stamp of the filled tickets (count, newest update, version total); another process's writes change it too. */
  filledMarker(): string {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n, MAX(json_extract(data, '$.updated')) AS u, SUM(json_extract(data, '$.version')) AS v FROM tickets WHERE status = 'filled'",
      )
      .get() as { n: number; u: string | null; v: number | null };
    return `${r.n}|${r.u ?? ''}|${r.v ?? 0}`;
  }

  /** Newest first; no statuses (or an empty list, as in Python) = all but deleted ones (those only when asked). */
  list(statuses?: string[]): Ticket[] {
    const where = statuses?.length
      ? ` WHERE status IN (${statuses.map(() => '?').join(', ')})`
      : " WHERE status != 'deleted'";
    const rows = this.db.prepare(`${SELECT}${where} ORDER BY id DESC`).all(...(statuses ?? [])) as Row[];
    return rows.map(fromRow);
  }

  /**
   * Writes `t` if `version` is the stored one, else throws Stale with the stored ticket (NotFound for an
   * unknown id). Check and write are one transaction, so Python's process can't slip a save in between.
   * Returns `t` with version + 1, the new updated time and the stored created time.
   *
   * R12: a stored deposits value that isn't a list (damaged, or written by something else) is written back
   * verbatim, as read in this transaction, unless opts.depositsSent (the desk sent a validated list, which
   * replaces it). The reply still shows it as []; the purge keeps such a ticket (R10).
   */
  save(t: Ticket, version: number, opts: SaveOpts = {}): Ticket {
    this.db.exec('BEGIN IMMEDIATE'); // takes the write lock first (busy_timeout: waits up to 5 s)
    let saved: Ticket;
    let keep: { value: unknown } | undefined;
    try {
      const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(t.id) as Row | undefined;
      if (!row) throw new NotFound(`no ticket ${t.id}`);
      const cur = fromRow(row);
      if (cur.version !== version) throw new Stale(cur);
      keep = opts.depositsSent ? undefined : unreadDeposits(row.data);
      saved = { ...t, version: version + 1, updated: nowIso(), created: cur.created };
      this.db
        .prepare('UPDATE tickets SET status = ?, data = ? WHERE id = ?')
        .run(saved.status, toData(saved, keep), saved.id);
      this.db.exec('COMMIT');
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK'); // a failed COMMIT may have ended it already
      throw e;
    }
    t.version = saved.version;
    t.updated = saved.updated;
    t.created = saved.created;
    heldDeposits.set(t, holdsDeposits(keep ? keep.value : t.deposits)); // as stored now
    return t;
  }

  /** The day the purge removes `t` (YYYY-MM-DD), or null: judged on its deposits as stored, as purge() does. */
  purgeOn(t: Ticket): string | null {
    return purgeOn(t, holds(t));
  }

  /**
   * Removes for good the deleted tickets `purgeable` at `now`, in one transaction; the number removed. Only rows
   * whose status column is 'deleted' are read or removed; one whose JSON won't parse is left alone. Each row is
   * judged as parsed inside the transaction, so a deposit added since (R10) keeps it. The row holding MAX(id) is
   * never removed: SQLite hands out MAX(id) + 1 (no AUTOINCREMENT), so keeping it means no id is ever given to a
   * second ticket while a phone, the desk or the shop PC still holds the old one. A later run takes it once a
   * newer ticket exists.
   */
  purge(now: Date): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { top } = this.db.prepare('SELECT MAX(id) AS top FROM tickets').get() as { top: number | null };
      const rows = this.db.prepare(`${SELECT} WHERE status = 'deleted' AND id < ?`).all(top ?? 0) as Row[];
      const gone = rows.filter((row) => {
        let t: Ticket;
        try {
          t = fromRow(row);
        } catch {
          return false; // not ours to judge
        }
        return purgeable(t, now, holds(t)); // the raw stored deposits, read in this transaction (R10)
      });
      const del = this.db.prepare("DELETE FROM tickets WHERE id = ? AND status = 'deleted'");
      let n = 0;
      for (const row of gone) n += Number(del.run(row.id).changes);
      this.db.exec('COMMIT');
      return n;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
