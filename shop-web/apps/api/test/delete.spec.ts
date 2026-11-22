// Delete, restore and the 14-day purge: who may do which, what the lists and the one-ticket GET show after.
import { markDeleted, nowIso, type Ticket } from '@shop/domain';
import { startServer } from '../src/server';
import { CAR, makeServer, send, type TestServer } from './helpers';

jest.setTimeout(60_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

let s: TestServer;
beforeEach(async () => {
  s = await makeServer();
});
afterEach(() => s.close());

async function call(path: string, data?: unknown, cookie?: string): Promise<[number, J]> {
  const r = await s.call(path, data, cookie);
  return [r.status, r.body];
}

const pad = (n: number): string => String(n).padStart(2, '0');
const isoDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ids = (r: J): number[] => r.tickets.map((t: J) => t.id);

/** A ticket made at the desk; `to` = 'working' gives it to `mech`. */
async function made(a: string, extra: object = {}, to?: 'working', mech = 'Al Fixit'): Promise<J> {
  let [code, t] = await call('/api/tickets', { ...CAR, ...extra }, a);
  expect(code).toBe(200);
  if (to) {
    [code, t] = await call(`/api/tickets/${t.id}/move`, { version: t.version, to, mechanic: mech }, a);
    expect(code).toBe(200);
  }
  return t;
}

describe('delete and restore', () => {
  it('the desk deletes a waiting ticket with a deposit, then restores it', async () => {
    const a = await s.admin();
    const t = await made(a, { deposits: [{ amount: 100 }] });
    const keep = await made(a);
    const [code, d] = await call(`/api/tickets/${t.id}/delete`, { version: 1 }, a);
    expect(code).toBe(200);
    expect(d).toMatchObject({ id: t.id, status: 'deleted', version: 2, deleted_from: 'waiting', deleted_by: `admin#${s.ids['Owner Test']}` });
    expect(d.deleted_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    expect(d.deposits).toHaveLength(1);
    // gone from the boards (and from the unfiltered list), there under status=deleted
    expect(ids((await call('/api/tickets?status=waiting,working,review,approved,filled', undefined, a))[1])).toEqual([keep.id]);
    expect(ids((await call('/api/tickets', undefined, a))[1])).toEqual([keep.id]);
    const [lcode, list] = await call('/api/tickets?status=deleted', undefined, a);
    expect([lcode, ids(list)]).toEqual([200, [t.id]]);
    expect(list.tickets[0].purge_on).toBeNull(); // R10: a deposit keeps it until restored
    expect((await call(`/api/tickets/${t.id}`, undefined, a))[0]).toBe(200); // the desk still opens it
    // one without a deposit: removed for good 14 days on
    const plain = await made(a);
    const [, pd] = await call(`/api/tickets/${plain.id}/delete`, { version: 1 }, a);
    const when = new Date(pd.deleted_at);
    when.setDate(when.getDate() + 14);
    expect((await call('/api/tickets?status=deleted', undefined, a))[1].tickets[0]).toMatchObject({ id: plain.id, purge_on: isoDay(when) });
    expect((await call(`/api/tickets/${plain.id}/restore`, { version: 2 }, a))[0]).toBe(200);
    expect((await call(`/api/tickets/${keep.id}`, undefined, a))[1]).not.toHaveProperty('purge_on');

    const [rcode, back] = await call(`/api/tickets/${t.id}/restore`, { version: 2 }, a);
    expect(rcode).toBe(200);
    expect(back).toMatchObject({ status: 'waiting', version: 3, deleted_at: '', deleted_by: '', deleted_from: '' });
    expect(back.deposits).toEqual(t.deposits);
    expect(back.totals.deposits).toBe(100);
    expect(ids((await call('/api/tickets?status=waiting', undefined, a))[1])).toEqual([plain.id, keep.id, t.id]);
    expect((await call('/api/tickets?status=deleted', undefined, a))[1]).toEqual({ tickets: [] });
  });

  it('purge_on is null for an approved or filled ticket', async () => {
    const a = await s.admin();
    let t = await made(a, { mechanic: 'Al Fixit', lines: [{ desc: 'diag', labor: 60 }] });
    [, t] = await call(`/api/tickets/${t.id}/move`, { version: 1, to: 'approved' }, a);
    let f = await made(a, { mechanic: 'Al Fixit', lines: [{ desc: 'diag', labor: 60 }] });
    [, f] = await call(`/api/tickets/${f.id}/move`, { version: 1, to: 'approved' }, a);
    [, f] = await call(`/api/tickets/${f.id}/move`, { version: 2, to: 'filled' }, a);
    const w = await made(a);
    const live = await made(a);
    for (const x of [t, f, w]) expect((await call(`/api/tickets/${x.id}/delete`, { version: x.version }, a))[0]).toBe(200);
    const list = (await call('/api/tickets?status=deleted', undefined, a))[1];
    expect(list.tickets.map((x: J) => [x.id, x.deleted_from, x.purge_on === null])).toEqual([
      [w.id, 'waiting', false],
      [f.id, 'filled', true],
      [t.id, 'approved', true],
    ]);
    // a mixed list: deleted ones carry purge_on, the live one doesn't
    const mixed = (await call('/api/tickets?status=waiting,deleted', undefined, a))[1];
    expect(mixed.tickets.map((x: J) => [x.id, 'purge_on' in x])).toEqual([
      [live.id, false],
      [w.id, true],
      [f.id, true],
      [t.id, true],
    ]);
  });

  it('a mechanic deletes their own working ticket, then sees it was removed', async () => {
    const a = await s.admin();
    const al = await s.tech('Al Fixit');
    const t = await made(a, { deposits: [{ amount: 100 }] }, 'working');
    const [code, d] = await call(`/api/tickets/${t.id}/delete`, { version: t.version }, al);
    expect(code).toBe(200);
    expect(d).toMatchObject({ status: 'deleted', deleted_from: 'working', deleted_by: `mechanic#${s.ids['Al Fixit']}` });
    expect(d).not.toHaveProperty('deposits'); // still the mechanic's view
    expect(d.totals).not.toHaveProperty('deposits');
    expect(await call(`/api/tickets/${t.id}`, undefined, al)).toEqual([410, { error: 'removed by the desk' }]);
    expect(await call(`/api/tickets/${t.id}`, undefined, await s.tech('Bo Wrench'))).toEqual([404, { error: 'not found' }]);
    // never in a mechanic's list, even asked for
    expect((await call('/api/tickets?status=deleted', undefined, al))[1]).toEqual({ tickets: [] });
    expect((await call('/api/tickets', undefined, al))[1]).toEqual({ tickets: [] });
    // changing it: 410 for them, 404 for anyone else
    expect((await call(`/api/tickets/${t.id}`, { version: 2, notes: 'x' }, al))[0]).toBe(410);
    expect((await call(`/api/tickets/${t.id}/move`, { version: 2, to: 'review' }, al))[0]).toBe(410);
    expect((await call(`/api/tickets/${t.id}/delete`, { version: 2 }, al))[0]).toBe(410);
    expect((await call(`/api/tickets/${t.id}/move`, { version: 2, to: 'review' }, await s.tech('Bo Wrench')))[0]).toBe(404);
  });

  it('a mechanic deletes a waiting unassigned ticket, not someone else\'s', async () => {
    const a = await s.admin();
    const al = await s.tech('Al Fixit');
    const bo = await s.tech('Bo Wrench');
    const w = await made(a);
    const theirs = await made(a, {}, 'working', 'Bo Wrench');
    expect(await call(`/api/tickets/${theirs.id}/delete`, { version: theirs.version }, al)).toEqual([404, { error: 'no such ticket' }]);
    expect(s.store.get(theirs.id)?.status).toBe('working');
    expect((await call(`/api/tickets/${w.id}/delete`, { version: 1 }, bo))[0]).toBe(200);
    expect(await call(`/api/tickets/${w.id}`, undefined, al)).toEqual([410, { error: 'removed by the desk' }]); // unassigned: anyone's
    expect((await call('/api/tickets/999/delete', { version: 1 }, al))[0]).toBe(404);
  });

  it('only the desk restores', async () => {
    const a = await s.admin();
    const al = await s.tech('Al Fixit');
    const t = await made(a, {}, 'working');
    await call(`/api/tickets/${t.id}/delete`, { version: t.version }, al);
    expect(await call(`/api/tickets/${t.id}/restore`, { version: 3 }, al)).toEqual([403, { error: 'not allowed' }]);
    expect((await call(`/api/tickets/${t.id}/restore`, { version: 3 }))[0]).toBe(401);
    expect((await call(`/api/tickets/${t.id}/restore`, { version: 3 }, a))[1]).toMatchObject({ status: 'working', mechanic: 'Al Fixit' });
    expect((await call(`/api/tickets/${t.id}`, undefined, al))[0]).toBe(200);
  });

  it('a stale version, a second delete or restoring a live ticket is 409 with the stored ticket', async () => {
    const a = await s.admin();
    const t = await made(a);
    expect(await call(`/api/tickets/${t.id}/delete`, { version: 7 }, a)).toEqual([
      409,
      expect.objectContaining({ error: 'changed on another device', ticket: expect.objectContaining({ status: 'waiting', version: 1 }) }),
    ]);
    const [rc, r] = await call(`/api/tickets/${t.id}/restore`, { version: 1 }, a);
    expect([rc, r.error]).toEqual([409, "it isn't deleted"]);
    await call(`/api/tickets/${t.id}/delete`, { version: 1 }, a);
    const [dc, d] = await call(`/api/tickets/${t.id}/delete`, { version: 2 }, a);
    expect([dc, d.error, d.ticket.status]).toEqual([409, 'already deleted', 'deleted']);
    expect((await call(`/api/tickets/${t.id}/restore`, { version: 1 }, a))[1].error).toBe('changed on another device');
    expect(await call(`/api/tickets/${t.id}/delete`, { version: 'x' }, a)).toEqual([400, { error: 'version must be a whole number' }]);
    expect(await call(`/api/tickets/${t.id}/delete`, {}, a)).toEqual([400, { error: 'version must be a whole number' }]);
  });

  it("the desk can't edit or move a deleted ticket", async () => {
    const a = await s.admin();
    const t = await made(a);
    await call(`/api/tickets/${t.id}/delete`, { version: 1 }, a);
    for (const [path, body] of [
      [`/api/tickets/${t.id}`, { version: 2, notes: 'x' }],
      [`/api/tickets/${t.id}/move`, { version: 2, to: 'working', mechanic: 'Al Fixit' }],
      [`/api/tickets/${t.id}/move`, { version: 2, to: 'waiting' }],
    ] as const) {
      const [code, r] = await call(path, body, a);
      expect([code, r.error, r.ticket?.version]).toEqual([409, "can't change a deleted ticket", 2]);
    }
    expect(s.store.get(t.id)).toMatchObject({ status: 'deleted', version: 2, notes: '' });
  });

  it('a move never reaches deleted, and an unknown status is echoed at most 20 characters', async () => {
    const a = await s.admin();
    const t = await made(a);
    expect((await call(`/api/tickets/${t.id}/move`, { version: 1, to: 'deleted' }, a))[1].error).toBe("can't go from waiting to deleted");
    const long = `<b>${'x'.repeat(200)}`;
    const [code, r] = await call(`/api/tickets/${t.id}/move`, { version: 1, to: long }, a);
    expect([code, r.error]).toEqual([409, `can't go from waiting to ${long.slice(0, 20)}`]);
    expect(s.store.get(t.id)?.status).toBe('waiting');
  });
});

describe('create tokens and deleted tickets (R9)', () => {
  it('a replay of a deleted ticket answers as GET would, and never makes a new one', async () => {
    const a = await s.admin();
    const al = await s.tech('Al Fixit');
    const bo = await s.tech('Bo Wrench');
    const t = (await call('/api/tickets', { ...CAR, token: 'tok-desk-0001' }, a))[1];
    const c = (await call('/api/tickets', { ...CAR, token: 'tok-mech-0001' }, al))[1];
    await call(`/api/tickets/${t.id}/delete`, { version: 1 }, a);
    await call(`/api/tickets/${c.id}/delete`, { version: 1 }, al);
    const [code, again] = await call('/api/tickets', { ...CAR, token: 'tok-desk-0001' }, a);
    expect([code, again.id, again.status]).toEqual([200, t.id, 'deleted']);
    expect(await call('/api/tickets', { ...CAR, token: 'tok-mech-0001' }, al)).toEqual([410, { error: 'removed by the desk' }]);
    // Bo's check-in, deleted after the desk gave it to Al: Bo may not see it at all
    const b = (await call('/api/tickets', { ...CAR, token: 'tok-mech-0002' }, bo))[1];
    const given = (await call(`/api/tickets/${b.id}/move`, { version: 1, to: 'working', mechanic: 'Al Fixit' }, a))[1];
    await call(`/api/tickets/${b.id}/delete`, { version: given.version }, a);
    expect(await call('/api/tickets', { ...CAR, token: 'tok-mech-0002' }, bo)).toEqual([404, { error: 'not found' }]);
    expect(s.store.list(['waiting', 'working', 'deleted']).map((x) => x.id)).toEqual([b.id, c.id, t.id]);
  });

  it('after a purge, or with the id taken again, the old token makes a new ticket', async () => {
    const a = await s.admin();
    const t = (await call('/api/tickets', { ...CAR, token: 'tok-desk-0002' }, a))[1];
    const newer = await made(a); // so t isn't the newest row, which the purge keeps
    await call(`/api/tickets/${t.id}/delete`, { version: 1 }, a);
    const later = new Date();
    later.setDate(later.getDate() + 15);
    expect(s.store.purge(later)).toBe(1);
    expect(s.store.get(t.id)).toBeNull();
    // missing: a miss, so a new ticket, under a new id (the newest row stayed, so SQLite gives max + 1)
    const [code, n] = await call('/api/tickets', { ...CAR, first: 'jo', token: 'tok-desk-0002' }, a);
    expect([code, n.first, n.status]).toEqual([200, 'JO', 'waiting']);
    expect(n.id).toBe(newer.id + 1);
    // the same id under another created time (written by hand, or by another program): also a miss
    s.db.prepare('DELETE FROM tickets WHERE id = ?').run(n.id);
    s.db.prepare('INSERT INTO tickets (id, status, data) VALUES (?, ?, ?)').run(n.id, 'waiting', JSON.stringify({ ...CAR, created: '2001-01-01T00:00:00' }));
    const [c2, m] = await call('/api/tickets', { ...CAR, first: 'mo', token: 'tok-desk-0002' }, a);
    expect([c2, m.first]).toEqual([200, 'MO']);
    expect(m.id).not.toBe(n.id);
    expect(s.store.get(n.id)?.created).toBe('2001-01-01T00:00:00'); // the stranger is untouched
    // and the new one is what the token names now
    expect((await call('/api/tickets', { ...CAR, token: 'tok-desk-0002' }, a))[1].id).toBe(m.id);
  });
});

describe('a stored deposits value TS cannot read (R12)', () => {
  const DAMAGED: unknown[] = [{ amount: 100 }, null, '100'];
  const LINE = { desc: 'diag', qty: 1, price: null, labor: 60, code: '', id: 1 };

  /** A live row written straight into the DB, `deposits` as given. */
  const row = (deposits: unknown, status = 'waiting', extra: object = {}): number =>
    Number(
      s.db
        .prepare('INSERT INTO tickets (status, data) VALUES (?, ?)')
        .run(status, JSON.stringify({ ...CAR, deposits, ...extra })).lastInsertRowid,
    );
  /** The deposits value as stored now. */
  const stored = (id: number): unknown =>
    (JSON.parse((s.db.prepare('SELECT data FROM tickets WHERE id = ?').get(id) as { data: string }).data) as J).deposits;
  const later = (): Date => {
    const d = new Date();
    d.setDate(d.getDate() + 15);
    return d;
  };

  it.each(DAMAGED)('a delete keeps %j: never purged, purge_on null', async (value) => {
    const a = await s.admin();
    const id = row(value);
    s.store.create(CAR); // the newest row
    expect((await call(`/api/tickets/${id}/delete`, { version: 1 }, a))[0]).toBe(200);
    expect(stored(id)).toEqual(value);
    const list = (await call('/api/tickets?status=deleted', undefined, a))[1];
    expect(list.tickets.map((x: J) => [x.id, x.purge_on, x.deposits])).toEqual([[id, null, []]]); // shown as none
    expect(s.store.purge(later())).toBe(0);
    expect(stored(id)).toEqual(value);
  });

  it.each(DAMAGED)('delete, restore and delete again keep %j', async (value) => {
    const a = await s.admin();
    const id = row(value);
    s.store.create(CAR);
    expect((await call(`/api/tickets/${id}/delete`, { version: 1 }, a))[0]).toBe(200);
    expect((await call(`/api/tickets/${id}/restore`, { version: 2 }, a))[1]).toMatchObject({ status: 'waiting' });
    expect(stored(id)).toEqual(value);
    expect((await call(`/api/tickets/${id}/delete`, { version: 3 }, a))[0]).toBe(200);
    expect(s.store.purge(later())).toBe(0);
    expect(stored(id)).toEqual(value);
  });

  it.each(DAMAGED)("a mechanic's edit and move keep %j", async (value) => {
    const al = await s.tech('Al Fixit');
    const id = row(value, 'working', { mechanic: 'Al Fixit', lines: [LINE] });
    expect((await call(`/api/tickets/${id}`, { version: 1, notes: 'checked' }, al))[0]).toBe(200);
    expect(stored(id)).toEqual(value);
    expect((await call(`/api/tickets/${id}/move`, { version: 2, to: 'review' }, al))[1]).toMatchObject({ status: 'review' });
    expect(stored(id)).toEqual(value);
  });

  it.each(DAMAGED)('the desk keeps %j unless it sends deposits, which replace it', async (value) => {
    const a = await s.admin();
    const id = row(value);
    expect((await call(`/api/tickets/${id}`, { version: 1, notes: 'x' }, a))[0]).toBe(200);
    expect(stored(id)).toEqual(value); // no deposits sent: kept
    const [code, t] = await call(`/api/tickets/${id}`, { version: 2, deposits: [{ amount: 50 }] }, a);
    expect([code, t.deposits.map((x: J) => x.amount)]).toEqual([200, [50]]);
    expect((stored(id) as J[]).map((x) => x.amount)).toEqual([50]); // deliberately replaced by a valid list
    expect((await call(`/api/tickets/${id}`, { version: 3, deposits: [] }, a))[0]).toBe(200);
    expect(stored(id)).toEqual([]); // and the desk may clear it, as any list
  });

  it('a ticket read nowhere counts as holding a deposit (fails closed); a new one does not', () => {
    const copy = { ...(s.store.create(CAR) as Ticket) }; // a copy the store never read
    expect(s.store.purgeOn(markDeleted(copy, 'admin#1', nowIso()))).toBeNull();
    const fresh = s.store.create(CAR);
    expect(s.store.purgeOn(markDeleted(fresh, 'admin#1', nowIso()))).toMatch(/^\d{4}-\d\d-\d\d$/);
  });
});

describe('purge', () => {
  /** A ticket of `status` deleted `days` ago, straight into the store. */
  function deleted(status: string, days: number, deposit = 0): Ticket {
    const t = s.store.create(deposit ? { ...CAR, deposits: [{ amount: deposit }] } : CAR);
    t.status = status;
    if (status === 'approved' || status === 'filled') {
      t.mechanic = 'Al Fixit';
      t.lines = [{ desc: 'diag', qty: 1, price: null, labor: 60, code: '', id: 1 }];
    }
    const when = new Date();
    when.setDate(when.getDate() - days);
    s.store.save(markDeleted(t, 'admin#1', nowIso(when)), 1);
    return t;
  }

  it('removes unfinished tickets deleted 15 days ago, keeps the rest', () => {
    const old = deleted('working', 15);
    const oldWait = deleted('waiting', 15);
    const sent = deleted('approved', 15);
    const filled = deleted('filled', 15);
    const recent = deleted('review', 13);
    const live = s.store.create(CAR);
    expect(s.store.purge(new Date())).toBe(2);
    expect(s.store.get(old.id)).toBeNull();
    expect(s.store.get(oldWait.id)).toBeNull();
    for (const x of [sent, filled, recent, live]) expect(s.store.get(x.id)).not.toBeNull();
    expect(s.store.purge(new Date())).toBe(0);
    const in2days = new Date();
    in2days.setDate(in2days.getDate() + 2);
    expect(s.store.purge(in2days)).toBe(1); // the review one, now 15 days old
    expect(s.store.get(recent.id)).toBeNull();
  });

  it('never removes a ticket with a deposit (R10): purge_on is null', async () => {
    const paid = deleted('working', 15, 100);
    const unpaid = deleted('working', 15);
    s.store.create(CAR); // the newest row
    expect(s.store.purge(new Date())).toBe(1);
    expect(s.store.get(unpaid.id)).toBeNull(); // no deposit: still purged
    expect(s.store.get(paid.id)?.deposits).toHaveLength(1);
    const far = new Date();
    far.setDate(far.getDate() + 400);
    expect(s.store.purge(far)).toBe(0);
    const list = (await call('/api/tickets?status=deleted', undefined, await s.admin()))[1];
    expect(list.tickets.map((x: J) => [x.id, x.deleted_from, x.purge_on])).toEqual([[paid.id, 'working', null]]);
  });

  it('judges the stored deposits as written: anything but missing or [] keeps the ticket', async () => {
    const when = new Date();
    when.setDate(when.getDate() - 15);
    /** A deleted waiting row 15 days old written straight into the DB, `deposits` as given (absent: no key). */
    const raw = (...deposits: unknown[]): number => {
      const data: Record<string, unknown> = { ...CAR, deleted_at: nowIso(when), deleted_by: 'admin#1', deleted_from: 'waiting' };
      if (deposits.length) data['deposits'] = deposits[0];
      return Number(s.db.prepare("INSERT INTO tickets (status, data) VALUES ('deleted', ?)").run(JSON.stringify(data)).lastInsertRowid);
    };
    const one = raw({ amount: 100 }); // a single object, not a list
    const nul = raw(null);
    const str = raw('100');
    const none = raw(); // no key: an old row, deposit-free
    const empty = raw([]);
    s.store.create(CAR); // the newest row
    const list = (await call('/api/tickets?status=deleted', undefined, await s.admin()))[1];
    const on = Object.fromEntries(list.tickets.map((x: J) => [x.id, x.purge_on]));
    expect([on[one], on[nul], on[str]]).toEqual([null, null, null]);
    expect(typeof on[none]).toBe('string');
    expect(typeof on[empty]).toBe('string');
    expect(s.store.purge(new Date())).toBe(2);
    expect([one, nul, str, none, empty].map((id) => s.store.get(id) !== null)).toEqual([true, true, true, false, false]);
    const far = new Date();
    far.setDate(far.getDate() + 400);
    expect(s.store.purge(far)).toBe(0); // never, however long
  });

  it('never removes the newest row, so no id is handed out twice', () => {
    const old = deleted('waiting', 15); // the newest row
    expect(s.store.purge(new Date())).toBe(0);
    expect(s.store.get(old.id)).not.toBeNull();
    const next = s.store.create(CAR);
    expect(next.id).toBe(old.id + 1);
    expect(s.store.purge(new Date())).toBe(1); // a newer ticket exists now: a later run takes it
    expect(s.store.get(old.id)).toBeNull();
    expect(s.store.create(CAR).id).toBe(next.id + 1); // still never old.id again
  });

  it('never removes a row that is not deleted, whatever its JSON says', () => {
    const t = s.store.create({ ...CAR });
    s.db.prepare('UPDATE tickets SET data = ? WHERE id = ?').run(
      JSON.stringify({ ...CAR, deleted_from: 'waiting', deleted_at: '2001-01-01T00:00:00' }),
      t.id,
    );
    s.db.prepare("INSERT INTO tickets (status, data) VALUES ('deleted', 'not json')").run();
    expect(s.store.purge(new Date())).toBe(0);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 2 });
  });

  it('runs at start and every hour, logs only the count, survives a failure', async () => {
    const t = deleted('working', 20);
    const keep = deleted('working', 1);
    s.store.create(CAR); // the newest row: never purged
    let now = new Date();
    let broken = false;
    const ticks: Array<() => void> = [];
    const server = await startServer(
      { ...s.config, port: 0 },
      {
        clock: () => {
          if (broken) throw new RangeError('clock gone wrong');
          return now;
        },
        schedule: (f: () => void) => {
          ticks.push(f);
          return { stop: () => ticks.splice(0) };
        },
      },
    );
    try {
      expect(s.store.get(t.id)).toBeNull(); // at start
      expect(s.log()).toMatch(/ purged 1\n$/);
      expect(ticks).toHaveLength(1);
      (ticks[0] as () => void)(); // nothing to purge yet
      expect(s.store.get(keep.id)).not.toBeNull();
      now = new Date(now.getTime() + 14 * 86_400_000);
      (ticks[0] as () => void)();
      expect(s.store.get(keep.id)).toBeNull(); // an hour's tick
      const purged = s.log().trim().split('\n').map((l) => l.slice(20)).filter((l) => l.startsWith('purge'));
      expect(purged).toEqual(['purged 1', 'purged 1']); // none for 0 (the nightly run logs lines of its own)
      expect(s.log()).not.toMatch(/JANE|TESTCASE|555/);
      broken = true; // the purge fails: logged by class, and the server goes on
      expect(() => (ticks[0] as () => void)()).not.toThrow();
      expect(s.log()).toMatch(/ purge error RangeError\n$/);
      expect(s.log()).not.toMatch(/clock gone wrong/);
      expect((await send(`http://127.0.0.1:${server.port}`, 'GET', '/api/me')).status).toBe(401);
    } finally {
      await server.close();
    }
    expect(ticks).toHaveLength(0); // the hourly timer stopped on close
  });
});
