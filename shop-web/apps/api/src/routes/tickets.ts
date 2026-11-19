// The ticket JSON API (shop.py: get()'s /api/tickets routes, post()'s create, ticket(), move(), mechanic_named).
// Every route finds the session first, then checks the role and what that caller may see before it reads or
// writes a ticket.
import { createHash } from 'node:crypto';
import {
  type Request,
  type Response,
  Router,
} from 'express';
import {
  edit,
  Invalid,
  markDeleted,
  move,
  nowIso,
  Refused,
  restore,
  squash,
  Stale,
  STATUSES,
  type Ticket,
} from '@shop/domain';
import { type Accounts, casefold, type Session } from '../accounts';
import { BadInput } from '../errors';
import { validRequest } from '../http/contract';
import { depsOf } from '../http/deps';
import { validId } from '../http/ids';
import { jsonBody } from '../http/security';
import { asJson, mine, queryValues, reach, sees, sessionIn, signedIn } from '../view';

export const MAX_NOTE = 2000;
export const MAX_MADE = 500; // create tokens remembered
export const MAX_ECHO = 20; // of a `to` that isn't a status, at most this much comes back in the message
const GONE = { error: 'removed by the desk' }; // 410: a mechanic's ticket the desk (or they) deleted
const WHO = { admin: 'desk', mechanic: 'mechanic' } as const; // tickets.edit rules by role
/** What a mechanic's check-in may fill (shop.py's KIOSK, the retired iPad's fields). */
export const CHECKIN = [
  'first',
  'last',
  'phone',
  'year',
  'make',
  'model',
  'plate',
  'request',
] as const;

type Body = Record<string, unknown>;

/** Python's len(): code points. */
const pyLen = (s: string): number => [...s].length;

/** Two names the same once spaces are squashed and case folded. */
const same = (a: unknown, b: unknown): boolean =>
  casefold(squash(a)) === casefold(squash(b));

/** The active mechanic account `name` names, in the account's spelling; undefined if none. */
const activeMechanic = (
  accounts: Accounts,
  name: unknown,
): string | undefined =>
  typeof name === 'string'
    ? accounts.list('mechanic', true).find((u) => same(u.name, name))?.name
    : undefined;

/**
 * The active mechanic account `name` names, in the account's spelling (or `keep`, a ticket's current
 * mechanic, when it names that); else Invalid({mechanic}).
 */
export function mechanicNamed(
  accounts: Accounts,
  name: unknown,
  keep = '',
): string {
  if (typeof name === 'string' && keep && same(name, keep)) return keep;
  const found = activeMechanic(accounts, name);
  if (found === undefined)
    throw new Invalid({ mechanic: 'pick a mechanic from the list' });
  return found;
}

/** A status move's checks (shop.py move()): the mechanic only accepts and finishes, as themselves. */
function moveTicket(accounts: Accounts, s: Session, t: Ticket, d: Body): void {
  const to = d['to'];
  const note = d['note'] as unknown;
  let mechanic: unknown = d['mechanic'];
  if (typeof to !== 'string') throw new BadInput('to must be a status');
  // only a real status is echoed whole; anything else (refused by move below) at most MAX_ECHO characters
  const toShown = STATUSES.has(to) || to === 'deleted' ? to : [...to].slice(0, MAX_ECHO).join('');
  if (note !== undefined && note !== null && typeof note !== 'string')
    throw new BadInput('note must be text');
  if (pyLen((note as string | null | undefined) ?? '') > MAX_NOTE)
    throw new BadInput(`note is too long (max ${MAX_NOTE})`);
  if (s.role === 'mechanic') {
    const step = `${t.status}>${to}`;
    if (step !== 'waiting>working' && step !== 'working>review')
      throw new Refused('only the desk can do that');
    mechanic = s.name; // accepting: always as themselves
  } else if (t.status === 'waiting' && to === 'working') {
    // the desk accepting for a mechanic: an active account
    mechanic = activeMechanic(accounts, mechanic);
    if (mechanic === undefined)
      throw new BadInput('pick a mechanic from the list');
  }
  move(
    t,
    toShown, // never 'deleted': no move reaches it (only the delete route)
    typeof mechanic === 'string' ? mechanic : null,
    (note as string | null | undefined) || '',
  );
}

