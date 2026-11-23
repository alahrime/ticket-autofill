// Our own bills: the first number, approve, fix and read (billing/ownbills.ts), the invoice_finals CHECK
// migration, and the /api/own-bills routes. Made-up data only: JANE DOE, (555)010-0000, XKS-4827, 9000001+.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { billAmounts, Refused, Stale, type Ticket } from '@shop/domain';
import { OwnBills } from '../src/billing/ownbills';
import { openDb } from '../src/db';
import { AlreadyBilled, BadInput, NotConfirmed, NotFound } from '../src/errors';
import { History } from '../src/history/bills';
import { LinkStore } from '../src/history/links';
import { openImDb } from '../src/invomax/imdb';
import { TicketStore } from '../src/store';
import { makeServer, type TestServer } from './helpers';
import { tempDir } from './py';

jest.setTimeout(60_000);

const JANE = {
  first: 'jane',
  last: 'doe',
  phone: '(555)010-0000',
  year: '2015',
  make: 'honda',
  model: 'civic',
  plate: 'xks-4827',
  request: 'brakes',
  mechanic: 'Al Fixit',
  odometer: '123456',
  vin: '',
  lines: [
    { desc: 'BRAKE PADS', qty: 1, price: 100, labor: 50 },
    { desc: 'DIAGNOSTIC', labor: 55 },
    { desc: 'OIL FILTER', qty: 2, price: 7.5 },
  ],
  deposits: [{ amount: 20, method: 'cash' }],
};

const NOW = new Date(2026, 10, 23, 14, 22, 5);
const LATER = new Date(2026, 10, 24, 9, 5, 0);
const BY = 'admin#1';
const SHOP = { shopInfo: { name: 'MADE-UP AUTO', address: ['1 TEST ST', 'ANYTOWN, VA 00000'], phone: '(555)010-0001', hours: 'M-F 8-7' } };

let tmp: { dir: string; done: () => void };
let db: DatabaseSync;
let im: DatabaseSync;
let tickets: TicketStore;
let links: LinkStore;
let own: OwnBills;

function imBill(no: string, date: string, plate = 'XKS-4827'): void {
  im.prepare(
    `INSERT INTO im_invoices (invoice_no, "date", "key", name, "first", "last", phone, plate, address, parts, labor,
       supplies, discount, deposit, tax, total, balance, tax_rate, hash, lines_hash, first_seen, updated_at, gone_at, plate_norm)
     VALUES (?, ?, '', 'JANE DOE', 'JANE', 'DOE', '5550100000', ?, '', 0, 0, 0, 0, 0, 0, 100, 0, 0, '', '', '', '', '', ?)`,
  ).run(no, date, plate, plate.replace(/[^A-Z0-9]/gi, '').toUpperCase());
}

const ticket = (extra: Record<string, unknown> = {}): number => tickets.create({ ...JANE, ...extra }).id;

/** `x`, or a failed test when it is missing. */
function there<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('missing');
  return x;
}
const stored = (id: number): Ticket => there(tickets.get(id));
const finals = (): Record<string, unknown>[] => db.prepare('SELECT * FROM invoice_finals ORDER BY ticket_id').all() as never;
const revisions = (): { invoice_no: string; revision: number; snapshot: string; at: string; by: string }[] =>
  db.prepare('SELECT * FROM own_bill_revisions ORDER BY invoice_no, revision').all() as never;
const counter = (): { next_no: number } | undefined => db.prepare('SELECT next_no FROM own_bill_counter').get() as never;

/** Writes the ticket's stored JSON as given (damaged data the normal save would never write). */
function rawData(id: number, change: (d: Record<string, unknown>) => void): void {
  const row = db.prepare('SELECT data FROM tickets WHERE id = ?').get(id) as { data: string };
  const d = JSON.parse(row.data) as Record<string, unknown>;
  change(d);
  db.prepare('UPDATE tickets SET data = ? WHERE id = ?').run(JSON.stringify(d), id);
}

beforeEach(() => {
  tmp = tempDir();
  db = openDb(join(tmp.dir, 'tickets.db'));
  im = openImDb(join(tmp.dir, 'invomax.db'));
  tickets = new TicketStore(db);
  links = new LinkStore(db, im);
  own = new OwnBills(db, im, SHOP, () => NOW);
  for (let n = 9000001; n <= 9000005; n++) imBill(String(n), '2026-11-20');
  imBill('48888884', '2026-11-21'); // the outlier: 8 digits
});

afterEach(() => {
  db.close();
  im.close();
  tmp.done();
});

