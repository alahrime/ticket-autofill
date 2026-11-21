import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Refused } from '@shop/domain';
import { openDb } from '../src/db';
import { NotFound } from '../src/errors';
import { LinkStore } from '../src/history/links';
import { openImDb } from '../src/invomax/imdb';
import { normalPlate } from '@shop/invomax';
import { TicketStore } from '../src/store';
import { tempDir } from './py';

const DESK = {
  first: 'jane',
  last: 'testcase',
  phone: '5550100000',
  year: '2019',
  make: 'cadillac',
  model: 'cts',
  plate: 'xks-4827',
  request: 'oil change',
};

let tmp: { dir: string; done: () => void };
let db: DatabaseSync;
let im: DatabaseSync;
let tickets: TicketStore;
let links: LinkStore;

/** A filled ticket whose filled day is `day` (the stored updated time). */
function filled(day: string, extra: Record<string, unknown> = {}): number {
  const t = tickets.create({ ...DESK, ...extra });
  const row = db.prepare('SELECT data FROM tickets WHERE id = ?').get(t.id) as { data: string };
  const data = JSON.parse(row.data) as Record<string, unknown>;
  data['updated'] = `${day}T10:00:00`;
  db.prepare("UPDATE tickets SET status = 'filled', data = ? WHERE id = ?").run(JSON.stringify(data), t.id);
  return t.id;
}

function bill(no: string, date: string, extra: Record<string, unknown> = {}): void {
  const b = {
    name: 'JANE DOE',
    phone: '5550100000',
    plate: 'XKS-4827',
    total: 20000,
    gone_at: '',
    ...extra,
  };
  im.prepare(
    `INSERT INTO im_invoices (invoice_no, "date", "key", name, "first", "last", phone, plate, address, parts, labor,
       supplies, discount, deposit, tax, total, balance, tax_rate, hash, lines_hash, first_seen, updated_at, gone_at, plate_norm)
     VALUES (?, ?, '', ?, '', '', ?, ?, '', 0, 0, 0, 0, 0, 0, ?, 0, 0, '', '', '', '', ?, ?)`,
  ).run(no, date, b.name as string, b.phone as string, b.plate as string, b.total as number, b.gone_at as string, normalPlate(b.plate as string));
}

const finals = (): { ticket_id: number; invoice_no: string | null; source: string; linked_by: string; version: number }[] =>
  db.prepare('SELECT * FROM invoice_finals ORDER BY ticket_id').all() as never;

const NOW = new Date(2026, 10, 21, 9, 0, 0);

beforeEach(() => {
  tmp = tempDir();
  db = openDb(join(tmp.dir, 'tickets.db'));
  im = openImDb(join(tmp.dir, 'invomax.db'));
  tickets = new TicketStore(db);
  links = new LinkStore(db, im);
});

afterEach(() => {
  db.close();
  im.close();
  tmp.done();
});

