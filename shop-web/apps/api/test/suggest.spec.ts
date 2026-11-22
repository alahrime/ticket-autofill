// Price suggestions: the pick over samples (levels, recency, median, percentiles), the shop's own samples, and
// the route. Made-up values only.
import type { DatabaseSync } from 'node:sqlite';
import { MAX_QTY } from '@shop/domain';
import { ourSamples, suggest } from '../src/jobs/suggest';
import { CAR, makeServer, type TestServer } from './helpers';

jest.setTimeout(30_000);

const s = (unit: number, date: string, year: number | null, make = 'HONDA', model = 'HR-V') => ({ unit, date, year, make, model });
const NOW = new Date('2026-11-21T12:00:00');
const HRV = { year: 2019, make: 'HONDA', model: 'HR-V' };

describe('suggest', () => {
  it('same model, years ±2, recent', () => {
    const p = suggest(
      [s(4500, '2026-01-02', 2018), s(5000, '2025-06-01', 2020), s(5500, '2026-03-01', 2021), s(9900, '2026-03-01', 2010)],
      HRV,
      NOW,
    );
    expect(p).toMatchObject({ unit: 5000, count: 3, low: 4750, high: 5250, basis: { level: 'model_years', years: [2017, 2021], recent: true } });
  });

  it('falls to make when the model has under 3', () => {
    const list = [
      s(1000, '2026-05-01', 2019),
      s(2000, '2026-05-02', 2019),
      s(3000, '2026-05-03', 2019, 'HONDA', 'CIVIC'),
      s(3000, '2026-05-04', 2015, 'HONDA', 'CIVIC'),
      s(3000, '2026-05-05', 2015, 'HONDA', 'CIVIC'),
    ];
    expect(suggest(list, HRV, NOW)).toMatchObject({ count: 5, basis: { level: 'make', make: 'HONDA', recent: true } });
  });

  it('falls to all time when nothing recent has 3', () => {
    const list = [s(1000, '2021-01-01', 2019), s(2000, '2021-02-01', 2019), s(3000, '2021-03-01', 2019)];
    expect(suggest(list, HRV, NOW)).toMatchObject({ unit: 2000, basis: { level: 'model_years', recent: false } });
  });

  it('null year skips model_years', () => {
    const list = [s(1000, '2026-05-01', 2019), s(2000, '2026-05-02', 2019), s(3000, '2026-05-03', 2019)];
    expect(suggest(list, { ...HRV, year: null }, NOW)).toMatchObject({ basis: { level: 'model', years: null } });
  });

  it('a sample with no year is not model_years', () => {
    const list = [s(1000, '2026-05-01', null), s(2000, '2026-05-02', null), s(3000, '2026-05-03', null)];
    expect(suggest(list, HRV, NOW)?.basis.level).toBe('model');
  });

  it('even count median is the mean of the middle two, half-up cents', () => {
    const list = [s(1000, '2026-05-01', 2019), s(1001, '2026-05-02', 2019), s(1001, '2026-05-03', 2019), s(1000, '2026-05-04', 2019)];
    expect(suggest(list, HRV, NOW)?.unit).toBe(1001); // 1000.5 rounds up
  });

  it('percentiles interpolate', () => {
    const list = [1000, 2000, 3000, 4000].map((u, i) => s(u, `2026-05-0${i + 1}`, 2019));
    expect(suggest(list, HRV, NOW)).toMatchObject({ unit: 2500, low: 1750, high: 3250 });
  });

  it('make and model compare trimmed, upper-cased, with spaces collapsed', () => {
    const list = [1, 2, 3].map((u) => s(u * 1000, '2026-05-01', 2019, ' honda ', ' hr   v '));
    expect(suggest(list, { year: 2019, make: 'Honda', model: 'HR V' }, NOW)?.basis.level).toBe('model_years');
  });

  it('recent means on or after the same day 24 months ago', () => {
    const on = [s(1000, '2024-11-21', 2019), s(1000, '2024-11-21', 2019), s(1000, '2024-11-21', 2019)];
    expect(suggest(on, HRV, NOW)?.basis.recent).toBe(true);
    const before = [s(1000, '2024-11-20', 2019), s(1000, '2024-11-20', 2019), s(1000, '2024-11-20', 2019)];
    expect(suggest(before, HRV, NOW)?.basis.recent).toBe(false);
  });

  it('with fewer than 3 samples anywhere it still answers from all of them; none is null', () => {
    expect(suggest([s(1234, '2020-01-01', 2000, 'FORD', 'F150')], HRV, NOW)).toMatchObject({
      unit: 1234,
      count: 1,
      basis: { level: 'all', recent: false },
    });
    expect(suggest([], HRV, NOW)).toBeNull();
  });
});

function fill(db: DatabaseSync, id: number, updated: string): void {
  const row = db.prepare('SELECT data FROM tickets WHERE id = ?').get(id) as { data: string };
  const data = JSON.parse(row.data) as Record<string, unknown>;
  data['updated'] = updated;
  db.prepare("UPDATE tickets SET status = 'filled', data = ? WHERE id = ?").run(JSON.stringify(data), id);
}

