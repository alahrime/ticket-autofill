// The ticket JSON API (shop.py: get()'s /api/tickets routes, post()'s create, ticket(), move(), mechanic_named).
// Every route finds the session first, then checks the role and what that caller may see before it reads or
// writes a ticket.
import { createHash } from 'node:crypto';
import {
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';
import {
  edit,
  Invalid,
  move,
  MOVES,
  Refused,
  squash,
  Stale,
  type Ticket,
} from '@shop/domain';
import { type Accounts, casefold, type Session } from '../accounts';
import { BadInput } from '../errors';
import { depsOf } from '../http/deps';
import { jsonBody } from '../http/security';
import { asJson, mine, queryValues, sees, sessionIn, signedIn } from '../view';

export const MAX_NOTE = 2000;
export const MAX_MADE = 500; // create tokens remembered
const ID = /^[0-9]{1,9}$/;
const STATUSES: ReadonlySet<string> = new Set(
  [...MOVES].flatMap((m) => m.split('>')),
);
const WHO = { admin: 'desk', mechanic: 'mechanic' } as const; // tickets.edit rules by role

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
    to,
    typeof mechanic === 'string' ? mechanic : null,
    (note as string | null | undefined) || '',
  );
}

/** An edit or a move of ticket `id` (shop.py ticket()): 409 with the stored ticket on Stale / Refused. */
function changeTicket(
  req: Request,
  res: Response,
  id: number,
  moving: boolean,
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
  if (!t || !sees(s, t, true))
    return void res.status(404).json({ error: 'no such ticket' });
  if (
    s.role === 'mechanic' &&
    !(mine(s, t) || (moving && t.status === 'waiting'))
  )
    return void res.status(403).json({ error: 'not allowed' }); // someone else's job (or waiting: only accepting it)
  if (s.role === 'admin' && !moving && Object.hasOwn(d, 'mechanic'))
    d['mechanic'] = mechanicNamed(accounts, d['mechanic'], t.mechanic); // an active account, or left as it is
  try {
    if (t.version !== version) throw new Stale(t); // edit the copy the device saw, or not at all
    if (moving) moveTicket(accounts, s, t, d);
    else edit(t, d, WHO[role]);
    res.json(asJson(store.save(t, version), role));
  } catch (e) {
    if (!(e instanceof Stale || e instanceof Refused)) throw e;
    const now = e instanceof Stale ? e.ticket : store.get(t.id); // the stored one, unedited
    if (!now || !sees(s, now, true))
      return void res.status(404).json({ error: 'no such ticket' }); // someone else's now
    res.status(409).json({ error: e.message, ticket: asJson(now, role) });
  }
}

/** On to the next route (in the end, the 404) unless :id is 1 to 9 digits; before any body is read. */
const validId: RequestHandler = (req, _res, next) => {
  const id = req.params['id'];
  next(typeof id === 'string' && ID.test(id) ? undefined : 'route');
};

const idOf = (req: Request): number => Number(req.params['id']);

/** The routes; the create-token memory lives in this router. */
export function ticketRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  // (admin id, the page's token) -> ticket id: a re-sent create isn't a second ticket. Oldest first.
  const made = new Map<string, number>();

  r.get('/api/tickets', signedIn('admin', 'mechanic'), (req, res) => {
    const s = sessionIn(res);
    const asked = queryValues(req.originalUrl, 'status');
    const want = asked.length
      ? asked
          .join(',')
          .split(',')
          .filter((x) => STATUSES.has(x))
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
    res.json({ tickets: found.map((t) => asJson(t, s.role)) });
  });

  r.get(
    '/api/tickets/:id',
    signedIn('admin', 'mechanic'),
    validId,
    (req, res) => {
      const s = sessionIn(res);
      const t = depsOf(req).store.get(idOf(req));
      if (!t || !sees(s, t, true))
        return void res.status(404).json({ error: 'not found' });
      res.json(asJson(t, s.role));
    },
  );

  // the desk may type the whole invoice at once
  r.post('/api/tickets', signedIn('admin'), jsonBody, (req, res) => {
    const { store, accounts } = depsOf(req);
    const s = sessionIn(res);
    const d: Body = { ...(req.body as Body) };
    if (
      d['mechanic'] === undefined ||
      d['mechanic'] === null ||
      d['mechanic'] === ''
    )
      delete d['mechanic']; // not assigned yet
    else d['mechanic'] = mechanicNamed(accounts, d['mechanic']);
    // the page sends one per new ticket; the same one again (its reply got lost) is that ticket
    const tok = d['token'];
    delete d['token'];
    const key =
      typeof tok === 'string' && pyLen(tok) >= 8 && pyLen(tok) <= 64
        ? JSON.stringify([s.user_id, tok])
        : null;
    const known = key === null ? undefined : made.get(key);
    let t = known === undefined ? null : store.get(known);
    if (!t) {
      t = store.create(d);
      if (key !== null) {
        made.set(key, t.id);
        for (const old of made.keys()) {
          if (made.size <= MAX_MADE) break;
          made.delete(old);
        }
      }
    }
    res.json(asJson(t, s.role));
  });

  const staff = signedIn('admin', 'mechanic');
  r.post('/api/tickets/:id', staff, validId, jsonBody, (req, res) =>
    changeTicket(req, res, idOf(req), false),
  );
  r.post('/api/tickets/:id/move', staff, validId, jsonBody, (req, res) =>
    changeTicket(req, res, idOf(req), true),
  );
  return r;
}