describe('the first number', () => {
  it('is the highest 7-digit InvoMax number + 1 (the 8-digit outlier and bills over 400 days old ignored)', () => {
    imBill('9500000', '2025-10-01'); // 418 days before NOW
    expect(own.firstNumber()).toEqual({
      confirmed: false,
      proposed: '9000006',
      from: { source: 'invomax', invoice_no: '9000005', date: '2026-11-20', ticket_id: null },
    });
  });

  it('leaves out an InvoMax number far above the main run (a typo in InvoMax)', () => {
    imBill('9030316', '2026-11-21'); // more than 10000 above the median of the last 400 days
    imBill('9010004', '2026-11-21'); // exactly the median (9000004) + 10000: still in the run
    expect(own.firstNumber()).toMatchObject({ proposed: '9010005', from: { source: 'invomax', invoice_no: '9010004' } });
  });

  it('is 1 with nothing used at all, and says so', () => {
    im.exec('DELETE FROM im_invoices');
    expect(own.firstNumber()).toEqual({
      confirmed: false,
      proposed: '1',
      from: { source: 'none', invoice_no: null, date: null, ticket_id: null },
    });
  });

  it('is confirmed once, never at or below the highest used', () => {
    expect(() => own.confirmFirst('9000005', BY)).toThrow(BadInput);
    expect(() => own.confirmFirst('900001', BY)).toThrow(BadInput); // 7 digits only
    expect(() => own.confirmFirst('09000010', BY)).toThrow(BadInput);
    expect(counter()).toBeUndefined();
    own.confirmFirst('9000010', BY);
    expect(own.firstNumber()).toMatchObject({ confirmed: true, proposed: '9000010', from: { source: 'counter' } });
    expect(() => own.confirmFirst('9000020', BY)).toThrow(Refused); // 409
    expect(counter()).toEqual({ next_no: 9000010 });
  });

  it('counts typed finals (and ours), not InvoMax links, among the numbers used', () => {
    const id = ticket();
    tickets.save({ ...stored(id), status: 'filled' }, 1);
    links.typedFinal(id, { invoice_no: '9000007', parts: 0, labor: 0, supplies: 0, tax: 0, total: 0 }, null, BY);
    expect(own.firstNumber()).toMatchObject({
      proposed: '9000008',
      from: { source: 'typed', invoice_no: '9000007', date: null, ticket_id: id },
    });
  });
});

