// Price suggestions (admin): what the job's part and labor usually cost, from the shop's history. Money out is
// dollars to the cent; the admin can always type another price.
import { statSync } from 'node:fs';
import { Router } from 'express';
import { MAX_QTY } from '@shop/domain';
import { BadInput } from '../errors';
import { validRequest } from '../http/contract';
import { depsOf } from '../http/deps';
import { type Basis, type Car, ourSamples, type Pick, suggest } from '../jobs/suggest';
import { queryValues, signedIn } from '../view';
import { loadParts, type Part } from './catalog';

export const MAX_JOB_CODE = 20;
export const MAX_VEHICLE_TEXT = 40;

type Suggestion = { price: number; count: number; low: number; high: number; basis: Basis | { level: 'catalog' } };

const one = (url: string, name: string): string => queryValues(url, name)[0] ?? '';
const cents = (x: number): number => Math.floor(x + 0.5);
const dollars = (c: number): number => c / 100;

function text(url: string, name: string): string {
  const v = one(url, name);
  if (v.length > MAX_VEHICLE_TEXT) throw new BadInput(`${name} must be at most ${MAX_VEHICLE_TEXT} characters`);
  return v;
}

function parse(url: string): { code: string; car: Car; qty: number } {
  const code = one(url, 'code');
  if (code.length < 1 || code.length > MAX_JOB_CODE) throw new BadInput(`code must be 1 to ${MAX_JOB_CODE} characters`);
  const y = one(url, 'year');
  let year: number | null = null;
  if (y !== '') {
    year = /^\d{1,4}$/.test(y) ? Number(y) : NaN;
    if (!(year >= 1900 && year <= 2100)) throw new BadInput('year must be a whole number from 1900 to 2100');
  }
  const q = one(url, 'qty');
  const qty = q === '' ? 1 : /^\d+(\.\d+)?$/.test(q) ? Number(q) : NaN;
  if (!(qty > 0 && qty <= MAX_QTY)) throw new BadInput(`qty must be more than 0 and at most ${MAX_QTY}`);
  return { code, car: { year, make: text(url, 'make'), model: text(url, 'model') }, qty };
}

/** The history's pick (times qty), else parts.csv's price, else null. */
function answer(pick: Pick | null, catalog: number | undefined, qty: number): Suggestion | null {
  if (pick) {
    const k = (c: number): number => dollars(cents(c * qty));
    return { price: k(pick.unit), count: pick.count, low: k(pick.low), high: k(pick.high), basis: pick.basis };
  }
  if (!catalog || !(catalog > 0)) return null;
  const p = dollars(cents(catalog * 100 * qty));
  return { price: p, count: 0, low: p, high: p, basis: { level: 'catalog' } };
}

const partsCache = new Map<string, { key: string; byCode: Map<string, Part> }>();

/** parts.csv by code, read again only when the file's mtime or size changes; empty when missing or malformed. */
function catalogOf(path: string): Map<string, Part> {
  let key = 'none';
  try {
    const st = statSync(path);
    key = `${st.mtimeMs}|${st.size}`;
  } catch {
    // missing: no catalog
  }
  const had = partsCache.get(path);
  if (had?.key === key) return had.byCode;
  let byCode = new Map<string, Part>();
  if (key !== 'none') {
    try {
      byCode = new Map(loadParts(path).map((p) => [p.code, p]));
    } catch {
      // malformed: no catalog
    }
  }
  partsCache.set(path, { key, byCode });
  return byCode;
}

export function suggestRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  r.get('/api/price-suggestions', signedIn('admin'), validRequest, (req, res) => {
    const { code, car, qty } = parse(req.originalUrl);
    const d = depsOf(req);
    const row = catalogOf(d.config.catalog).get(code);
    if (!row) {
      res.json({ part: null, labor: null }); // not a job code: nothing to scan
      return;
    }
    const now = new Date();
    const pick = (kind: 'part' | 'labor'): Pick | null =>
      suggest([...d.jobs.samples(code, kind), ...ourSamples(d.store, d.links, code, kind)], car, now);
    res.json({
      part: answer(pick('part'), row.part_price, 1),
      labor: answer(pick('labor'), row.labor_price, qty),
    });
  });
  return r;
}