/** What a change of one ticket does. */
type Change = 'edit' | 'move' | 'delete' | 'restore';

/** 404 or 410 for a ticket this caller may not open (reach), with `missing` as the 404's message; true if sent. */
function unreachable(res: Response, s: Session, t: Ticket | null, missing: string): boolean {
  const r = t ? reach(s, t) : 'hidden';
  if (r === 'ok') return false;
  if (r === 'gone') res.status(410).json(GONE);
  else res.status(404).json({ error: missing });
  return true;
}

/**
 * An edit, move, delete or restore of ticket `id` (shop.py ticket()): 409 with the stored ticket on Stale /
 * Refused. A deleted ticket is the desk's to restore and nothing else (409); a mechanic gets 410 or 404 for one.
 * A mechanic deletes any ticket they may open; edits and moves only their own (or accepts a waiting one).
 */
function changeTicket(
  req: Request,
  res: Response,
  id: number,
  change: Change,
): void {
  const { store, accounts } = depsOf(req);
  const s = sessionIn(res);
  const role = s.role as keyof typeof WHO;
  const d: Body = { ...(req.body as Body) };
  delete d['who']; // the session says who, never the body
  const version = d['version'];
  delete d['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version))
    throw new BadInput('version must be a whole number');
  const t = store.get(id);
  if (unreachable(res, s, t, 'no such ticket') || !t) return;
  const deleted = t.status === 'deleted'; // only the desk gets this far with one
  if (
    s.role === 'mechanic' &&
    change !== 'delete' &&
    !(mine(s, t) || (change === 'move' && t.status === 'waiting'))
  )
    return void res.status(403).json({ error: 'not allowed' }); // someone else's job (or waiting: only accepting it)
  if (s.role === 'admin' && change === 'edit' && !deleted && Object.hasOwn(d, 'mechanic'))
    d['mechanic'] = mechanicNamed(accounts, d['mechanic'], t.mechanic); // an active account, or left as it is
  try {
    if (deleted && (change === 'edit' || change === 'move'))
      throw new Refused("can't change a deleted ticket"); // restore it first
    if (t.version !== version) throw new Stale(t); // edit the copy the device saw, or not at all
    if (change === 'move') moveTicket(accounts, s, t, d);
    else if (change === 'edit') edit(t, d, WHO[role]);
    else if (change === 'delete') markDeleted(t, `${s.role}#${s.user_id}`, nowIso());
    else restore(t);
    res.json(asJson(store.save(t, version), role));
  } catch (e) {
    if (!(e instanceof Stale || e instanceof Refused)) throw e;
    const now = e instanceof Stale ? e.ticket : store.get(t.id); // the stored one, unedited
    if (unreachable(res, s, now, 'no such ticket') || !now) return; // gone, someone else's now, or deleted meanwhile
    res.status(409).json({ error: e.message, ticket: asJson(now, role) });
  }
}

const idOf = (req: Request): number => Number(req.params['id']);

/** The routes; the create-token memory lives in this router. */
export function ticketRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  // (user id, the page's token) -> [ticket id, its created time]: a re-sent create isn't a second ticket. Oldest
  // first. The purge frees ids for reuse (INTEGER PRIMARY KEY, no AUTOINCREMENT), so a ticket under that id with
  // another created time isn't the one the token made.
  const made = new Map<string, [number, string]>();

  r.get('/api/tickets', signedIn('admin', 'mechanic'), validRequest, (req, res) => {
    const s = sessionIn(res);
    const asked = queryValues(req.originalUrl, 'status');
    const want = asked.length
      ? asked
          .join(',')
          .split(',')
          // deleted ones only for the desk, and only when it asks for them
          .filter((x) => STATUSES.has(x) || (x === 'deleted' && s.role === 'admin'))
      : null;
    const found = (
      want === null
        ? depsOf(req).store.list()
        : want.length
          ? depsOf(req).store.list(want)
          : []
    ).filter((t) => sees(s, t));
    const key = JSON.stringify([
      s.role,
      s.user_id,
      want,
      found.map((t) => [t.id, t.version]),
    ]);
    const tag = `"${createHash('sha256').update(key).digest('hex').slice(0, 32)}"`;
    res.setHeader('ETag', tag);
    // the pages poll every 4 s: nothing changed, nothing sent
    if (req.headers['if-none-match'] === tag) return void res.status(304).end();
    res.json({
      tickets: found.map((t) =>
        // judged on the deposits as stored, as the purge does: a damaged value means kept (null)
        t.status === 'deleted' ? { ...asJson(t, s.role), purge_on: depsOf(req).store.purgeOn(t) } : asJson(t, s.role),
      ),
    });
  });

  r.get(
    '/api/tickets/:id',
    signedIn('admin', 'mechanic'),
    validId,
    (req, res) => {
      const s = sessionIn(res);
      const t = depsOf(req).store.get(idOf(req));
      if (unreachable(res, s, t, 'not found') || !t) return;
      res.json(asJson(t, s.role));
    },
  );

  // the desk may type the whole invoice at once; a mechanic checks a customer in (their first details only)
  r.post('/api/tickets', signedIn('admin', 'mechanic'), jsonBody, validRequest, (req, res) => {
    const { store, accounts } = depsOf(req);
    const s = sessionIn(res);
    const body = req.body as Body;
    let d: Body;
    if (s.role === 'mechanic') {
      // waiting and unassigned: every other key (mechanic, status, lines, deposits...) is dropped
      d = Object.fromEntries(
        CHECKIN.filter((k) => Object.hasOwn(body, k)).map((k) => [k, body[k]]),
      );
    } else {
      d = { ...body };
      delete d['token'];
      if (
        d['mechanic'] === undefined ||
        d['mechanic'] === null ||
        d['mechanic'] === ''
      )
        delete d['mechanic']; // not assigned yet
      else d['mechanic'] = mechanicNamed(accounts, d['mechanic']);
    }
    // the page sends one per new ticket; the same one again (its reply got lost) is that ticket
    const tok = body['token'];
    const key =
      typeof tok === 'string' && pyLen(tok) >= 8 && pyLen(tok) <= 64
        ? JSON.stringify([s.user_id, tok])
        : null;
    const known = key === null ? undefined : made.get(key);
    let t = known === undefined ? null : store.get(known[0]);
    if (t && t.created !== known?.[1]) t = null; // purged, and the id taken again since: a miss
    // a replay answers as GET /api/tickets/:id would: a check-in the desk gave someone else is theirs now, and a
    // deleted one stays deleted (the desk's: 200; the mechanic's: 410), never made again
    if (t && unreachable(res, s, t, 'not found')) return;
    if (!t) {
      t = store.create(d);
      if (key !== null) {
        made.delete(key); // the newest again
        made.set(key, [t.id, t.created]);
        for (const old of made.keys()) {
          if (made.size <= MAX_MADE) break;
          made.delete(old);
        }
      }
    }
    res.json(asJson(t, s.role));
  });

  const staff = signedIn('admin', 'mechanic');
  r.post('/api/tickets/:id', staff, validId, jsonBody, validRequest, (req, res) =>
    changeTicket(req, res, idOf(req), 'edit'),
  );
  r.post('/api/tickets/:id/move', staff, validId, jsonBody, validRequest, (req, res) =>
    changeTicket(req, res, idOf(req), 'move'),
  );
  r.post('/api/tickets/:id/delete', staff, validId, jsonBody, validRequest, (req, res) =>
    changeTicket(req, res, idOf(req), 'delete'),
  );
  r.post('/api/tickets/:id/restore', signedIn('admin'), validId, jsonBody, validRequest, (req, res) =>
    changeTicket(req, res, idOf(req), 'restore'),
  );
  return r;
}