describe('approve', () => {
  beforeEach(() => own.confirmFirst('9000010', BY));

  it('numbers, fills and stores the bill in one go', () => {
    const id = ticket();
    const bill = own.approve(id, 1, BY, NOW);
    const t = stored(id);
    const amounts = billAmounts(t);
    expect(bill).toMatchObject({
      invoice_no: '9000010',
      revision: 1,
      date: '2026-11-23',
      time: '14:22',
      customer: { first: 'JANE', last: 'DOE', phone: '(555)010-0000' },
      vehicle: { year: '2015', make: 'HONDA', model: 'CIVIC', plate: 'XKS-4827', vin: '', odometer: '123456' },
      mechanic: 'Al Fixit',
      shop: SHOP.shopInfo,
      amounts,
    });
    expect(bill.labor).toEqual([
      { desc: 'Remove & Install: BRAKE PADS', amount: 5000 },
      { desc: 'DIAGNOSTIC', amount: 5500 },
    ]);
    expect(bill.parts).toEqual([
      { desc: 'BRAKE PADS', qty: 1, price: 10000, total: 10000 },
      { desc: 'OIL FILTER', qty: 2, price: 750, total: 1500 },
    ]);
    expect(amounts).toEqual({ parts: 11500, labor: 10500, supplies: 1100, tax: 756, total: 23856, deposit: 2000, balance: 21856 });
    expect([t.status, t.version]).toEqual(['filled', 2]);
    expect(finals()).toMatchObject([
      { ticket_id: id, invoice_no: '9000010', source: 'ours', linked_by: BY, parts: 11500, labor: 10500, supplies: 1100, tax: 756, total: 23856 },
    ]);
    const [rev] = revisions();
    expect(rev).toMatchObject({ invoice_no: '9000010', revision: 1, by: BY, at: '2026-11-23T14:22:05' });
    expect(JSON.parse(there(rev).snapshot)).toEqual(bill);
    expect(counter()).toEqual({ next_no: 9000011 });
  });

  it('the next bill gets the next number', () => {
    own.approve(ticket(), 1, BY, NOW);
    expect(own.approve(ticket(), 1, BY, NOW).invoice_no).toBe('9000011');
  });

  it('two approves of one ticket give one bill; the second hears its number (409)', () => {
    const id = ticket();
    own.approve(id, 1, BY, NOW);
    const e = (() => {
      try {
        own.approve(id, 1, BY, NOW);
      } catch (x) {
        return x;
      }
      return null;
    })();
    expect(e).toBeInstanceOf(AlreadyBilled);
    expect((e as AlreadyBilled).invoice_no).toBe('9000010');
    expect(finals()).toHaveLength(1);
    expect(revisions()).toHaveLength(1);
    expect(counter()).toEqual({ next_no: 9000011 });
  });

  it('a stale version leaves no bill, no used number and the ticket unfilled', () => {
    const id = ticket();
    tickets.save({ ...stored(id), notes: 'changed on the phone' }, 1); // now version 2
    expect(() => own.approve(id, 1, BY, NOW)).toThrow(Stale);
    expect(finals()).toEqual([]);
    expect(revisions()).toEqual([]);
    expect(tickets.get(id)?.status).toBe('waiting');
    expect(counter()).toEqual({ next_no: 9000010 });
    expect(own.approve(id, 2, BY, NOW).invoice_no).toBe('9000010');
  });

  it('after the confirm, a typed final at or above the next number is refused (409): InvoMax makes no new bills', () => {
    const other = ticket();
    tickets.save({ ...stored(other), status: 'filled' }, 1);
    const typed = (no: string): void =>
      links.typedFinal(other, { invoice_no: no, parts: 0, labor: 0, supplies: 0, tax: 0, total: 0 }, null, BY);
    for (const no of ['9000010', '9000020', '9999999']) expect(() => typed(no)).toThrow(Refused);
    expect(() => typed('9000010')).toThrow(/9000010/);
    expect(finals()).toEqual([]);
    typed('9000009'); // below: an old InvoMax bill typed late
    expect(own.approve(ticket(), 1, BY, NOW).invoice_no).toBe('9000010');
  });

  it('before the confirm, a typed final of any number is taken as it is', () => {
    db.exec('DELETE FROM own_bill_counter');
    const other = ticket();
    tickets.save({ ...stored(other), status: 'filled' }, 1);
    links.typedFinal(other, { invoice_no: '9000020', parts: 0, labor: 0, supplies: 0, tax: 0, total: 0 }, null, BY);
    expect(own.firstNumber()).toMatchObject({ proposed: '9000021', from: { source: 'typed', ticket_id: other } });
  });

  it('an InvoMax bill imported after the confirm is never reused either', () => {
    imBill('9000010', '2026-11-23'); // made on go-live morning, imported late
    imBill('9000012', '2026-11-23');
    expect(own.approve(ticket(), 1, BY, NOW).invoice_no).toBe('9000013');
  });

  it('refuses a ticket with no mechanic or no line (400), a filled or deleted one (409), an unknown one (404)', () => {
    expect(() => own.approve(ticket({ mechanic: '' }), 1, BY, NOW)).toThrow(BadInput);
    expect(() => own.approve(ticket({ lines: [] }), 1, BY, NOW)).toThrow(BadInput);
    const f = ticket();
    tickets.save({ ...stored(f), status: 'filled' }, 1);
    expect(() => own.approve(f, 2, BY, NOW)).toThrow(Refused);
    const d = ticket();
    tickets.save({ ...stored(d), status: 'deleted' }, 1);
    expect(() => own.approve(d, 2, BY, NOW)).toThrow(Refused);
    expect(() => own.approve(999, 1, BY, NOW)).toThrow(NotFound);
    expect(finals()).toEqual([]);
    expect(counter()).toEqual({ next_no: 9000010 });
  });

  it('refuses damaged lines or deposits rather than bill odd values (400), writing nothing', () => {
    const bad: Array<(d: Record<string, unknown>) => void> = [
      (d) => (d['lines'] = [{ desc: 'PADS', qty: 1, price: -5, labor: null, code: '', id: 1 }]),
      (d) => (d['lines'] = [{ desc: 'PADS', qty: 1, price: 'lots', labor: null, code: '', id: 1 }]),
      (d) => (d['lines'] = [{ desc: 'PADS', qty: 0, price: 10, labor: null, code: '', id: 1 }]),
      (d) => (d['lines'] = [{ desc: 'PADS', qty: 1, price: 1e300, labor: null, code: '', id: 1 }]),
      (d) => (d['lines'] = [{ desc: 'PADS', qty: 1, price: null, labor: Number.MAX_VALUE, code: '', id: 1 }]),
      (d) => (d['lines'] = [7]),
      (d) => (d['lines'] = { desc: 'PADS' }),
      (d) => (d['deposits'] = 'twenty'),
      (d) => (d['deposits'] = [{ amount: -20, method: 'cash', date: '2026-11-23', note: '', id: 1 }]),
    ];
    for (const change of bad) {
      const id = ticket();
      rawData(id, change);
      expect(() => own.approve(id, 1, BY, NOW)).toThrow(BadInput);
      expect(tickets.get(id)?.status).toBe('waiting');
    }
    expect(finals()).toEqual([]);
    expect(revisions()).toEqual([]);
    expect(counter()).toEqual({ next_no: 9000010 });
  });

  it('nothing is numbered before the first number is confirmed (428)', () => {
    const other = openDb(join(tmp.dir, 'other.db'));
    try {
      const fresh = new OwnBills(other, im, SHOP, () => NOW);
      const id = new TicketStore(other).create(JANE).id;
      expect(() => fresh.approve(id, 1, BY, NOW)).toThrow(NotConfirmed);
      expect(new TicketStore(other).get(id)?.status).toBe('waiting');
    } finally {
      other.close();
    }
  });

  it('autoLink leaves a ticket we billed alone', () => {
    const id = ticket();
    own.approve(id, 1, BY, NOW);
    imBill('9000006', '2026-11-23'); // same plate, same day: would auto-link an InvoMax-billed ticket
    expect(links.autoLink(NOW)).toBe(0);
    expect(finals()).toMatchObject([{ ticket_id: id, invoice_no: '9000010', source: 'ours' }]);
    expect(links.needsBill().map((n) => n.ticket_id)).not.toContain(id);
  });

  it("Bill history's link, unlink, none and typed final refuse our own bill", () => {
    const id = ticket();
    own.approve(id, 1, BY, NOW);
    const v = there(links.final(id)).version;
    expect(() => links.unlink(id, v, BY)).toThrow(Refused);
    expect(() => links.markNone(id, v, BY)).toThrow(Refused);
    expect(() => links.link(id, '9000001', v, BY)).toThrow(Refused);
    expect(() => links.typedFinal(id, { parts: 0, labor: 0, supplies: 0, tax: 0, total: 0 }, v, BY)).toThrow(Refused);
    expect(finals()).toMatchObject([{ ticket_id: id, invoice_no: '9000010', source: 'ours' }]);
  });
});

