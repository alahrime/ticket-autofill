// Deleting a ticket (the desk, or a mechanic for one they may see), restoring it, and when the purge removes it.
import { nowIso } from './clean.js';
import { MOVES, Refused, type Ticket } from './ticket.js';

export const PURGE_DAYS = 14;
/** Deleted from one of these, a ticket is removed for good PURGE_DAYS later; an invoice is kept. */
export const PURGED_FROM: readonly string[] = ['waiting', 'working', 'review'];
/** The live statuses (everything a move can reach); `deleted` is not one of them. */
export const STATUSES: ReadonlySet<string> = new Set([...MOVES].flatMap((m) => m.split('>')));

const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/;
const DAY = (d: Date): string => nowIso(d).slice(0, 10);

/** Marks `t` deleted in place, remembering where it was. by: "role#id"; now: as `updated`. */
export function markDeleted(t: Ticket, by: string, now: string): Ticket {
  if (t.status === 'deleted') throw new Refused('already deleted');
  t.deleted_from = t.status;
  t.deleted_at = now;
  t.deleted_by = by;
  t.status = 'deleted';
  return t;
}

/** Puts a deleted `t` back where it was, in place, and clears the three fields. */
export function restore(t: Ticket): Ticket {
  if (t.status !== 'deleted') throw new Refused("it isn't deleted");
  if (!STATUSES.has(t.deleted_from)) throw new Refused("can't tell where it was"); // not deleted by this server
  t.status = t.deleted_from;
  t.deleted_at = '';
  t.deleted_by = '';
  t.deleted_from = '';
  return t;
}

/**
 * The local time PURGE_DAYS calendar days after deleted_at, or null when it isn't one the purge takes: not
 * deleted, deleted as an invoice (approved / filled), or holding any deposit (R10: a customer who paid may come
 * back after the 14 days when parts are delayed). `held`: whether the stored deposits hold one (holdsDeposits).
 */
function purgeTime(t: Ticket, held: boolean): Date | null {
  if (t.status !== 'deleted' || !PURGED_FROM.includes(t.deleted_from) || !TIME.test(t.deleted_at)) return null;
  if (held) return null; // R10: kept until the desk restores it
  const d = new Date(t.deleted_at); // no offset: local time
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + PURGE_DAYS);
  return d;
}

/**
 * Whether a `deposits` value, as stored, holds (or may hold) a deposit. Only a missing key (undefined) or an
 * empty list is deposit-free: anything else (a list with items, null, one object, text) fails safe, so a damaged
 * row is kept, never purged. The store passes the raw JSON value, before its defaults turn junk into [].
 */
export const holdsDeposits = (stored: unknown): boolean =>
  stored !== undefined && !(Array.isArray(stored) && stored.length === 0);

/**
 * The day the purge removes `t` (YYYY-MM-DD), or null when it never will (an invoice, a deposit, not deleted).
 * held: whether its stored deposits hold one; by default judged from t.deposits.
 */
export const purgeOn = (t: Ticket, held: boolean = holdsDeposits(t.deposits)): string | null => {
  const d = purgeTime(t, held);
  return d ? DAY(d) : null;
};

/**
 * True when `t` was deleted unfinished, with no deposit, PURGE_DAYS or more before `now`. held: as purgeOn.
 * Throws RangeError for an invalid now.
 */
export function purgeable(t: Ticket, now: Date, held: boolean = holdsDeposits(t.deposits)): boolean {
  if (Number.isNaN(now.getTime())) throw new RangeError('invalid clock'); // never "everything is old enough"
  const d = purgeTime(t, held);
  return d !== null && d.getTime() <= now.getTime();
}