describe('ourSamples and the route', () => {
  let srv: TestServer;
  beforeEach(async () => {
    srv = await makeServer();
  });
  afterEach(() => srv.close());

  const make = (lines: object[], car: object = {}): number => srv.store.create({ ...CAR, ...car, lines } as never).id;

  it('takes part price and labor per unit from filled tickets; linked-to-InvoMax ones are left out', () => {
    const a = make([{ desc: 'PADS', code: 'FBP', qty: 2, price: 40, labor: 90 }]);
    const b = make([{ desc: 'PADS', code: 'FBP', qty: 1, price: 50, labor: 100 }]);
    const c = make([{ desc: 'PADS', code: 'FBP', qty: 1, price: 60, labor: 110 }]);
    const d = make([{ desc: 'OIL', code: 'OIL', qty: 1, price: 5, labor: 5 }]);
    make([{ desc: 'PADS', code: 'FBP', qty: 1, price: 70, labor: 120 }]); // not filled
    for (const id of [a, b, c, d]) fill(srv.db, id, '2026-10-05T09:00:00');
    srv.im
      .prepare(
        `INSERT INTO im_invoices (invoice_no, "date", "key", name, "first", "last", phone, plate, address, parts, labor,
           supplies, discount, deposit, tax, total, balance, tax_rate, hash, lines_hash, first_seen, updated_at, gone_at, plate_norm)
         VALUES ('9000001', '2026-10-05', '', 'DOE', 'JANE', 'DOE', '5550100000', 'XKS-4827', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, '', '', '', '', '', 'XKS4827')`,
      )
      .run();
    srv.deps.links.link(b, '9000001', null, 'admin#1');
    srv.deps.links.markNone(c, null, 'admin#1');
    const part = ourSamples(srv.store, srv.deps.links, 'FBP', 'part');
    expect(part.map((x) => x.unit).sort((p, q) => p - q)).toEqual([4000, 6000]);
    const labor = ourSamples(srv.store, srv.deps.links, 'FBP', 'labor');
    expect(labor.map((x) => x.unit).sort((p, q) => p - q)).toEqual([4500, 11000]);
    expect(part[0]).toMatchObject({ date: '2026-10-05', year: 2019, make: 'CADILLAC', model: 'XT5' });
  });

  it('API: labor x qty, part per unit, catalog fallback, unknown code null', async () => {
    const a = await srv.admin();
    // no history: parts.csv FBP is 100 part, 100 labor
    let r = await srv.call('/api/price-suggestions?code=FBP&year=2019&make=Cadillac&model=XT5&qty=2', undefined, a);
    expect([r.status, r.body]).toEqual([
      200,
      {
        part: { price: 100, count: 0, low: 100, high: 100, basis: { level: 'catalog' } },
        labor: { price: 200, count: 0, low: 200, high: 200, basis: { level: 'catalog' } },
      },
    ]);
    r = await srv.call('/api/price-suggestions?code=NOPE-0', undefined, a);
    expect([r.status, r.body]).toEqual([200, { part: null, labor: null }]);
    const ids = [40, 50, 60].map((p) => make([{ desc: 'PADS', code: 'FBP', qty: 1, price: p, labor: p * 2 }]));
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    for (const id of ids) fill(srv.db, id, `${day}T09:00:00`);
    r = await srv.call('/api/price-suggestions?code=FBP&year=2019&make=cadillac&model=xt5&qty=3', undefined, a);
    expect(r.body).toMatchObject({
      part: { price: 50, count: 3, low: 45, high: 55, basis: { level: 'model_years', years: [2017, 2021], recent: true } },
      labor: { price: 300, count: 3, low: 270, high: 330 },
    });
    r = await srv.call('/api/price-suggestions?code=FBP&year=2019&make=Ford&model=F150', undefined, a); // other car: the whole shop
    expect(r.body).toMatchObject({ part: { price: 50, basis: { level: 'all' } }, labor: { price: 100 } });
  });

  it('API: bad input is 400, a mechanic 403, no session 401', async () => {
    const a = await srv.admin();
    const bad = [
      'code=',
      '',
      `code=${'X'.repeat(21)}`,
      'code=FBP&qty=0',
      'code=FBP&qty=-1',
      'code=FBP&qty=abc',
      `code=FBP&qty=${MAX_QTY + 1}`,
      'code=FBP&year=1899',
      'code=FBP&year=2101',
      'code=FBP&year=20x9',
      `code=FBP&make=${'M'.repeat(41)}`,
      `code=FBP&model=${'M'.repeat(41)}`,
    ];
    for (const q of bad) {
      const r = await srv.call(`/api/price-suggestions?${q}`, undefined, a);
      expect([q, r.status, typeof (r.body as { error?: unknown }).error]).toEqual([q, 400, 'string']);
    }
    expect((await srv.call(`/api/price-suggestions?code=FBP&qty=${MAX_QTY}&year=2100`, undefined, a)).status).toBe(200);
    expect((await srv.call('/api/price-suggestions?code=FBP', undefined, await srv.tech('Al Fixit'))).status).toBe(403);
    expect((await srv.call('/api/price-suggestions?code=FBP')).status).toBe(401);
  });
});