describe('fix', () => {
  beforeEach(() => own.confirmFirst('9000010', BY));

  it('stores revision 2 under the same number and date; revision 1 is never changed', () => {
    const id = ticket();
    const first = own.approve(id, 1, BY, NOW);
    const stored1 = there(revisions()[0]).snapshot;
    const lines = [{ desc: 'BRAKE PADS', qty: 1, price: 100, labor: 60 }];
    const fixed = own.fix('9000010', { first: 'john', plate: 'tst-0001', lines }, 2, 'admin#2', LATER);
    expect(fixed).toMatchObject({
      invoice_no: '9000010',
      revision: 2,
      date: first.date,
      time: first.time,
      customer: { first: 'JOHN', last: 'DOE' },
      vehicle: { plate: 'TST-0001' },
    });
    expect(fixed.amounts).toEqual(billAmounts({ lines: stored(id).lines, deposits: stored(id).deposits }));
    expect(fixed.amounts.labor).toBe(6000);
    const revs = revisions();
    expect(revs.map((r) => [r.revision, r.by, r.at])).toEqual([
      [1, BY, '2026-11-23T14:22:05'],
      [2, 'admin#2', '2026-11-24T09:05:00'],
    ]);
    expect(there(revs[0]).snapshot).toBe(stored1);
    expect(finals()).toMatchObject([
      { ticket_id: id, invoice_no: '9000010', source: 'ours', labor: 6000, total: fixed.amounts.total, version: 2 },
    ]);
    expect(tickets.get(id)).toMatchObject({ status: 'filled', first: 'JOHN', version: 3 });
    expect(counter()).toEqual({ next_no: 9000011 }); // no number used
    const got = own.latest('9000010');
    expect(got).toEqual({
      bill: fixed,
      ticket_id: id,
      revisions: [
        { revision: 1, at: '2026-11-23T14:22:05', by: BY },
        { revision: 2, at: '2026-11-24T09:05:00', by: 'admin#2' },
      ],
    });
  });

  it('every revision stays readable as stored; Bill history lists them with when and who', () => {
    const id = ticket();
    const first = own.approve(id, 1, BY, NOW);
    const fixed = own.fix('9000010', { first: 'john' }, 2, 'admin#2', LATER);
    const list = [
      { revision: 1, at: '2026-11-23T14:22:05', by: BY },
      { revision: 2, at: '2026-11-24T09:05:00', by: 'admin#2' },
    ];
    expect(own.revision('9000010', 1)).toEqual({ bill: first, revisions: list, ticket_id: id });
    expect(own.revision('9000010', 2)?.bill).toEqual(fixed);
    expect(own.revision('9000010', 3)).toBeNull();
    expect(own.revision('9000099', 1)).toBeNull();
    const h = new History(join(tmp.dir, 'tickets.db'), join(tmp.dir, 'invomax.db'), own);
    try {
      expect(h.bill(`t${id}`)?.own).toEqual({
        invoice_no: '9000010',
        revisions: 2,
        revised_at: '2026-11-24T09:05:00',
        revised_by: 'admin#2',
        history: list,
      });
    } finally {
      h.close();
    }
  });

  it("Bill history dates our bill by its own day, not the day it was fixed", () => {
    const id = ticket();
    own.approve(id, 1, BY, NOW);
    own.fix('9000010', { first: 'john' }, 2, BY, LATER);
    rawData(id, (d) => (d['updated'] = '2026-12-02T10:00:00')); // the ticket saved on a later day
    const h = new History(join(tmp.dir, 'tickets.db'), join(tmp.dir, 'invomax.db'), own);
    try {
      const day = h.search({ from: '2026-11-23', to: '2026-11-23' }).rows.filter((r) => r.ticket_id === id);
      expect(day).toMatchObject([{ key: `t${id}`, date: '2026-11-23', invoice_no: '9000010' }]);
      expect(h.search({ from: '2026-12-02', to: '2026-12-02' }).rows.filter((r) => r.ticket_id === id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("keeps revision 1's shop details, even after the settings changed", () => {
    const cfg = { shopInfo: { ...SHOP.shopInfo, address: [...SHOP.shopInfo.address] } };
    const mine = new OwnBills(db, im, cfg, () => NOW);
    const first = mine.approve(ticket(), 1, BY, NOW);
    cfg.shopInfo = { name: 'OTHER NAME', address: ['2 ELSEWHERE RD'], phone: '(555)010-0002', hours: 'SAT 9-1' };
    const fixed = mine.fix(first.invoice_no, { first: 'john' }, 2, BY, LATER);
    expect(fixed.shop).toEqual(first.shop);
    expect(fixed.shop).toEqual(SHOP.shopInfo);
    expect(mine.approve(ticket(), 1, BY, NOW).shop).toEqual(cfg.shopInfo); // a new bill takes the settings of now
  });

  it('a stale version or a bad edit stores nothing; an unknown number is 404', () => {
    const id = ticket();
    own.approve(id, 1, BY, NOW);
    expect(() => own.fix('9000010', { first: 'john' }, 1, BY, LATER)).toThrow(Stale);
    expect(() => own.fix('9000010', { lines: [] }, 2, BY, LATER)).toThrow(); // keep at least one line
    expect(() => own.fix('9000010', { mechanic: '' }, 2, BY, LATER)).toThrow();
    expect(() => own.fix('9000099', { first: 'john' }, 2, BY, LATER)).toThrow(NotFound);
    expect(revisions()).toHaveLength(1);
    expect(tickets.get(id)).toMatchObject({ first: 'JANE', version: 2 });
    expect(own.latest('9000099')).toBeNull();
  });

  it('refuses a billed ticket whose stored lines became damaged', () => {
    const id = ticket();
    own.approve(id, 1, BY, NOW);
    rawData(id, (d) => (d['lines'] = [{ desc: 'PADS', qty: 1, price: -1, labor: null, code: '', id: 1 }]));
    expect(() => own.fix('9000010', { first: 'john' }, 2, BY, LATER)).toThrow(BadInput);
    expect(revisions()).toHaveLength(1);
  });
});

describe('the invoice_finals CHECK migration', () => {
  it("an old table keeps its rows and its UNIQUE invoice_no, and takes 'ours'", () => {
    const file = join(tmp.dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE invoice_finals (
      ticket_id INTEGER PRIMARY KEY,
      invoice_no TEXT UNIQUE,
      source TEXT NOT NULL CHECK (source IN ('invomax','typed','none')),
      linked_at TEXT NOT NULL,
      linked_by TEXT NOT NULL,
      parts INTEGER, labor INTEGER, supplies INTEGER, tax INTEGER, total INTEGER,
      version INTEGER NOT NULL DEFAULT 1
    )`);
    old.prepare(
      "INSERT INTO invoice_finals VALUES (7, '9000003', 'typed', '2026-11-20T10:00:00', 'admin#1', 1, 2, 3, 4, 10, 3)",
    ).run();
    old.close();
    const tdb = openDb(file);
    try {
      new LinkStore(tdb, im);
      new LinkStore(tdb, im); // a second open changes nothing
      expect(tdb.prepare('SELECT * FROM invoice_finals').all()).toEqual([
        {
          ticket_id: 7, invoice_no: '9000003', source: 'typed', linked_at: '2026-11-20T10:00:00', linked_by: 'admin#1',
          parts: 1, labor: 2, supplies: 3, tax: 4, total: 10, version: 3,
        },
      ]);
      const sql = (tdb.prepare("SELECT sql FROM sqlite_master WHERE name = 'invoice_finals'").get() as { sql: string }).sql;
      expect(sql).toContain("'ours'");
      tdb.prepare("INSERT INTO invoice_finals (ticket_id, invoice_no, source, linked_at, linked_by) VALUES (8, '9000010', 'ours', 'x', 'y')").run();
      expect(() =>
        tdb.prepare("INSERT INTO invoice_finals (ticket_id, invoice_no, source, linked_at, linked_by) VALUES (9, '9000010', 'typed', 'x', 'y')").run(),
      ).toThrow(/UNIQUE/);
      expect(() =>
        tdb.prepare("INSERT INTO invoice_finals (ticket_id, invoice_no, source, linked_at, linked_by) VALUES (9, '9000011', 'other', 'x', 'y')").run(),
      ).toThrow(/CHECK/);
    } finally {
      tdb.close();
    }
  });
});

describe('the /api/own-bills routes', () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await makeServer();
  });
  afterEach(() => s.close());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type J = any;
  const desk = async (extra: Record<string, unknown> = {}): Promise<{ a: string; id: number }> => {
    const a = await s.admin();
    const t = (await s.call('/api/tickets', { ...JANE, ...extra }, a)).body as J;
    return { a, id: t.id as number };
  };
  const on = (importing = false): void => {
    s.config.ownBilling = true;
    s.config.importInvomax = importing;
  };

  it('are 404 while ownBilling is off (401 signed out)', async () => {
    const { a, id } = await desk();
    expect(s.config.ownBilling).toBe(false);
    const asked: Array<[string, unknown]> = [
      ['/api/own-bills/first-number', undefined],
      ['/api/own-bills/first-number', { invoice_no: '9000010' }],
      [`/api/tickets/${id}/bill`, { version: 1 }],
      ['/api/own-bills/9000010', undefined],
      ['/api/own-bills/9000010/fix', { version: 1, fields: {} }],
      [`/api/own-bills/by-ticket/${id}`, undefined],
    ];
    for (const [path, body] of asked) {
      expect([path, (await s.call(path, body, a)).status]).toEqual([path, 404]);
      expect([path, (await s.call(path, body)).status]).toEqual([path, 401]);
    }
  });

  it('are the admin\'s: 403 for a mechanic', async () => {
    on();
    const m = await s.tech('Al Fixit');
    expect((await s.call('/api/own-bills/first-number', undefined, m)).status).toBe(403);
    expect((await s.call('/api/own-bills/first-number', { invoice_no: '9000010' }, m)).status).toBe(403);
    expect((await s.call('/api/tickets/1/bill', { version: 1 }, m)).status).toBe(403);
    expect((await s.call('/api/own-bills/9000010', undefined, m)).status).toBe(403);
    expect((await s.call('/api/own-bills/9000010/fix', { version: 1, fields: {} }, m)).status).toBe(403);
    expect((await s.call('/api/own-bills/by-ticket/1', undefined, m)).status).toBe(403);
  });

  it("by-ticket: a ticket's own bill number (200), else 404", async () => {
    on();
    const { a, id } = await desk();
    expect((await s.call(`/api/own-bills/by-ticket/${id}`, undefined, a)).status).toBe(404); // not billed yet
    await s.call('/api/own-bills/first-number', { invoice_no: '9000010' }, a);
    expect((await s.call(`/api/tickets/${id}/bill`, { version: 1 }, a)).status).toBe(201);
    const got = await s.call(`/api/own-bills/by-ticket/${id}`, undefined, a);
    expect([got.status, got.body]).toEqual([200, { invoice_no: '9000010' }]);
    expect((await s.call('/api/own-bills/by-ticket/999', undefined, a)).status).toBe(404);
    expect((await s.call('/api/own-bills/by-ticket/abc', undefined, a)).status).toBe(404);
    // a filled ticket whose final is not ours (here: no bill in InvoMax) is 404 too
    const other = await desk();
    await s.call(`/api/tickets/${other.id}/move`, { version: 1, to: 'approved' }, a);
    expect((await s.call(`/api/tickets/${other.id}/move`, { version: 2, to: 'filled' }, a)).status).toBe(200);
    s.deps.links.markNone(other.id, null, BY);
    expect((await s.call(`/api/own-bills/by-ticket/${other.id}`, undefined, a)).status).toBe(404);
  });

  it('a failed InvoMax import numbers nothing (503)', async () => {
    on(true); // the temp InvoMax folder is empty: the import fails
    const a = await s.admin();
    const g = await s.call('/api/own-bills/first-number', undefined, a);
    expect([g.status, typeof (g.body as J).error]).toEqual([503, 'string']);
    const p = await s.call('/api/own-bills/first-number', { invoice_no: '9000010' }, a);
    expect(p.status).toBe(503);
    expect(s.deps.ownBills.firstNumber().confirmed).toBe(false);
  });

  it('runs the import before proposing and before confirming; once confirmed, GET only reports', async () => {
    on(true);
    let imports = 0;
    let next = 9000007;
    s.nightly.importWait = async () => {
      imports++;
      s.im.prepare(
        `INSERT INTO im_invoices (invoice_no, "date", "key", name, "first", "last", phone, plate, address, parts, labor,
           supplies, discount, deposit, tax, total, balance, tax_rate, hash, lines_hash, first_seen, updated_at, gone_at, plate_norm)
         VALUES (?, date('now', 'localtime'), '', 'JANE DOE', '', '', '', '', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, '', '', '', '', '', '')`,
      ).run(String(next++)); // a bill InvoMax made this morning
      return 'ok';
    };
    const a = await s.admin();
    const g = await s.call('/api/own-bills/first-number', undefined, a);
    expect([g.status, g.body]).toEqual([
      200,
      { confirmed: false, proposed: '9000008', from: { source: 'invomax', invoice_no: '9000007', date: (g.body as J).from?.date, ticket_id: null } },
    ]);
    expect((g.body as J).from.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // meanwhile InvoMax made 9000008 too: the POST's own import sees it
    const low = await s.call('/api/own-bills/first-number', { invoice_no: '9000008' }, a);
    expect(low.status).toBe(400);
    expect((await s.call('/api/own-bills/first-number', { invoice_no: 'abc' }, a)).status).toBe(400);
    const ok = await s.call('/api/own-bills/first-number', { invoice_no: '9000020' }, a);
    expect(ok.status).toBe(204);
    const done = imports;
    expect((await s.call('/api/own-bills/first-number', undefined, a)).body).toMatchObject({ confirmed: true, proposed: '9000020' });
    expect((await s.call('/api/own-bills/first-number', { invoice_no: '9000030' }, a)).status).toBe(409);
    expect(imports).toBe(done);
  });

  it('bill: 428 before the confirm, 400 without a mechanic, 201 in dollars, then 409 with its number', async () => {
    on();
    const { a, id } = await desk();
    const early = await s.call(`/api/tickets/${id}/bill`, { version: 1 }, a);
    expect(early.status).toBe(428);
    expect((await s.call('/api/own-bills/first-number', { invoice_no: '9000010' }, a)).status).toBe(204);
    const none = await desk({ mechanic: '' });
    const nm = await s.call(`/api/tickets/${none.id}/bill`, { version: 1 }, a);
    expect([nm.status, typeof (nm.body as J).error]).toEqual([400, 'string']);
    expect((await s.call(`/api/tickets/${id}/bill`, { version: 'x' }, a)).status).toBe(400);
    expect((await s.call('/api/tickets/999/bill', { version: 1 }, a)).status).toBe(404);

    const r = await s.call(`/api/tickets/${id}/bill`, { version: 1 }, a);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      invoice_no: '9000010',
      revision: 1,
      customer: { first: 'JANE', last: 'DOE', phone: '(555)010-0000' },
      labor: [
        { desc: 'Remove & Install: BRAKE PADS', amount: 50 },
        { desc: 'DIAGNOSTIC', amount: 55 },
      ],
      parts: [
        { desc: 'BRAKE PADS', qty: 1, price: 100, total: 100 },
        { desc: 'OIL FILTER', qty: 2, price: 7.5, total: 15 },
      ],
      amounts: { parts: 115, labor: 105, supplies: 11, tax: 7.56, total: 238.56, deposit: 20, balance: 218.56 },
    });
    const again = await s.call(`/api/tickets/${id}/bill`, { version: 1 }, a);
    expect([again.status, (again.body as J).invoice_no]).toEqual([409, '9000010']);

    // stale: 409 with the stored ticket, as the ticket routes
    const other = await desk();
    await s.call(`/api/tickets/${other.id}`, { version: 1, notes: 'phone' }, a);
    const stale = await s.call(`/api/tickets/${other.id}/bill`, { version: 1 }, a);
    expect([stale.status, (stale.body as J).ticket?.version]).toEqual([409, 2]);
  });

  it('a typed final at or above our next number is 409, with a plain message', async () => {
    on();
    const { a, id } = await desk();
    await s.call(`/api/tickets/${id}/move`, { version: 1, to: 'approved' }, a);
    await s.call(`/api/tickets/${id}/move`, { version: 2, to: 'filled' }, a);
    expect((await s.call('/api/own-bills/first-number', { invoice_no: '9000010' }, a)).status).toBe(204);
    const money = { parts: 0, labor: 0, supplies: 0, tax: 0, total: 0, version: null };
    const high = await s.call(`/api/invoices/t${id}/final`, { ...money, invoice_no: '9000010' }, a);
    expect(high.status).toBe(409);
    expect((high.body as J).error).toMatch(/9000010/);
    expect((await s.call(`/api/invoices/t${id}/final`, { ...money, invoice_no: '9000009' }, a)).status).toBe(200);
  });

  it("a ticket with our bill can't be deleted (409), for the admin or its mechanic", async () => {
    on();
    const { a, id } = await desk();
    await s.call('/api/own-bills/first-number', { invoice_no: '9000010' }, a);
    expect((await s.call(`/api/tickets/${id}/bill`, { version: 1 }, a)).status).toBe(201);
    const del = await s.call(`/api/tickets/${id}/delete`, { version: 2 }, a);
    expect(del.status).toBe(409);
    expect((del.body as J).error).toMatch(/#9000010.*Fix bill/);
    expect((del.body as J).ticket).toMatchObject({ id, status: 'filled', version: 2 });
    s.config.ownBilling = false; // the bill stays an issued invoice even with own billing off
    expect((await s.call(`/api/tickets/${id}/delete`, { version: 2 }, a)).status).toBe(409);
    expect(s.deps.store.get(id)?.status).toBe('filled');
    const other = await desk(); // a ticket with no bill of ours still deletes
    expect((await s.call(`/api/tickets/${other.id}/delete`, { version: 1 }, a)).status).toBe(200);
  });

  it('read and fix: the latest revision in dollars, its list, then a fix under the same number', async () => {
    on();
    const { a, id } = await desk();
    await s.call('/api/own-bills/first-number', { invoice_no: '9000010' }, a);
    const bill = (await s.call(`/api/tickets/${id}/bill`, { version: 1 }, a)).body as J;
    const got = await s.call('/api/own-bills/9000010', undefined, a);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ bill, ticket_id: id, revisions: [{ revision: 1 }] });
    expect((await s.call('/api/own-bills/9000099', undefined, a)).status).toBe(404);
    expect((await s.call('/api/own-bills/abc', undefined, a)).status).toBe(404);

    const lines = [{ desc: 'BRAKE PADS', qty: 1, price: 100, labor: 60 }];
    const fixed = await s.call('/api/own-bills/9000010/fix', { version: 2, fields: { first: 'john', lines } }, a);
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({
      invoice_no: '9000010',
      revision: 2,
      date: bill.date,
      time: bill.time,
      customer: { first: 'JOHN' },
      amounts: { labor: 60 },
    });
    const stale = await s.call('/api/own-bills/9000010/fix', { version: 2, fields: { first: 'x' } }, a);
    expect([stale.status, (stale.body as J).ticket?.version]).toEqual([409, 3]);
    const badMech = await s.call('/api/own-bills/9000010/fix', { version: 3, fields: { mechanic: 'Nobody Here' } }, a);
    expect(badMech.status).toBe(400);
    expect((await s.call('/api/own-bills/9000010/fix', { version: 3, fields: 'x' }, a)).status).toBe(400);
    expect((await s.call('/api/own-bills/9000099/fix', { version: 3, fields: {} }, a)).status).toBe(404);
    const after = (await s.call('/api/own-bills/9000010', undefined, a)).body as J;
    expect(after.revisions.map((r: J) => r.revision)).toEqual([1, 2]);
    expect(after.bill.customer.first).toBe('JOHN');
    // an earlier revision, read-only, as it was stored
    const was = await s.call('/api/own-bills/9000010?rev=1', undefined, a);
    expect([was.status, (was.body as J).bill]).toEqual([200, bill]);
    expect((was.body as J).revisions.map((r: J) => r.revision)).toEqual([1, 2]);
    expect(((await s.call('/api/own-bills/9000010?rev=2', undefined, a)).body as J).bill.customer.first).toBe('JOHN');
    expect((await s.call('/api/own-bills/9000010?rev=3', undefined, a)).status).toBe(404);
    expect((await s.call('/api/own-bills/9000010?rev=0', undefined, a)).status).toBe(400);
    expect((await s.call('/api/own-bills/9000010?rev=x', undefined, a)).status).toBe(400);
  });
});
