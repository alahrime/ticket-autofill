// Our own bills (billing/ownbills.ts): the first invoice number, Approve (POST /api/tickets/:id/bill), a bill's
// latest revision and Fix. Admin only, and 404 for everyone while shop-settings.json leaves ownBilling off (no
// session: 401, as every /api/ path). by-ticket: a filled ticket's own bill number, for Reprint and Fix bill.
// Money in the replies is in dollars; the database keeps cents.
import { type RequestHandler, type Response, Router } from 'express';
import { Stale } from '@shop/domain';
import type { BillSnapshot } from '../billing/ownbills';
import { BadInput, NotFound } from '../errors';
import { validRequest } from '../http/contract';
import { depsOf } from '../http/deps';
import { validId } from '../http/ids';
import { jsonBody } from '../http/security';
import { asJson, queryValues, sessionIn, signedIn } from '../view';
import { mechanicNamed } from './tickets';

type Body = Record<string, unknown>;

/** :no in a path: 1 to 9 digits, else on to the 404. */
const NO = /^\d{1,9}$/;

/** On to the next route (in the end, the 401 / 404) while own billing is off: first, before the role or any body. */
const ownBilling: RequestHandler = (req, _res, next) => next(depsOf(req).config.ownBilling ? undefined : 'route');

const validNo: RequestHandler = (req, _res, next) => {
  const no = req.params['no'];
  next(typeof no === 'string' && NO.test(no) ? undefined : 'route');
};

const byOf = (res: Response): string => `admin#${sessionIn(res).user_id ?? ''}`;

function version(v: unknown): number {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  throw new BadInput('version must be a whole number');
}

const dollars = (c: number): number => c / 100;

/** The snapshot with its money in dollars, as the replies give it. */
export function inDollars(b: BillSnapshot): unknown {
  const a = b.amounts;
  return {
    ...b,
    labor: b.labor.map((r) => ({ ...r, amount: dollars(r.amount) })),
    parts: b.parts.map((r) => ({ ...r, price: dollars(r.price), total: dollars(r.total) })),
    amounts: {
      parts: dollars(a.parts),
      labor: dollars(a.labor),
      supplies: dollars(a.supplies),
      tax: dollars(a.tax),
      total: dollars(a.total),
      deposit: dollars(a.deposit),
      balance: dollars(a.balance),
    },
  };
}

/** Stale -> 409 with the stored ticket, as the ticket routes answer; anything else goes on to the error mapping. */
function staleReply(res: Response, e: unknown): void {
  if (!(e instanceof Stale)) throw e;
  res.status(409).json({ error: e.message, ticket: asJson(e.ticket, 'admin') });
}

/**
 * Runs the InvoMax import (when it is on) and waits for it, so InvoMax's bills made this morning count; true
 * when the reply may go on. A failure is 503: nothing is proposed or confirmed on old numbers.
 */
async function imported(res: Response): Promise<boolean> {
  const r = await depsOf(res.req).nightly.importWait();
  if (r !== 'failed') return true;
  res.status(503).json({ error: "couldn't read InvoMax's latest bills; try again in a minute" });
  return false;
}

export function ownBillRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const admin = signedIn('admin');

  r.get('/api/own-bills/first-number', ownBilling, admin, async (req, res) => {
    const own = depsOf(req).ownBills;
    if (!own.firstNumber().confirmed && !(await imported(res))) return;
    res.json(own.firstNumber());
  });

  r.post('/api/own-bills/first-number', ownBilling, admin, jsonBody, validRequest, async (req, res) => {
    const own = depsOf(req).ownBills;
    const no = (req.body as Body)['invoice_no'];
    if (typeof no !== 'string') throw new BadInput('invoice_no must be 7 digits');
    if (own.firstNumber().confirmed) return void res.status(409).json({ error: 'the first invoice number is already confirmed' });
    if (!(await imported(res))) return;
    own.confirmFirst(no, byOf(res)); // BadInput at or below the highest used, Refused (409) if confirmed meanwhile
    res.status(204).end();
  });

  r.post('/api/tickets/:id/bill', ownBilling, admin, validId, jsonBody, validRequest, (req, res) => {
    const v = version((req.body as Body)['version']);
    try {
      res.status(201).json(inDollars(depsOf(req).ownBills.approve(Number(req.params['id']), v, byOf(res), new Date())));
    } catch (e) {
      staleReply(res, e);
    }
  });

  r.get('/api/own-bills/by-ticket/:id', ownBilling, admin, validId, (req, res) => {
    const no = depsOf(req).ownBills.ofTicket(Number(req.params['id']));
    if (no === null) throw new NotFound('no bill of ours for this ticket');
    res.json({ invoice_no: no });
  });

  // ?rev=N: that revision as stored (read-only, what that print showed); else the latest
  r.get('/api/own-bills/:no', ownBilling, admin, validNo, validRequest, (req, res) => {
    const no = String(req.params['no']);
    const rev = queryValues(req.originalUrl, 'rev')[0];
    const own = depsOf(req).ownBills;
    const got = rev === undefined ? own.latest(no) : own.revision(no, Number(rev));
    if (!got) throw new NotFound(rev === undefined ? 'no such bill' : 'no such bill or revision');
    res.json({ ...got, bill: inDollars(got.bill) });
  });

  r.post('/api/own-bills/:no/fix', ownBilling, admin, validNo, jsonBody, validRequest, (req, res) => {
    const { ownBills, store, accounts } = depsOf(req);
    const no = String(req.params['no']);
    const d = req.body as Body;
    const v = version(d['version']);
    const fields = d['fields'];
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new BadInput('fields must be an object');
    const f: Body = { ...(fields as Body) };
    const got = ownBills.latest(no);
    if (!got) throw new NotFound('no such bill');
    if (Object.hasOwn(f, 'mechanic'))
      f['mechanic'] = mechanicNamed(accounts, f['mechanic'], store.get(got.ticket_id)?.mechanic ?? ''); // as the edit route
    try {
      res.json(inDollars(ownBills.fix(no, f, v, byOf(res), new Date())));
    } catch (e) {
      staleReply(res, e);
    }
  });
  return r;
}
