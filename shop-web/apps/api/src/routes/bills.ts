// Bill history: the search, one row's both sides, a customer's vehicles, the tickets that still need their
// bill, and the admin's link / unlink / none / typed-final changes. Admin only. Money is in dollars both ways
// (as the ticket API's); invoice_finals keeps cents.
import { type RequestHandler, type Response, Router } from 'express';
import { BadInput, NotFound } from '../errors';
import { validRequest } from '../http/contract';
import { depsOf } from '../http/deps';
import { jsonBody } from '../http/security';
import type { TypedFinal } from '../history/links';
import { queryValues, sessionIn, signedIn } from '../view';

export const BILL_KEY = /^(im\d{1,7}|t\d{1,9})$/;
const TICKET_KEY = /^t(\d{1,9})$/;
export const INVOICE_NO = /^\d{1,7}$/;
export const MAX_CENTS = 100_000_000; // $1,000,000
const MONEY = ['parts', 'labor', 'supplies', 'tax', 'total'] as const;

type Body = Record<string, unknown>;

/** On to the next route (in the end, the 404) unless :key is im<1-7 digits> or t<1-9 digits>. */
const validKey: RequestHandler = (req, _res, next) => {
  const key = req.params['key'];
  next(typeof key === 'string' && BILL_KEY.test(key) ? undefined : 'route');
};

/** Only t<id> with a positive id: an im key (or t0) goes on to the 404, before any body is read. */
const ticketKey: RequestHandler = (req, res, next) => {
  const m = TICKET_KEY.exec(String(req.params['key']));
  const id = m ? Number(m[1]) : 0;
  if (!Number.isSafeInteger(id) || id < 1) return next('route');
  res.locals['ticketId'] = id;
  next();
};

const ticketIdOf = (res: Response): number => res.locals['ticketId'] as number;
const byOf = (res: Response): string => `admin#${sessionIn(res).user_id ?? ''}`;

/** null, or a whole number 0 .. 2^53-1; else BadInput. */
function version(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  throw new BadInput('version must be null or a whole number');
}

function invoiceNo(v: unknown): string {
  if (typeof v === 'string' && INVOICE_NO.test(v)) return v;
  throw new BadInput('invoice_no must be 1 to 7 digits');
}

/** Dollars with at most 2 decimals, 0 to $1,000,000 -> whole cents; else BadInput. */
function moneyCents(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new BadInput(`${name} must be dollars, 0 or more`);
  const c = Math.round(v * 100);
  if (Math.abs(c - v * 100) > 1e-6) throw new BadInput(`${name} must be whole cents`);
  if (!Number.isSafeInteger(c) || c > MAX_CENTS) throw new BadInput(`${name} must be 1000000 or less`);
  return c;
}

/** YYYY-MM-DD that is a real day. */
function day(v: string, name: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  if (!m || !d || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) throw new BadInput(`${name} must be a date (YYYY-MM-DD)`);
  return v;
}

const first = (url: string, name: string): string | undefined => queryValues(url, name)[0];

export function billRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const admin = signedIn('admin');

  r.get('/api/invoices', admin, validRequest, (req, res) => {
    const url = req.originalUrl;
    const page = first(url, 'page');
    if (page !== undefined && !/^[1-9]\d{0,5}$/.test(page)) throw new BadInput('page must be 1 or more');
    const from = first(url, 'from');
    const to = first(url, 'to');
    res.json(
      depsOf(req).history.search({
        name: first(url, 'name'),
        phone: first(url, 'phone'),
        tag: first(url, 'tag'),
        vin: first(url, 'vin'),
        from: from === undefined ? undefined : day(from, 'from'),
        to: to === undefined ? undefined : day(to, 'to'),
        page: page === undefined ? 1 : Number(page),
      }),
    );
  });

  r.get('/api/invoices/:key', admin, validKey, (req, res) => {
    const b = depsOf(req).history.bill(String(req.params['key']));
    if (!b) throw new NotFound('no such bill');
    res.json(b);
  });

  r.get('/api/customers/:phone', admin, (req, res) => {
    const phone = String(req.params['phone']);
    const c = /^\d{3,15}$/.test(phone) ? depsOf(req).history.customer(phone) : null;
    if (!c) throw new NotFound('no such customer');
    res.json(c);
  });

  r.get('/api/needs-bill', admin, (req, res) => {
    const tickets = depsOf(req).links.needsBill().map((t) => ({
      ...t,
      subtotal: t.subtotal / 100,
      candidates: t.candidates.map((c) => ({ ...c, total: c.total / 100 })),
    }));
    res.json({ tickets });
  });

  /** After a change: the ticket's row as GET /api/invoices/t<id> gives it. */
  const reply = (res: Response, id: number): void => {
    const b = depsOf(res.req).history.bill(`t${id}`);
    if (!b) throw new NotFound('no such bill');
    res.json(b);
  };

  r.post('/api/invoices/:key/link', admin, ticketKey, jsonBody, validRequest, (req, res) => {
    const d = req.body as Body;
    const id = ticketIdOf(res);
    depsOf(req).links.link(id, invoiceNo(d['invoice_no']), version(d['version']), byOf(res));
    reply(res, id);
  });

  r.post('/api/invoices/:key/unlink', admin, ticketKey, jsonBody, validRequest, (req, res) => {
    const id = ticketIdOf(res);
    depsOf(req).links.unlink(id, version((req.body as Body)['version']), byOf(res));
    reply(res, id);
  });

  r.post('/api/invoices/:key/none', admin, ticketKey, jsonBody, validRequest, (req, res) => {
    const id = ticketIdOf(res);
    depsOf(req).links.markNone(id, version((req.body as Body)['version']), byOf(res));
    reply(res, id);
  });

  // InvoMax's bill typed by hand, in dollars (no discount: total = parts + labor + supplies + tax)
  r.post('/api/invoices/:key/final', admin, ticketKey, jsonBody, validRequest, (req, res) => {
    const d = req.body as Body;
    const id = ticketIdOf(res);
    const c = Object.fromEntries(MONEY.map((k) => [k, moneyCents(d[k], k)])) as Record<(typeof MONEY)[number], number>;
    if (c.total !== c.parts + c.labor + c.supplies + c.tax) throw new BadInput('total must be parts + labor + supplies + tax');
    const n: TypedFinal = { ...c, ...(d['invoice_no'] === undefined ? {} : { invoice_no: invoiceNo(d['invoice_no']) }) };
    depsOf(req).links.typedFinal(id, n, version(d['version']), byOf(res));
    reply(res, id);
  });
  return r;
}
