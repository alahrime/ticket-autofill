// New with the TS server: a mechanic checks a customer in (the check-in iPad is retired). Only the customer's
// first details are kept; the ticket waits, unassigned, for whoever accepts it.
import { CAR, makeServer, type TestServer } from './helpers';

jest.setTimeout(60_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any; // a reply's JSON

let s: TestServer;
beforeEach(async () => {
  s = await makeServer();
});
afterEach(() => s.close());

async function call(path: string, data?: unknown, cookie?: string): Promise<[number, J]> {
  const r = await s.call(path, data, cookie);
  return [r.status, r.body];
}

describe('mechanic check-in', () => {
  it('mechanic checks a customer in', async () => {
    const al = await s.tech('Al Fixit');
    const [code, t] = await call(
      '/api/tickets',
      {
        ...CAR,
        price: 100,
        lines: [{ desc: 'brake pads', qty: 1, price: 80, labor: 40 }],
        deposits: [{ amount: 50, method: 'cash' }],
        mechanic: 'Bo Wrench',
        status: 'done',
        notes: 'not kept',
        odometer: '9',
        back_note: 'y',
        id: 77,
      },
      al,
    );
    expect(code).toBe(200);
    expect(t).not.toHaveProperty('deposits'); // the mechanic's view
    expect([t.status, t.mechanic, t.lines, t.notes, t.phone]).toEqual(['waiting', '', [], '', '(555)010-0000']);
    const stored = s.store.get(t.id);
    expect(stored).not.toBeNull();
    expect([stored?.status, stored?.mechanic, stored?.lines, stored?.deposits, stored?.notes]).toEqual([
      'waiting',
      '',
      [],
      [],
      '',
    ]);
    expect(stored?.first).toBe('JANE');
    expect(t.id).not.toBe(77);
    expect([stored?.id, stored?.odometer, stored?.back_note]).toEqual([t.id, '', '']);
    expect(s.store.get(77)).toBeNull();
    const [, list] = await call('/api/tickets', undefined, al);
    expect(list.tickets.map((x: J) => x.id)).toEqual([t.id]);
    const [, bo] = await call('/api/tickets', undefined, await s.tech('Bo Wrench'));
    expect(bo.tickets.map((x: J) => x.id)).toEqual([t.id]); // unassigned: any mechanic may accept it
  });

  it('mechanic check-in validates', async () => {
    const al = await s.tech('Al Fixit');
    const noPhone: Record<string, string> = { ...CAR };
    delete noPhone['phone'];
    const [code, r] = await call('/api/tickets', noPhone, al);
    expect(code).toBe(400);
    expect(r.errors.phone).toBe('phone is required');
    expect(s.store.list()).toEqual([]);
    expect((await call('/api/tickets', 'not json', al))[0]).toBe(400);
  });

  it('same token, same ticket', async () => {
    const al = await s.tech('Al Fixit');
    const [c1, t1] = await call('/api/tickets', { ...CAR, token: 'tok-00000001' }, al);
    const [c2, t2] = await call('/api/tickets', { ...CAR, token: 'tok-00000001' }, al);
    expect([c1, c2]).toEqual([200, 200]);
    expect(t2.id).toBe(t1.id);
    expect(s.store.list()).toHaveLength(1);
    // keyed by user: another account's same token is its own ticket
    const [, t3] = await call('/api/tickets', { ...CAR, token: 'tok-00000001' }, await s.tech('Bo Wrench'));
    expect(t3.id).not.toBe(t1.id);
    expect(s.store.list()).toHaveLength(2);
  });

  it('a replay shows the ticket only while the mechanic still sees it', async () => {
    const al = await s.tech('Al Fixit');
    const a = await s.admin();
    const body = { ...CAR, token: 'tok-00000002' };
    const [, t] = await call('/api/tickets', body, al);
    const [code, again] = await call('/api/tickets', body, al); // waiting, unassigned: still Al's to see
    expect([code, again.id]).toEqual([200, t.id]);
    const [moved] = await call(`/api/tickets/${t.id}/move`, { version: 1, to: 'working', mechanic: 'Bo Wrench' }, a);
    expect(moved).toBe(200);
    expect(await call('/api/tickets', body, al)).toEqual([404, { error: 'not found' }]); // Bo's job now
    expect(s.store.list()).toHaveLength(1); // and no second ticket
  });
});