describe('autoLink', () => {
  it('links the one bill in the window, by auto', () => {
    const id = filled('2026-11-20');
    bill('9000001', '2026-11-21', { plate: 'xks 4827' });
    expect(links.autoLink(NOW)).toBe(1);
    expect(finals()).toMatchObject([{ ticket_id: id, invoice_no: '9000001', source: 'invomax', linked_by: 'auto', version: 1 }]);
    expect(links.autoLink(NOW)).toBe(0);
  });

  it('takes bills from the day before to three days after', () => {
    filled('2026-11-20');
    bill('9000001', '2026-11-19');
    expect(links.autoLink(NOW)).toBe(1);
    const other = filled('2026-11-10', { plate: 'tst-0001' });
    bill('9000002', '2026-11-13', { plate: 'TST-0001' });
    expect(links.autoLink(NOW)).toBe(1);
    expect(finals().find((f) => f.ticket_id === other)?.invoice_no).toBe('9000002');
  });

  it('two candidates mean no link, and needsBill shows both', () => {
    const id = filled('2026-11-20');
    bill('9000001', '2026-11-20', { total: 10000 });
    bill('9000002', '2026-11-21', { total: 25000 });
    expect(links.autoLink(NOW)).toBe(0);
    const [n] = links.needsBill();
    expect(n).toMatchObject({ ticket_id: id, name: 'JANE TESTCASE', vehicle: '2019 CADILLAC CTS', plate: 'XKS-4827', filled: '2026-11-20' });
    expect(n.candidates.map((c) => c.invoice_no).sort()).toEqual(['9000001', '9000002']);
    expect(n.candidates[0].why).toBe('plate');
  });

  it('a plate match on day +4 does not link', () => {
    filled('2026-11-20');
    bill('9000001', '2026-11-24');
    expect(links.autoLink(NOW)).toBe(0);
    expect(links.needsBill()[0].candidates).toHaveLength(1); // still a candidate within 14 days
  });

  it('an empty plate never auto-links', () => {
    filled('2026-11-20', { plate: '' });
    bill('9000001', '2026-11-20', { plate: '' });
    expect(links.autoLink(NOW)).toBe(0);
  });

  it('does not take a bill already linked to another ticket', () => {
    const a = filled('2026-11-20');
    bill('9000001', '2026-11-20');
    expect(links.autoLink(NOW)).toBe(1);
    const b = filled('2026-11-21');
    expect(links.autoLink(NOW)).toBe(0);
    expect(finals().map((f) => f.ticket_id)).toEqual([a]);
    expect(links.needsBill().map((n) => n.ticket_id)).toEqual([b]);
    expect(links.needsBill()[0].candidates).toEqual([]);
  });

  it('a gone bill is not a candidate', () => {
    filled('2026-11-20');
    bill('9000001', '2026-11-20', { gone_at: '2026-11-21T00:00:00' });
    expect(links.autoLink(NOW)).toBe(0);
    expect(links.needsBill()[0].candidates).toEqual([]);
  });

  it('after unlink does not relink the pair, but a hand link works', () => {
    const id = filled('2026-11-20');
    bill('9000001', '2026-11-20');
    links.autoLink(NOW);
    links.unlink(id, 1, 'admin#1');
    expect(finals()).toEqual([]);
    expect(links.autoLink(NOW)).toBe(0);
    expect(links.needsBill().map((n) => n.ticket_id)).toEqual([id]);
    links.link(id, '9000001', null, 'admin#1');
    expect(finals()).toMatchObject([{ ticket_id: id, invoice_no: '9000001', linked_by: 'admin#1' }]);
  });

  it('markNone takes the ticket off needsBill and autoLink leaves it alone', () => {
    const id = filled('2026-11-20');
    links.markNone(id, null, 'admin#1');
    bill('9000001', '2026-11-20');
    expect(links.autoLink(NOW)).toBe(0);
    expect(links.needsBill()).toEqual([]);
    expect(finals()).toMatchObject([{ ticket_id: id, invoice_no: null, source: 'none' }]);
  });
});

describe('needsBill', () => {
  it('lists newest filled first, candidates by plate or phone, closest total first, at most 5', () => {
    const old = filled('2026-11-01');
    const recent = filled('2026-11-20', { plate: 'tst-0001', phone: '5550109999' });
    for (let i = 1; i <= 6; i++) bill(`90001${i}0`, '2026-11-20', { plate: 'TST-0001', total: i * 1000 });
    bill('9000200', '2026-11-21', { plate: 'ZZZ-1', phone: '5550109999', total: 500 });
    bill('9000201', '2026-11-21', { plate: 'ZZZ-1', phone: '5550108888', total: 500 });
    bill('9000202', '2026-12-10', { plate: 'TST-0001' }); // too far
    const list = links.needsBill();
    expect(list.map((n) => n.ticket_id)).toEqual([recent, old]);
    expect(list[0].candidates).toHaveLength(5);
    expect(list[0].subtotal).toBe(0);
  });

  it('closest total to the subtotal first, phone matches included', () => {
    filled('2026-11-20', { lines: [{ desc: 'pads', qty: 1, price: 100, labor: 50 }] });
    bill('9000001', '2026-11-20', { total: 30000 });
    bill('9000002', '2026-11-20', { total: 15500 });
    bill('9000003', '2026-11-21', { plate: 'OTHER', total: 15000 });
    const [n] = links.needsBill();
    expect(n.subtotal).toBe(15000);
    expect(n.candidates.map((c) => [c.invoice_no, c.why])).toEqual([
      ['9000003', 'phone'],
      ['9000002', 'plate'],
      ['9000001', 'plate'],
    ]);
  });
});

