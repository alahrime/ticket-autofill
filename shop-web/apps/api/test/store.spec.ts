// Ports the Store cases of tests/test_tickets.py.
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { edit, Invalid, move, normalize, Stale, type Line, type Ticket } from '@shop/domain';
import { openDb } from '../src/db';
import { NotFound } from '../src/errors';
import { TicketStore } from '../src/store';
import { tempDir } from './py';

const DESK = {
  first: ' jane ',
  last: 'doe',
  phone: '555 010 0000',
  year: '2019',
  make: 'cadillac',
  model: ' cts   v ',
  plate: 'xks-4827',
  request: 'oil change, brakes squeak',
  color: 'red',
};

const pad = (n: number): string => String(n).padStart(2, '0');
const yesterday = (): string => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function thrown(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error('did not throw');
}

describe('TicketStore', () => {
  let db: DatabaseSync;
  let s: TicketStore;
  let done: () => void;

  beforeEach(() => {
    const tmp = tempDir();
    done = tmp.done;
    db = openDb(join(tmp.dir, 'tickets.db'));
    s = new TicketStore(db);
  });

  afterEach(() => {
    db.close();
    done();
  });

  it('creates, gets and lists newest first, by status', () => {
    const a = s.create(DESK);
    expect(a).toMatchObject({ id: 1, status: 'waiting', version: 1, first: 'JANE' });
    expect(a.created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    expect(a.updated).toBe(a.created);
    const b = s.create({ ...DESK, first: 'john' });
    expect(s.get(1)).toEqual(a);
    expect(s.get(99)).toBeNull();
    expect(s.list().map((t) => t.id)).toEqual([2, 1]);
    move(b, 'working', 'Mike');
    s.save(b, 1);
    expect(s.list(['working']).map((t) => t.id)).toEqual([2]);
    expect(s.list(['waiting', 'working']).map((t) => t.id)).toEqual([2, 1]);
    expect(s.list(['filled'])).toEqual([]);
    expect(s.list([]).map((t) => t.id)).toEqual([2, 1]); // as Python: an empty list is "all"
  });

  it('create refuses bad fields and ignores status, version and unknown keys', () => {
    const e = thrown(() => s.create({ first: 'jane' }));
    expect(e).toBeInstanceOf(Invalid);
    expect((e as Invalid).errors).toHaveProperty('phone');
    const c = s.create({ ...DESK, status: 'approved', version: 9, back_note: 'x' });
    expect(c).toMatchObject({ status: 'waiting', version: 1, back_note: '' });
    expect(c).not.toHaveProperty('color');
    expect(s.get(c.id)?.status).toBe('waiting');
    expect(s.list(['approved'])).toEqual([]);
  });

  it('round-trips lines', () => {
    const t = s.create(DESK);
    edit(
      t,
      {
        lines: [
          { desc: 'diag', labor: 60 },
          { desc: 'brake pads', qty: 2, price: 45, labor: 80, code: 'pads' },
        ],
      },
      'desk',
    );
    s.save(t, 1);
    expect(s.get(t.id)?.lines).toEqual<Line[]>([
      { desc: 'diag', qty: 1, price: null, labor: 60, code: '', id: 1 },
      { desc: 'brake pads', qty: 2, price: 45, labor: 80, code: 'PADS', id: 2 },
    ]);
  });

  it('save bumps the version, keeps created; an old version is Stale with the stored ticket', () => {
    const t = s.create(DESK);
    t.lines = normalize({ lines: [{ desc: 'oil', price: 30, labor: 20 }] }).clean.lines ?? [];
    const saved = s.save(t, 1);
    expect(saved).toBe(t);
    expect(saved.version).toBe(2);
    const got = s.get(t.id) as Ticket;
    expect(got.version).toBe(2);
    expect(got.created).toBe(t.created);
    expect(got.lines).toEqual([{ desc: 'oil', qty: 1, price: 30, labor: 20, code: '', id: 1 }]);
    const other = s.get(t.id) as Ticket;
    other.notes = 'from the phone';
    s.save(other, 2);
    t.notes = 'from the ipad';
    const e = thrown(() => s.save(t, 2));
    expect(e).toBeInstanceOf(Stale);
    expect((e as Stale).ticket).toMatchObject({ notes: 'from the phone', version: 3 });
    expect(t.version).toBe(2); // the refused copy is left as it was
    expect(s.get(t.id)?.notes).toBe('from the phone');
    expect(db.isTransaction).toBe(false);
  });

  it('save keeps the stored created even if the copy changed it', () => {
    const t = s.create(DESK);
    const created = t.created;
    t.created = '1999-01-01T00:00:00';
    s.save(t, 1);
    expect(t.created).toBe(created);
    expect(s.get(t.id)?.created).toBe(created);
  });

  it('save of an unknown id is NotFound and leaves no transaction open', () => {
    const e = thrown(() => s.save({ ...(s.create(DESK) as Ticket), id: 42 }, 1));
    expect(e).toBeInstanceOf(NotFound);
    expect(db.isTransaction).toBe(false);
    expect(s.save(s.get(1) as Ticket, 1).version).toBe(2); // nothing left locked
  });

  it('loads old tickets: dataclass defaults filled, unknown keys kept', () => {
    db.prepare('INSERT INTO tickets (id, status, data) VALUES (?, ?, ?)').run(
      5,
      'review',
      JSON.stringify({ first: 'OLD', lines: [{ desc: 'X' }], zz_future: 'x' }),
    );
    const t = s.get(5) as Ticket;
    expect(t).toMatchObject({
      id: 5,
      status: 'review',
      first: 'OLD',
      last: '',
      vin: '',
      mech_edit: '',
      deposits: [],
      version: 1,
      zz_future: 'x',
    });
    expect(t.lines).toEqual([{ desc: 'X', qty: 1, price: null, labor: null, code: '', id: 0 }]);
    edit(t, { deposits: [{ amount: 10, date: yesterday() }] }, 'desk');
    s.save(t, 1);
    const got = s.get(5) as Ticket;
    expect(got.deposits).toEqual([{ amount: 10, method: 'cash', date: yesterday(), note: '', id: 1 }]);
    expect(got.zz_future).toBe('x');
  });

  it('fills deposit defaults', () => {
    db.prepare('INSERT INTO tickets (id, status, data) VALUES (?, ?, ?)').run(
      6,
      'working',
      JSON.stringify({ deposits: [{ amount: 5 }] }),
    );
    expect(s.get(6)?.deposits).toEqual([{ amount: 5, method: 'cash', date: '', note: '', id: 0 }]);
  });

  it('writes data as Python json.dumps would: field order, separators, ASCII escapes, no id/status', () => {
    const t = s.create({ ...DESK, notes: 'café "ok"\n2' });
    const { data } = db.prepare('SELECT data FROM tickets WHERE id = ?').get(t.id) as { data: string };
    expect(data.startsWith('{"first": "JANE", "last": "DOE", "phone": "(555)010-0000", ')).toBe(true);
    expect(data).toContain('"notes": "caf\\u00e9 \\"ok\\"\\n2", "lines": [], "deposits": [], "back_note": ""');
    expect(
      data.endsWith(`"updated": "${t.updated}", "version": 1, "deleted_at": "", "deleted_by": "", "deleted_from": ""}`),
    ).toBe(true); // the three are always written, empty when not deleted (the dataclass has them)
    expect(data).not.toMatch(/"id"|"status"/);
  });
});
