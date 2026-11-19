// What a signed-in caller may see of a ticket (shop.py: as_json, sees, mine) and the guard that finds them.
import type { RequestHandler, Response } from 'express';
import {
  type Deposit,
  type Line,
  type Ticket,
  totals,
  vinWarning,
} from '@shop/domain';
import type { Session } from './accounts';
import { noteActor } from './http/log';
import { sessionOf } from './http/security';

// tickets.Ticket / Line / Deposit fields in dataclass order: asdict() shows these and nothing else
const TICKET_FIELDS = [
  'id',
  'status',
  'first',
  'last',
  'phone',
  'year',
  'make',
  'model',
  'plate',
  'request',
  'mechanic',
  'odometer',
  'vin',
  'notes',
  'lines',
  'deposits',
  'back_note',
  'mech_edit',
  'created',
  'updated',
  'version',
  'deleted_at',
  'deleted_by',
  'deleted_from',
] as const;
const LINE_FIELDS = ['desc', 'qty', 'price', 'labor', 'code', 'id'] as const;
const DEPOSIT_FIELDS = ['amount', 'method', 'date', 'note', 'id'] as const;

type Json = Record<string, unknown>;

const pick = (o: object, keys: readonly string[]): Json =>
  Object.fromEntries(keys.map((k) => [k, (o as Json)[k]]));

/**
 * A ticket for the page: the admin sees everything; a mechanic no deposits, nor what was paid.
 * vin_warning is worked out here, not stored, so both pages say the same. Unknown stored keys stay out.
 */
export function asJson(t: Ticket, role: string): Json {
  const d = pick(t, TICKET_FIELDS);
  d['lines'] = t.lines.map((ln: Line) => pick(ln, LINE_FIELDS));
  d['deposits'] = t.deposits.map((x: Deposit) => pick(x, DEPOSIT_FIELDS));
  const tot = totals(t);
  if (role !== 'admin') {
    delete d['deposits'];
    return {
      ...d,
      totals: { parts: tot.parts, labor: tot.labor, total: tot.total },
      vin_warning: vinWarning(t.vin),
    };
  }
  return { ...d, totals: tot, vin_warning: vinWarning(t.vin) };
}

/** Exact: accepting and the desk always write the account's own spelling. */
export const mine = (s: Session, t: Ticket): boolean =>
  s.role === 'mechanic' && t.mechanic === s.name;

/**
 * Admin: every ticket. Mechanic: waiting ones nobody else was given, and their own working and approved
 * ones (one ticket: also their own in review). Any other role: nothing.
 */
export function sees(s: Session, t: Ticket, one = false): boolean {
  if (s.role === 'admin') return true;
  if (s.role !== 'mechanic') return false;
  if (t.status === 'waiting') return !t.mechanic || mine(s, t);
  return (
    mine(s, t) &&
    (one
      ? ['working', 'approved', 'review']
      : ['working', 'approved']
    ).includes(t.status)
  );
}

/**
 * What GET /api/tickets/:id gives this caller: 'ok' (200), 'gone' (410: a mechanic's ticket that would be theirs
 * to see had it not been deleted) or 'hidden' (404). The desk opens a deleted ticket like any other.
 */
export function reach(s: Session, t: Ticket): 'ok' | 'gone' | 'hidden' {
  if (t.status !== 'deleted') return sees(s, t, true) ? 'ok' : 'hidden';
  if (s.role === 'admin') return 'ok';
  return sees(s, { ...t, status: t.deleted_from }, true) ? 'gone' : 'hidden';
}

/** The session signedIn found. */
export const sessionIn = (res: Response): Session =>
  res.locals['session'] as Session;

/**
 * 401 without a live session; 403 when its role isn't one of `roles` (none given: any signed-in role).
 * Otherwise the session goes on res.locals for the route and the log line.
 */
export const signedIn =
  (...roles: string[]): RequestHandler =>
  (req, res, next) => {
    const s = sessionOf(req);
    noteActor(res, s);
    if (!s) return void res.status(401).json({ error: 'sign in' });
    if (roles.length && !roles.includes(s.role))
      return void res.status(403).json({ error: 'not allowed' });
    res.locals['session'] = s;
    next();
  };

/** A query parameter's non-blank values, in order (Python's parse_qs drops blank ones). */
export function queryValues(url: string, name: string): string[] {
  const q = url.indexOf('?');
  return q < 0
    ? []
    : new URLSearchParams(url.slice(q + 1).split('#')[0])
        .getAll(name)
        .filter((v) => v !== '');
}