describe('link, unlink and typedFinal', () => {
  it('refuses a bill linked to another ticket', () => {
    const a = filled('2026-11-20');
    const b = filled('2026-11-20');
    bill('9000001', '2026-11-20');
    links.link(a, '9000001', null, 'admin#1');
    expect(() => links.link(b, '9000001', null, 'admin#1')).toThrow(new Refused(`that bill is linked to ticket ${a}`));
  });

  it('NotFound for a ticket not filled or a bill that is not there', () => {
    const waiting = tickets.create(DESK).id;
    const id = filled('2026-11-20');
    bill('9000001', '2026-11-20');
    expect(() => links.link(waiting, '9000001', null, 'admin#1')).toThrow(NotFound);
    expect(() => links.link(id, '9999999', null, 'admin#1')).toThrow(NotFound);
    expect(() => links.link(404, '9000001', null, 'admin#1')).toThrow(NotFound);
    expect(() => links.markNone(waiting, null, 'admin#1')).toThrow(NotFound);
    expect(finals()).toEqual([]);
  });

  it('relinking bumps the version; unlinking a typed or none final adds no pair', () => {
    const id = filled('2026-11-20');
    bill('9000001', '2026-11-20');
    bill('9000002', '2026-11-20');
    links.link(id, '9000001', null, 'admin#1');
    links.link(id, '9000002', 1, 'admin#1');
    expect(finals()).toMatchObject([{ invoice_no: '9000002', version: 2 }]);
    links.markNone(id, 2, 'admin#1');
    expect(finals()[0].version).toBe(3);
    links.unlink(id, 3, 'admin#1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM invoice_unlinked').get()).toEqual({ n: 0 });
    expect(() => links.unlink(id, null, 'admin#1')).toThrow(NotFound);
  });

  it('typedFinal saves, and an old version is Refused', () => {
    const id = filled('2026-11-20');
    const n = { parts: 1000, labor: 2000, supplies: 100, tax: 80, total: 3180 };
    links.typedFinal(id, n, null, 'admin#1');
    expect(finals()).toMatchObject([{ source: 'typed', invoice_no: null, version: 1 }]);
    expect(() => links.typedFinal(id, n, null, 'admin#1')).toThrow(new Refused('changed on another device'));
    links.typedFinal(id, { ...n, invoice_no: 'tst-0001', total: 3200 }, 1, 'admin#1');
    expect(finals()).toMatchObject([{ invoice_no: 'tst-0001', version: 2 }]);
    expect(() => links.typedFinal(id, n, 1, 'admin#1')).toThrow(new Refused('changed on another device'));
    const other = filled('2026-11-20');
    expect(() => links.typedFinal(other, { ...n, invoice_no: 'tst-0001' }, null, 'admin#1')).toThrow(Refused);
    links.typedFinal(other, n, null, 'admin#1'); // a second row with no number is fine
    expect(finals()).toHaveLength(2);
  });
});

