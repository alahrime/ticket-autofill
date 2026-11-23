// Bill history (/api/invoices, /api/customers, /api/needs-bill and the link routes) and the upkeep buttons'
// API, over a real server with a temp InvoMax folder. Every name, phone and plate here is made up.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '@shop/domain';
import { normalPlate } from '@shop/invomax';
import { makeServer, type TestServer } from './helpers';

jest.setTimeout(60_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

let s: TestServer;
let a: string;

/** A filled ticket, filled on `day`, with one $100 part and $50 labor unless lines are given. */
function filled(day: string, extra: Record<string, unknown> = {}): number {
  const t = s.store.create({
    first: 'Jane',
    last: 'Testcase',
    phone: '555 010 0000',
    year: '2019',
    make: 'Cadillac',
    model: 'XT5',
    plate: 'tst-0001',
    lines: [{ desc: 'BRAKE PADS', qty: 1, price: 100, labor: 50 }],
    ...extra,
  });
  const row = s.db.prepare('SELECT data FROM tickets WHERE id = ?').get(t.id) as { data: string };
  const data = JSON.parse(row.data) as Record<string, unknown>;
  data['updated'] = `${day}T10:00:00`;
  s.db.prepare("UPDATE tickets SET status = 'filled', data = ? WHERE id = ?").run(JSON.stringify(data), t.id);
  return t.id;
}

type BillIn = { first?: string; last?: string; name?: string; phone?: string; plate?: string; parts?: number; labor?: number; total?: number; gone_at?: string };
function bill(no: string, date: string, b: BillIn = {}): void {
  const v = { first: 'JANE', last: 'DOE', name: 'DOE', phone: '5550100000', plate: 'XKS-4827', parts: 12000, labor: 9000, total: 22833, gone_at: '', ...b };
  s.im
    .prepare(
      `INSERT INTO im_invoices (invoice_no, "date", "key", name, "first", "last", phone, plate, address, parts, labor,
         supplies, discount, deposit, tax, total, balance, tax_rate, hash, lines_hash, first_seen, updated_at, gone_at, plate_norm)
       VALUES (?, ?, '', ?, ?, ?, ?, ?, '', ?, ?, 1050, 0, 25000, 783, ?, 0, 0.0375, '', '', '', '', ?, ?)`,
    )
    .run(no, date, v.name, v.first, v.last, v.phone, v.plate, v.parts, v.labor, v.total, v.gone_at, normalPlate(v.plate));
}
function imLine(no: string, n: number, vehicle = '2019 Cadillac XT5'): void {
  s.im
    .prepare(
      `INSERT INTO im_lines (invoice_no, line_no, code, description, kind, qty, unit, amount, vehicle, year, make, model, trim)
       VALUES (?, ?, ?, ?, 'part', 2, 1250, 2500, ?, 2019, 'Cadillac', 'XT5', '')`,
    )
    .run(no, n, `P${n}`, `ITEM ${n}`, vehicle);
}
const link = (ticket: number, no: string): void => {
  s.db
    .prepare("INSERT INTO invoice_finals (ticket_id, invoice_no, source, linked_at, linked_by) VALUES (?, ?, 'invomax', '2026-11-21T09:00:00', 'auto')")
    .run(ticket, no);
};
const get = async (path: string, cookie: string | undefined = a): Promise<[number, J]> => {
  const r = await s.call(path, undefined, cookie);
  return [r.status, r.body];
};
const post = async (path: string, body: unknown, cookie: string | undefined = a): Promise<[number, J]> => {
  const r = await s.call(path, body, cookie);
  return [r.status, r.body];
};
const keys = async (query: string): Promise<string[]> => {
  const [code, body] = await get(`/api/invoices${query}`);
  expect([query, code]).toEqual([query, 200]);
  return body.rows.map((r: J) => r.key);
};

describe('Bill history', () => {
  let t1: number;
  let t2: number;
  beforeEach(async () => {
    s = await makeServer();
    a = await s.admin();
    t1 = filled('2026-11-20', { vin: '1TESTVIN000000001' });
    bill('9000001', '2026-11-20', { plate: 'TST-0001' });
    imLine('9000001', 1);
    imLine('9000001', 2);
    link(t1, '9000001');
    bill('9000002', '2026-10-01', { first: 'JOHN', last: 'ROE', name: 'ROE', phone: '5550100002' });
    imLine('9000002', 1, '2015 Honda Civic LX');
    t2 = filled('2026-11-15', { first: 'Ann', last: 'Sample', phone: '(555) 010-0003', plate: 'qqq-111' });
  });
  afterEach(() => s.close());

  it('lists newest first; a linked pair shows once, keyed by its bill', async () => {
    const [code, body] = await get('/api/invoices');
    expect(code).toBe(200);
    expect(body).toMatchObject({ total: 3, page: 1, per_page: 50 });
    expect(body.rows).toEqual([
      {
        key: 'im9000001', date: '2026-11-20', invoice_no: '9000001', ticket_id: t1, name: 'JANE TESTCASE',
        phone: '5550100000', vehicle: '2019 CADILLAC XT5', plate: 'TST-0001', total: 228.33,
      },
      {
        key: `t${t2}`, date: '2026-11-15', invoice_no: null, ticket_id: t2, name: 'ANN SAMPLE',
        phone: '5550100003', vehicle: '2019 CADILLAC XT5', plate: 'QQQ-111', total: null,
      },
      {
        key: 'im9000002', date: '2026-10-01', invoice_no: '9000002', ticket_id: null, name: 'JOHN ROE',
        phone: '5550100002', vehicle: '2015 Honda Civic LX', plate: 'XKS-4827', total: 228.33,
      },
    ]);
  });

  it('searches by each filter, partially and ignoring case', async () => {
    expect(await keys('?name=jane')).toEqual(['im9000001']);
    expect(await keys('?name=DOE')).toEqual(['im9000001']); // InvoMax's last name on a linked pair
    expect(await keys('?name=jane%20doe')).toEqual(['im9000001']); // InvoMax's full name
    expect(await keys('?name=e%20tes')).toEqual(['im9000001']); // ours, across first and last
    expect(await keys('?name=ro')).toEqual(['im9000002']);
    expect(await keys('?name=ann%20sam')).toEqual([`t${t2}`]);
    expect(await keys('?name=nobody')).toEqual([]);
    expect(await keys('?phone=0100002')).toEqual(['im9000002']);
    expect(await keys('?phone=(555)%20010')).toEqual(['im9000001', `t${t2}`, 'im9000002']);
    expect(await keys('?phone=0003')).toEqual([`t${t2}`]); // ours, typed with punctuation
    expect(await keys('?tag=ks-48')).toEqual(['im9000002']);
    expect(await keys('?tag=TST')).toEqual(['im9000001']);
    expect(await keys('?tag=q1')).toEqual([`t${t2}`]);
    expect(await keys('?vin=vin00')).toEqual(['im9000001']); // our tickets only: InvoMax keeps no VIN
    expect(await keys('?from=2026-11-01')).toEqual(['im9000001', `t${t2}`]);
    expect(await keys('?to=2026-11-15')).toEqual([`t${t2}`, 'im9000002']);
    expect(await keys('?from=2026-11-15&to=2026-11-15')).toEqual([`t${t2}`]);
  });

  it('combines filters', async () => {
    expect(await keys('?name=jane&tag=xks')).toEqual([]);
    expect(await keys('?phone=555&from=2026-11-12')).toEqual(['im9000001', `t${t2}`]);
    expect(await keys('?name=o&tag=xks&to=2026-11-01')).toEqual(['im9000002']);
  });

  it('treats % and _ as plain text', async () => {
    expect(await keys('?name=%25')).toEqual([]);
    expect(await keys('?name=_')).toEqual([]);
  });

  it('pages 50 at a time, newest first', async () => {
    for (let i = 0; i < 120; i++) bill(String(9000100 + i), `2025-01-${String((i % 28) + 1).padStart(2, '0')}`, { first: 'PAGE', last: `TEST${i}` });
    const [, p1] = await get('/api/invoices?name=page');
    expect([p1.total, p1.rows.length, p1.page, p1.per_page]).toEqual([120, 50, 1, 50]);
    const [, p3] = await get('/api/invoices?name=page&page=3');
    expect([p3.total, p3.rows.length, p3.page]).toEqual([120, 20, 3]);
    const dates = [...p1.rows, ...p3.rows].map((r: J) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect((await get('/api/invoices?name=page&page=4'))[1].rows).toEqual([]);
  });

  it('refuses bad query values with 400', async () => {
    for (const q of ['page=0', 'page=x', 'page=-1', 'from=2026-1-1', 'to=yesterday', 'from=2026-02-30', 'phone=abc'])
      expect([q, (await get(`/api/invoices?${q}`))[0]]).toEqual([q, 400]);
  });

  it('a linked pair: both sides, the link and the difference', async () => {
    const [code, b] = await get('/api/invoices/im9000001');
    expect(code).toBe(200);
    expect(b.key).toBe('im9000001');
    expect(b.before).toMatchObject({ ticket_id: t1, parts: 100, labor: 50, subtotal: 150 });
    expect(b.before.lines).toMatchObject([{ desc: 'BRAKE PADS', qty: 1, price: 100, labor: 50 }]);
    expect(b.after).toMatchObject({
      invoice_no: '9000001', date: '2026-11-20', parts: 120, labor: 90, supplies: 10.5, discount: 0, deposit: 250,
      tax: 7.83, total: 228.33, balance: 0, source: 'invomax', gone: false,
    });
    expect(b.after.lines).toEqual([
      { code: 'P1', description: 'ITEM 1', kind: 'part', qty: 2, unit: 12.5, amount: 25 },
      { code: 'P2', description: 'ITEM 2', kind: 'part', qty: 2, unit: 12.5, amount: 25 },
    ]);
    expect(b.link).toMatchObject({ source: 'invomax', linked_by: 'auto', linked_at: '2026-11-21T09:00:00', version: 1 });
    expect(b.difference).toBe(-60); // 150 - (120 + 90)
    expect((await get(`/api/invoices/t${t1}`))[1].key).toBe('im9000001'); // the ticket's key finds the pair
  });

  it('a ticket with no bill has after: null; a bill with no ticket has before: null', async () => {
    const [, t] = await get(`/api/invoices/t${t2}`);
    expect([t.key, t.before.ticket_id, t.after, t.link, t.difference]).toEqual([`t${t2}`, t2, null, null, null]);
    const [, i] = await get('/api/invoices/im9000002');
    expect([i.key, i.before, i.link, i.difference]).toEqual(['im9000002', null, null, null]);
    expect(i.after.invoice_no).toBe('9000002');
  });

  it('a bill InvoMax no longer has is still shown, marked gone', async () => {
    bill('9000003', '2026-09-01', { gone_at: '2026-11-20T02:00:00' });
    expect((await get('/api/invoices/im9000003'))[1].after.gone).toBe(true);
  });

  it('a bill with an odd number (as InvoMax has a few) is listed by a URL-safe key that opens it', async () => {
    for (const [no, key] of [
      ['9000001A', 'im9000001A'],
      ['-9000004', 'im-9000004'],
      ['90000050', 'im90000050'],
      ['9000 06', 'im9000%2006'],
    ]) {
      bill(no, '2026-08-01', { first: 'ODD', last: 'NUMBER' });
      imLine(no, 1);
      expect(await keys(`?name=odd&from=2026-08-01&to=2026-08-01`)).toContain(key);
      const [code, b] = await get(`/api/invoices/${key}`);
      expect([no, code, b.key, b.after?.invoice_no, b.after?.lines.length]).toEqual([no, 200, key, no, 1]);
    }
    expect((await get('/api/invoices/im9000001B'))[0]).toBe(404); // only the exact number
    expect((await post(`/api/invoices/im9000001A/link`, { invoice_no: '9000001', version: null }))[0]).toBe(404);
  });

  it('a bad or unknown key is 404', async () => {
    for (const k of ['x1', 'im', 'im12345678', 't', 't0', 't1234567890', 'IM9000001', 'im9000009', 't999', 'im9000001%20'])
      expect([k, (await get(`/api/invoices/${k}`))[0]]).toEqual([k, 404]);
    const waiting = s.store.create({ first: 'Jane', last: 'Testcase', phone: '5550100000', year: '2019', make: 'Kia', model: 'Rio' });
    expect((await get(`/api/invoices/t${waiting.id}`))[0]).toBe(404); // not filled
  });

  it('a customer: their vehicles, each with its bills', async () => {
    const [code, c] = await get('/api/customers/5550100000');
    expect(code).toBe(200);
    expect(c.phone).toBe('5550100000');
    expect(c.vehicles).toEqual([
      { plate: 'TST-0001', vin: '1TESTVIN000000001', vehicle: '2019 CADILLAC XT5', bills: [expect.objectContaining({ key: 'im9000001' })] },
    ]);
    expect((await get('/api/customers/5550109999'))[0]).toBe(404);
    expect((await get('/api/customers/555-010'))[0]).toBe(404);
  });

  it('never writes a customer phone in the log', async () => {
    expect((await get('/api/customers/5550100000'))[0]).toBe(200);
    expect((await get('/api/customers/5550109999'))[0]).toBe(404);
    expect((await get('/api/customers/5550100000/x'))[0]).toBe(404); // no route
    expect((await get('/API/customers/5550100000'))[0]).toBe(404);
    expect((await get('/api/customers/%35%35%350100000'))[0]).toBe(200); // the same phone, percent-encoded
    expect((await get('/api/customers/5550100000', ''))[0]).toBe(401);
    const lines = s.log().split('\n').filter((l) => /customers/i.test(l));
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(l.slice(20)).toMatch(/^GET \/api\/customers\/:phone \d{3} (admin#\d+ )?\d+\.\ds$/i);
    expect(s.log()).not.toMatch(/0100000|0109999|%35/);
  });

  it('logs the raw path: %0A never starts a line; slashes and encodings still hide the phone', async () => {
    const paths = [
      '/api%0Afake/customers/5550100000',
      '/api/tickets%0A2026-11-21%2000:00:00%20GET%20/forged%20200',
      '/api/customers/5550100000/',
      '/api//customers/5550100000',
      '/api/customers//5550100000',
      '/api/customers%2F5550100000',
      '/api/cust%6Fmers/5550100000',
      '/api/cust%6Fmers/5550100000/customers/x', // a later literal /customers/ must not keep the prefix
      '/api/%63ustomers/5550100000',
      '/api/customers/5550100000/customers/1',
    ];
    const before = s.log().split('\n').filter(Boolean).length;
    for (const p of paths) await get(p);
    const lines = s.log().split('\n').filter(Boolean).slice(before);
    expect(lines).toHaveLength(paths.length); // one line per request: nothing forged
    for (const l of lines) expect(l).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d GET \S+ \d{3} (admin#\d+ )?\d+\.\ds$/);
    const logged = lines.map((l) => l.split(' ')[3]);
    // a customer path is always exactly the fixed pattern; anything else stays raw, still encoded
    expect(logged).toEqual([
      '/api/customers/:phone',
      '/api/tickets%0A2026-11-21%2000:00:00%20GET%20/forged%20200',
      ...Array(8).fill('/api/customers/:phone'),
    ]);
    for (const p of logged.filter((x) => x !== logged[1])) expect(p).not.toMatch(/\d/); // no phone digit at all
    expect(s.log()).not.toMatch(/0100000|555/);
  });

  it('links by typing any bill number, checking the version; unlink, none and a typed final', async () => {
    const t3 = filled('2026-11-18', { plate: 'zzz-999', phone: '5550100009' });
    // 9000002 is far from t3's day and plate: never a candidate, but the admin can type it
    expect((await get('/api/needs-bill'))[1].tickets.find((x: J) => x.ticket_id === t3).candidates).toEqual([]);
    expect(await post(`/api/invoices/t${t3}/link`, { invoice_no: '9000002', version: 1 })).toEqual([409, { error: 'changed on another device' }]);
    expect(await post(`/api/invoices/t${t3}/link`, { invoice_no: '9000002', version: null })).toMatchObject([200, { key: 'im9000002' }]);
    const [, b] = await get('/api/invoices/im9000002');
    expect(b.before.ticket_id).toBe(t3);
    expect(b.link).toMatchObject({ source: 'invomax', linked_by: `admin#${s.ids['Owner Test']}`, version: 1 });
    expect(await post(`/api/invoices/t${t3}/link`, { invoice_no: '9000009', version: 1 })).toEqual([404, { error: 'not found' }]);
    expect((await post(`/api/invoices/t${t2}/link`, { invoice_no: '9000002', version: null }))[0]).toBe(409); // taken
    expect(await post(`/api/invoices/t${t3}/unlink`, { version: 1 })).toMatchObject([200, { key: `t${t3}`, link: null }]);
    expect(await post(`/api/invoices/t${t3}/none`, { version: null })).toMatchObject([200, { link: { source: 'none', version: 1 } }]);
    const final = { invoice_no: '9000555', parts: 120, labor: 90.5, supplies: 10.25, tax: 7.83, total: 228.58, version: 1 };
    const [code, f] = await post(`/api/invoices/t${t3}/final`, final);
    expect(code).toBe(200);
    expect(f.after).toMatchObject({ invoice_no: '9000555', parts: 120, labor: 90.5, supplies: 10.25, tax: 7.83, total: 228.58, source: 'typed' });
    expect(f.link).toMatchObject({ source: 'typed', version: 2 });
    expect(f.difference).toBe(-60.5);
    const stored = s.db.prepare('SELECT parts, labor, supplies, tax, total FROM invoice_finals WHERE ticket_id = ?').get(t3);
    expect(stored).toEqual({ parts: 12000, labor: 9050, supplies: 1025, tax: 783, total: 22858 }); // cents
    expect((await get(`/api/invoices?name=jane&from=2026-11-18&to=2026-11-18`))[1].rows).toMatchObject([
      { key: `t${t3}`, invoice_no: '9000555', total: 228.58 },
    ]);
    expect((await post(`/api/invoices/t${t3}/final`, { parts: 1, labor: 0, supplies: 0, tax: 0, total: 1, version: 2 }))[0]).toBe(200); // no number
  });

  it('refuses bad link and final input with 400', async () => {
    const bad: Array<[string, unknown]> = [
      ['link', { invoice_no: 'abc', version: null }],
      ['link', { invoice_no: '12345678', version: null }],
      ['link', { invoice_no: '', version: null }],
      ['link', { invoice_no: 9000002, version: null }],
      ['link', { invoice_no: '9000002' }],
      ['link', { invoice_no: '9000002', version: -1 }],
      ['link', { invoice_no: '9000002', version: 1.5 }],
      ['link', { invoice_no: '9000002', version: '1' }],
      ['unlink', {}],
      ['none', { version: 2 ** 53 }],
      ['final', { parts: 1, labor: 1, supplies: 1, tax: 1, total: 5, version: null }],
      ['final', { parts: 1.005, labor: 0, supplies: 0, tax: 0, total: 1.005, version: null }],
      ['final', { parts: -1, labor: 0, supplies: 0, tax: 0, total: -1, version: null }],
      ['final', { parts: 1000001, labor: 0, supplies: 0, tax: 0, total: 1000001, version: null }],
      ['final', { parts: '1', labor: 0, supplies: 0, tax: 0, total: 1, version: null }],
      ['final', { labor: 0, supplies: 0, tax: 0, total: 0, version: null }],
      ['final', { invoice_no: 'x1', parts: 0, labor: 0, supplies: 0, tax: 0, total: 0, version: null }],
    ];
    for (const [op, body] of bad) {
      const [code, r] = await post(`/api/invoices/t${t2}/${op}`, body);
      expect([op, body, code, Object.keys(r)]).toEqual([op, body, 400, ['error']]);
    }
    expect((await post('/api/invoices/im9000002/link', { invoice_no: '9000002', version: null }))[0]).toBe(404);
    expect((await post('/api/invoices/t0/none', { version: null }))[0]).toBe(404);
    expect((await post('/api/invoices/t999/none', { version: null }))[0]).toBe(404);
  });

  it('needs-bill lists filled tickets with no final, money in dollars', async () => {
    bill('9000004', '2026-11-16', { first: 'ANN', last: 'SAMPLE', phone: '5550100003', plate: 'QQQ-111', total: 15000 });
    const [code, r] = await get('/api/needs-bill');
    expect(code).toBe(200);
    expect(r.tickets).toEqual([
      expect.objectContaining({
        ticket_id: t2, plate: 'QQQ-111', filled: '2026-11-15', subtotal: 150,
        candidates: [expect.objectContaining({ invoice_no: '9000004', total: 150, why: 'plate' })],
      }),
    ]);
  });
});

describe('upkeep', () => {
  beforeEach(async () => {
    s = await makeServer();
    a = await s.admin();
  });
  afterEach(() => s.close());

  it('status: backups, the import and how many need a bill', async () => {
    filled('2026-11-15');
    const [code, r] = await get('/api/upkeep/status');
    expect(code).toBe(200);
    expect(r).toEqual({
      backup: { last: null, stale: true, invomax: null, offsite: null, offsite_stale: false, offsite_failed: null },
      import: { running: false, last: null, off: false },
      needs_bill: 1,
      ownBilling: false,
    });
  });

  it('status: the invomax backup counts toward stale, and a failed copy off this PC shows', async () => {
    const p = (x: number): string => String(x).padStart(2, '0');
    const d = new Date();
    const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    mkdirSync(s.config.backups, { recursive: true });
    writeFileSync(join(s.config.backups, `tickets-${today}.db`), '');
    writeFileSync(join(s.config.backups, 'offsite-attempt.json'), JSON.stringify({ at: d.toISOString(), ok: false, error: 'Error ENOSPC' }));
    const [, r] = await get('/api/upkeep/status');
    expect(r.backup).toEqual({ last: today, stale: true, invomax: null, offsite: null, offsite_stale: true, offsite_failed: 'Error ENOSPC' });
    writeFileSync(join(s.config.backups, `invomax-${today}.db`), '');
    expect((await get('/api/upkeep/status'))[1].backup).toMatchObject({ stale: false, invomax: today });
  });

  it('with the import turned off, status says so and the button is 400', async () => {
    s.config.importInvomax = false;
    expect((await get('/api/upkeep/status'))[1].import).toEqual({ running: false, last: null, off: true });
    expect(await post('/api/upkeep/import', {})).toEqual([400, { error: 'the InvoMax import is turned off in shop-settings.json' }]);
  });

  it('import: 202 started, then 409 while it runs', async () => {
    writeFileSync(join(s.config.invomaxDir, 'INVOICE.btv'), Buffer.alloc(100, 7)); // junk: it retries after a sleep
    writeFileSync(join(s.config.invomaxDir, 'DETAIL.btv'), Buffer.alloc(100, 7));
    expect(await post('/api/upkeep/import', {})).toEqual([202, { started: true }]);
    expect(await post('/api/upkeep/import', {})).toEqual([409, { error: 'an import is already running' }]);
    expect((await get('/api/upkeep/status'))[1].import.running).toBe(true);
    s.openSleep();
    await s.nightly.settled();
    const [, st] = await get('/api/upkeep/status');
    expect(st.import).toMatchObject({ running: false, last: { ok: false, invoices: 0 } });
    expect(s.log()).toMatch(/invomax import failed/);
  });

  it('copy-backups: no drive set up, or the drive missing, is 400', async () => {
    expect(await post('/api/upkeep/copy-backups', {})).toEqual([400, { error: 'no USB drive set up' }]);
    let free = '';
    for (const l of 'ZYXWVUTSRQ') if (!free && !existsSync(`${l}:\\`)) free = `${l}:`;
    s.config.backupTargets = [free];
    expect(await post('/api/upkeep/copy-backups', {})).toEqual([400, { error: 'drive not found' }]);
  });

  it('copy-backups: 409 while a copy is running, and the server answers meanwhile', async () => {
    // the one-at-a-time guard itself is nightly.spec's; here a copy held open stands in for a long USB copy
    let release!: () => void;
    const hold = new Promise<void>((ok) => (release = ok));
    let running = false;
    s.nightly.copyNow = async () => {
      if (running) throw new Refused('a copy is already running');
      running = true;
      await hold;
      running = false;
      return [{ copied: 1, skipped: 0, target: 'D:\\shop-backups' }];
    };
    const first = post('/api/upkeep/copy-backups', {});
    await new Promise((ok) => setTimeout(ok, 50));
    expect(await post('/api/upkeep/copy-backups', {})).toEqual([409, { error: 'a copy is already running' }]);
    expect((await get('/api/upkeep/status'))[0]).toBe(200); // not frozen while it copies
    release();
    expect(await first).toEqual([200, { copies: [{ copied: 1, skipped: 0, target: 'D:\\shop-backups' }] }]);
  });
});

describe('who may', () => {
  beforeEach(async () => {
    s = await makeServer();
    a = await s.admin();
    filled('2026-11-15');
    bill('9000001', '2026-11-20');
  });
  afterEach(() => s.close());

  const GETS = ['/api/upkeep/status', '/api/invoices', '/api/invoices/im9000001', '/api/customers/5550100000', '/api/needs-bill'];
  const POSTS: Array<[string, unknown]> = [
    ['/api/upkeep/import', {}],
    ['/api/upkeep/copy-backups', {}],
    ['/api/invoices/t1/link', { invoice_no: '9000001', version: null }],
    ['/api/invoices/t1/unlink', { version: 1 }],
    ['/api/invoices/t1/none', { version: null }],
    ['/api/invoices/t1/final', { parts: 0, labor: 0, supplies: 0, tax: 0, total: 0, version: null }],
  ];

  it('a mechanic gets 403 on every route; no session gets 401', async () => {
    const m = await s.tech('Al Fixit');
    for (const p of GETS) {
      expect([p, (await get(p, m))[0]]).toEqual([p, 403]);
      expect([p, (await get(p, ''))[0]]).toEqual([p, 401]);
    }
    for (const [p, body] of POSTS) {
      expect([p, (await post(p, body, m))[0]]).toEqual([p, 403]);
      expect([p, (await post(p, body, ''))[0]]).toEqual([p, 401]);
    }
    expect(s.nightly.running()).toBe(false); // nothing was started
  });
});

describe('search speed', () => {
  beforeAll(async () => {
    s = await makeServer();
    a = await s.admin();
    const insInv = s.im.prepare(
      `INSERT INTO im_invoices (invoice_no, "date", "key", name, "first", "last", phone, plate, address, parts, labor,
         supplies, discount, deposit, tax, total, balance, tax_rate, hash, lines_hash, first_seen, updated_at, gone_at, plate_norm)
       VALUES (?, ?, '', ?, ?, ?, ?, ?, '', 1000, 2000, 150, 0, 0, 120, 3270, 0, 0.0375, '', '', '', '', '', ?)`,
    );
    const insLine = s.im.prepare(
      `INSERT INTO im_lines (invoice_no, line_no, code, description, kind, qty, unit, amount, vehicle, year, make, model, trim)
       VALUES (?, ?, 'P1', 'TEST PART', 'part', 1, 1000, 1000, '2019 Honda HR-V EX', 2019, 'Honda', 'HR-V', 'EX')`,
    );
    s.im.exec('BEGIN');
    for (let i = 0; i < 50_000; i++) {
      const no = String(9000001 + i);
      const d = new Date(2015, 0, 1 + Math.floor(i / 12));
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const plate = `T${String(i % 20_000).padStart(5, '0')}-X`;
      insInv.run(no, date, `TESTCASE${i % 7000}`, `JANE${i % 300}`, `TESTCASE${i % 7000}`, `555${String(i % 9_000_000).padStart(7, '0')}`, plate, normalPlate(plate));
      for (let k = 1; k <= 5; k++) insLine.run(no, k);
    }
    s.im.exec('COMMIT');
    for (let i = 0; i < 200; i++) filled('2026-11-15', { plate: `tst-${i}`, vin: `1TESTVIN00000${String(i).padStart(4, '0')}` });
  });
  afterAll(() => s.close());

  const SEARCHES = [
    {},
    { name: 'case69' },
    { name: 'jane1 testcase2' },
    { name: 'zzzz' },
    { phone: '0004' },
    { phone: '5550012345' },
    { tag: '1234' },
    { tag: 'zz' },
    { vin: 'vin0000001' },
    { from: '2020-01-01', to: '2020-12-31' },
    { name: 'case', phone: '555', tag: 'T', from: '2016-01-01' },
    { page: 900 },
  ];

  it('each search of 50 000 bills and 250 000 lines takes under 300 ms', () => {
    expect((s.im.prepare('SELECT count(*) AS n FROM im_lines').get() as { n: number }).n).toBe(250_000);
    s.history.search({}); // warm the page cache once, as a running server is
    for (const q of SEARCHES) {
      // the best of 3: what the search costs, not a moment when other test workers held the CPU
      let ms = Infinity;
      let r = s.history.search(q);
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        r = s.history.search(q);
        ms = Math.min(ms, performance.now() - t0);
      }
      // everyday searches (page 1, filtered) must stay under 300 ms. Paging deep with OFFSET (page 900 reads past
      // 45 000 rows) is rare, so it only has to stay usable: 1000 ms, which also holds under a full parallel run.
      const limit = (q.page ?? 1) > 1 ? 1000 : 300;
      expect([q, r.rows.length <= 50, ms < limit]).toEqual([q, true, true]);
    }
    expect(s.history.search({ name: 'case69' }).total).toBeGreaterThan(0);
  });

  it('over HTTP too', async () => {
    const t0 = performance.now();
    const [code] = await get('/api/invoices?name=case69&page=2');
    expect(code).toBe(200);
    expect(performance.now() - t0).toBeLessThan(300);
  });
});

describe('our own bills in Bill history', () => {
  const BY = 'admin#1';
  const NOW = new Date(2026, 10, 23, 14, 22, 5);
  const LATER = new Date(2026, 10, 24, 9, 5, 0);
  let id: number;
  beforeEach(async () => {
    s = await makeServer();
    a = await s.admin();
    s.deps.ownBills.confirmFirst('9000010', BY);
    id = s.store.create({
      first: 'Jane',
      last: 'Doe',
      phone: '(555)010-0000',
      year: '2015',
      make: 'Honda',
      model: 'Civic',
      plate: 'xks-4827',
      vin: '1TESTVIN000000009',
      mechanic: 'Al Fixit',
      lines: [{ desc: 'BRAKE PADS', qty: 1, price: 100, labor: 50 }, { desc: 'OIL FILTER', qty: 2, price: 7.5 }],
    }).id;
    s.deps.ownBills.approve(id, 1, BY, NOW);
  });
  afterEach(() => s.close());

  it("the ticket's row has the bill's number and total", async () => {
    const [code, body] = await get('/api/invoices?name=doe');
    expect(code).toBe(200);
    expect(body.rows).toEqual([
      expect.objectContaining({ key: `t${id}`, invoice_no: '9000010', ticket_id: id, total: 180.65 }),
    ]);
  });

  it('is found by tag, name, phone, VIN and date', async () => {
    for (const q of ['tag=xks4827', 'name=jane', 'phone=5550100000', 'vin=1TESTVIN000000009']) expect([q, await keys(`?${q}`)]).toEqual([q, [`t${id}`]]);
    const day = s.deps.history.search({ name: 'jane' }).rows[0]?.date;
    expect(await keys(`?from=${day}&to=${day}`)).toEqual([`t${id}`]);
  });

  it("the detail's after side is the latest snapshot, from our own bill", async () => {
    const [code, b] = await get(`/api/invoices/t${id}`);
    expect(code).toBe(200);
    expect(b.after).toEqual({
      invoice_no: '9000010',
      date: '2026-11-23',
      parts: 115,
      labor: 50,
      supplies: 8.25,
      discount: 0,
      deposit: 0,
      tax: 7.4,
      total: 180.65,
      balance: 180.65,
      lines: [
        { code: '', description: 'BRAKE PADS', kind: 'part', qty: 1, unit: 100, amount: 100 },
        { code: '', description: 'OIL FILTER', kind: 'part', qty: 2, unit: 7.5, amount: 15 },
        { code: '', description: 'Remove & Install: BRAKE PADS', kind: 'labor', qty: 1, unit: 50, amount: 50 },
      ],
      source: 'ours',
      gone: false,
    });
    expect(b.link).toMatchObject({ source: 'ours' });
    expect(b.own).toEqual({ invoice_no: '9000010', revisions: 1, revised_at: null, revised_by: null });
  });

  it('after a fix: revision 2, who and when, and the new amounts', async () => {
    s.deps.ownBills.fix('9000010', { lines: [{ desc: 'BRAKE PADS', qty: 1, price: 100, labor: 60 }] }, 2, 'admin#2', LATER);
    const [, b] = await get(`/api/invoices/t${id}`);
    expect(b.own).toEqual({ invoice_no: '9000010', revisions: 2, revised_at: '2026-11-24T09:05:00', revised_by: 'admin#2' });
    expect(b.after).toMatchObject({ date: '2026-11-23', labor: 60, source: 'ours' });
    const [, rows] = await get('/api/invoices?name=doe');
    expect(rows.rows[0].total).toBe(b.after.total);
  });

  it.each([
    ['revision rows are missing', () => s.db.prepare('DELETE FROM own_bill_revisions').run()],
    ['a snapshot is damaged', () => s.db.prepare("UPDATE own_bill_revisions SET snapshot = '{\"amounts\":5'").run()],
    ['a snapshot has the wrong shape', () => s.db.prepare("UPDATE own_bill_revisions SET snapshot = '{\"parts\":1}'").run()],
  ])('when %s: 200, from the final, own.revisions 0', async (_n, damage) => {
    damage();
    const [code, b] = await get(`/api/invoices/t${id}`);
    expect(code).toBe(200);
    expect(b.after).toMatchObject({ source: 'ours', invoice_no: '9000010', total: 180.65, lines: [] });
    expect(b.own).toEqual({ invoice_no: '9000010', revisions: 0, revised_at: null, revised_by: null });
    expect(b.link).toMatchObject({ source: 'ours' });
  });

  it('other bills have own: null', async () => {
    const other = filled('2026-11-15', { first: 'Ann', last: 'Sample', plate: 'qqq-111', phone: '(555) 010-0003' });
    expect((await get(`/api/invoices/t${other}`))[1].own).toBeNull();
  });
});