describe('version checks', () => {
  const n = { parts: 1000, labor: 2000, supplies: 100, tax: 80, total: 3180 };
  const stale = new Refused('changed on another device');

  it('link, markNone and unlink with a stale version are Refused and keep the typed row', () => {
    const id = filled('2026-11-20');
    bill('9000001', '2026-11-20');
    links.typedFinal(id, { ...n, invoice_no: 'tst-0001' }, null, 'admin#1');
    const before = links.final(id);
    expect(before).toMatchObject({ source: 'typed', invoice_no: 'tst-0001', total: 3180, version: 1 });
    for (const v of [null, 2, 0]) {
      expect(() => links.link(id, '9000001', v, 'admin#2')).toThrow(stale);
      expect(() => links.markNone(id, v, 'admin#2')).toThrow(stale);
      expect(() => links.unlink(id, v, 'admin#2')).toThrow(stale);
    }
    expect(links.final(id)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM invoice_unlinked').get()).toEqual({ n: 0 });
  });

  it('a number when there is no row is Refused too, and the right version works', () => {
    const id = filled('2026-11-20');
    bill('9000001', '2026-11-20');
    expect(links.final(id)).toBeNull();
    expect(() => links.link(id, '9000001', 1, 'admin#1')).toThrow(stale);
    expect(() => links.markNone(id, 1, 'admin#1')).toThrow(stale);
    expect(() => links.unlink(id, 1, 'admin#1')).toThrow(stale);
    links.link(id, '9000001', null, 'admin#1');
    expect(links.final(id)).toMatchObject({ source: 'invomax', invoice_no: '9000001', linked_by: 'admin#1', version: 1 });
  });
});

describe('ambiguity and indexed matching', () => {
  it('two same-plate tickets and one bill: nothing linked, both list the bill', () => {
    const a = filled('2026-11-20');
    const b = filled('2026-11-21');
    bill('9000001', '2026-11-21');
    expect(links.autoLink(NOW)).toBe(0);
    const list = links.needsBill();
    expect(list.map((x) => x.ticket_id)).toEqual([b, a]);
    for (const x of list) expect(x.candidates.map((c) => c.invoice_no)).toEqual(['9000001']);
  });

  it('each ticket with its own bill still links', () => {
    filled('2026-11-10');
    filled('2026-11-20');
    bill('9000001', '2026-11-10');
    bill('9000002', '2026-11-20');
    expect(links.autoLink(NOW)).toBe(2);
  });

  it('matches plates typed differently, and a phone with another plate', () => {
    filled('2026-11-20', { plate: 'xks-4827' });
    bill('9000001', '2026-11-20', { plate: 'XKS 4827' });
    expect(links.autoLink(NOW)).toBe(1);
    filled('2026-11-20', { plate: 'tst-0001' });
    bill('9000002', '2026-11-21', { plate: 'T S T 0001' });
    expect(links.needsBill()[0].candidates.map((c) => [c.invoice_no, c.why])).toEqual([['9000002', 'plate']]);
  });

  it('lists at most the 200 newest filled tickets', () => {
    for (let i = 0; i < 205; i++) filled('2026-11-20', { plate: '' });
    const list = links.needsBill();
    expect(list).toHaveLength(200);
    expect(list[0].ticket_id).toBeGreaterThan(list[199].ticket_id);
  });

  it('openImDb adds plate_norm and its indexes to an older db', () => {
    const path = join(tmp.dir, 'old.db');
    const old = openImDb(path);
    old.exec('DROP INDEX im_invoices_plate_norm');
    old.exec('ALTER TABLE im_invoices DROP COLUMN plate_norm');
    old.close();
    const upgraded = openImDb(path);
    const cols = (upgraded.prepare('PRAGMA table_info(im_invoices)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('plate_norm');
    const idx = (upgraded.prepare('PRAGMA index_list(im_invoices)').all() as { name: string }[]).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(['im_invoices_plate_norm', 'im_invoices_phone_date']));
    upgraded.close();
  });
});

describe('speed', () => {
  it('auto-links 50 tickets against 53k bills within 3 s', () => {
    for (let i = 0; i < 50; i++) filled('2026-11-20', { plate: `tst-${1000 + i}` });
    im.exec('BEGIN');
    for (let i = 0; i < 53_000; i++) {
      const d = new Date(2024, 0, 1 + (i % 1000));
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      bill(String(9_100_000 + i), day, { plate: `FAKE-${i}` });
    }
    for (let i = 0; i < 50; i++) bill(String(9_200_000 + i), '2026-11-20', { plate: `TST-${1000 + i}` });
    im.exec('COMMIT');
    const start = Date.now();
    expect(links.autoLink(NOW)).toBe(50);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
