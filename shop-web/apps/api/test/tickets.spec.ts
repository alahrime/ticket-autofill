// Ports the ticket cases of tests/test_shop.py: full flow, the desk's whole invoice, deposits, VINs, the
// list's ETag, owners matched exactly, and the JSON bad-request / stalled-body cases on the real
// POST /api/tickets. The kiosk parts are left out (the check-in iPad is retired): its tickets are made at
// the desk here.
import { connect } from 'node:net';
import { move } from '@shop/domain';
import {
  ADMIN,
  CAR,
  makeServer,
  PASSWORD,
  PINS,
  type TestServer,
} from './helpers';

jest.setTimeout(60_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any; // a reply's JSON, as loosely as the Python test reads it

let s: TestServer;
afterEach(() => s.close());

/** -> [status, JSON], as test_shop.py's call(). */
async function call(
  path: string,
  data?: unknown,
  cookie?: string,
  headers?: Record<string, string>,
): Promise<[number, J]> {
  const r = await s.call(path, data, cookie, headers);
  return [r.status, r.body];
}

const today = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Raw bytes on a socket; resolves with what came back once the server ends the connection. */
function raw(base: string, head: string, timeoutMs = 10_000): Promise<string> {
  const port = Number(new URL(base).port);
  return new Promise((ok, fail) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(head));
    let got = '';
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      fail(new Error('server kept the connection'));
    });
    sock.on('data', (c) => (got += c.toString('latin1')));
    sock.on('error', () => ok(got));
    sock.on('close', () => ok(got));
  });
}

describe('tickets', () => {
  beforeEach(async () => {
    s = await makeServer();
  });

  it('full flow', async () => {
    const a = await s.admin();
    let [code, t] = await call('/api/tickets', CAR, a);
    expect(code).toBe(200);
    const tid: number = t.id;
    const url = `/api/tickets/${tid}`;
    const kid: number = (await call('/api/tickets', CAR, a))[1].id;
    let r: J;
    [code, r] = await call(
      '/api/tickets',
      { ...CAR, first: '', year: '1800' },
      a,
    );
    expect(code).toBe(400);
    expect(Object.keys(r.errors).sort()).toEqual(['first', 'year']);

    const al = await s.tech('Al Fixit');
    const bo = await s.tech('Bo Wrench');
    const ids = async (c: string, q: string): Promise<number[]> =>
      (await call(`/api/tickets?status=${q}`, undefined, c))[1].tickets.map(
        (x: J) => x.id,
      );
    expect(await ids(al, 'waiting,working')).toEqual([kid, tid]);
    expect((await call(url, undefined, bo))[1].first).toBe('JANE'); // waiting: anyone may look
    expect((await call(url, { version: 1, notes: 'x' }, al))[0]).toBe(403); // not theirs until accepted
    [code, t] = await call(
      `${url}/move`,
      { version: 1, to: 'working', mechanic: 'Bo Wrench' },
      al,
    );
    expect([code, t.status, t.mechanic, t.version]).toEqual([
      200,
      'working',
      'Al Fixit',
      2,
    ]); // as themselves

    expect(await ids(bo, 'waiting,working')).toEqual([kid]); // Al's: hidden
    expect((await call(url, undefined, bo))[0]).toBe(404);
    expect((await call(url, { version: 2, notes: 'mine now' }, bo))[0]).toBe(
      404,
    );
    expect(
      (await call(`${url}/move`, { version: 2, to: 'review' }, bo))[0],
    ).toBe(404);

    [code, r] = await call(url, { version: 2, who: 'desk', first: 'JUNE' }, al); // who in the body: ignored
    expect(code).toBe(409);
    expect(r.error).toContain('first');
    expect(r.ticket.first).toBe('JANE');
    [code, t] = await call(
      url,
      '{"version": 2, "lines": [{"desc": "wiper", "id": 1e400}]}',
      al,
    );
    expect([code, t.lines[0].id, t.version]).toEqual([200, 1, 3]); // a silly id is renumbered, not a 500
    [code, r] = await call(
      url,
      '{"version": 3, "lines": [{"desc": "wiper", "qty": 1e400}]}',
      al,
    );
    expect(code).toBe(400);
    expect(r.errors).toHaveProperty('lines');
    const lines: J[] = [
      {
        desc: 'front brake pads',
        qty: 1,
        price: '100',
        labor: '100',
        code: 'FBP',
      },
      { desc: 'brake fluid flush', labor: 80 },
    ];
    [code, t] = await call(url, { version: 3, lines, odometer: '45,120' }, al);
    expect([code, t.version, t.odometer]).toEqual([200, 4, '45120']);
    expect(t.totals).toEqual({ parts: 100, labor: 180, total: 280 }); // phone: no deposits
    expect(t).not.toHaveProperty('deposits');
    [code, r] = await call(url, { version: 3, notes: 'late' }, al);
    expect([code, r.ticket.version, r.ticket.notes]).toEqual([409, 4, '']); // stale
    expect((await call(url, { version: '4', notes: 'x' }, al))[0]).toBe(400);
    [code, r] = await call(`${url}/move`, { version: 4, to: 'waiting' }, al);
    expect([code, r.ticket.status]).toEqual([409, 'working']);

    expect(
      (await call(`${url}/move`, { version: 4, to: 'review' }, al))[1].status,
    ).toBe('review');
    expect((await call(url, undefined, al))[1].status).toBe('review'); // still theirs to look at
    expect(
      (await call('/api/tickets?status=review', undefined, al))[1],
    ).toEqual({ tickets: [] }); // the list: waiting + working
    expect((await call(url, { version: 5, notes: 'x' }, al))[0]).toBe(409); // phone: review is locked
    [code, r] = await call(`${url}/move`, { version: 5, to: 'approved' }, al);
    expect([code, r.ticket.status]).toEqual([409, 'review']); // only the desk approves

    expect(await ids(a, 'review')).toEqual([tid]);
    Object.assign(lines[0], { qty: 2, price: '50.50' });
    [code, t] = await call(
      url,
      { version: 5, who: 'mechanic', lines, first: 'Joan' },
      a,
    ); // desk rules
    expect([code, t.first]).toEqual([200, 'JOAN']);
    expect(t.totals).toEqual({
      parts: 101,
      labor: 180,
      total: 281,
      deposits: 0,
    });
    expect(t.deposits).toEqual([]);
    const mv = (body: J, c = a): Promise<[number, J]> =>
      call(`${url}/move`, body, c);
    expect((await mv({ version: 6, to: 'working' }))[0]).toBe(409); // sending back needs a note
    expect((await mv({ version: 6, to: 'working', note: ['x'] }))[0]).toBe(400);
    expect(
      (await mv({ version: 6, to: 'working', note: 'x'.repeat(2001) }))[0],
    ).toBe(400);
    expect((await mv({ version: 6, to: ['working'] }))[0]).toBe(400);
    [code, t] = await mv({
      version: 6,
      to: 'working',
      note: 'check rear pads too',
      mechanic: 'Bo Wrench',
    });
    expect([code, t.status, t.back_note, t.mechanic]).toEqual([
      200,
      'working',
      'check rear pads too',
      'Al Fixit',
    ]);
    expect((await mv({ version: 7, to: 'review' }, al))[1].back_note).toBe('');
    expect((await mv({ version: 8, to: 'approved' }))[1].status).toBe(
      'approved',
    );
    const priced = t.lines.map((ln: J) => ({
      ...ln,
      price: ln.price && ln.price + 5,
      labor: ln.labor && ln.labor + 10,
    }));
    expect((await call(url, undefined, al))[1].status).toBe('approved'); // still Al's to look at and fix
    expect((await call(url, undefined, bo))[0]).toBe(404);
    [code, t] = await call(url, { version: 9, lines: priced }, a); // prices stay editable after approval
    expect([code, t.status, t.version]).toEqual([200, 'approved', 10]);
    expect(t.lines.map((ln: J) => [ln.price, ln.labor])).toEqual(
      priced.map((ln: J) => [ln.price, ln.labor]),
    );
    [code, t] = await mv({ version: 10, to: 'filled' });
    expect([code, t.status, t.version]).toEqual([200, 'filled', 11]);
    expect((await call(url, { version: 11, notes: 'late' }, a))[0]).toBe(409);
    expect((await call(url, undefined, al))[0]).toBe(404); // filled: off the phone

    [code, t] = await call('/api/tickets', CAR, a); // the desk's own intake gets the ticket back
    expect([code, t.status, t.phone, t.plate]).toEqual([
      200,
      'waiting',
      '(555)010-0000',
      'TST-0001',
    ]);
    const u2 = `/api/tickets/${t.id}/move`;
    expect(
      (
        await call(u2, { version: 1, to: 'working', mechanic: 'Cy Unknown' }, a)
      )[0],
    ).toBe(400);
    expect((await call(u2, { version: 1, to: 'working' }, a))[0]).toBe(400);
    [code, t] = await call(
      u2,
      { version: 1, to: 'working', mechanic: 'bo  wrench' },
      a,
    ); // desk accepts for Bo
    expect([code, t.mechanic]).toEqual([200, 'Bo Wrench']);
    expect(
      (await call(u2.slice(0, -5), { version: 2, notes: 'on it' }, bo))[0],
    ).toBe(200);
    [code, t] = await call('/api/tickets', CAR, a); // waiting: the desk may set who it's for
    const u3 = `/api/tickets/${t.id}`;
    for (const [m, stored] of [
      ['al fixit', 'Al Fixit'],
      ['AL FIXIT', 'Al Fixit'],
      ['Bo Wrench', 'Bo Wrench'],
    ]) {
      [code, t] = await call(u3, { version: t.version, mechanic: m }, a); // desk: an account, its spelling
      expect([code, t.mechanic]).toEqual([200, stored]);
    }
    for (const m of ['Cy Unknown', '', ['Al Fixit'], null]) {
      [code, r] = await call(u3, { version: t.version, mechanic: m }, a);
      expect([code, Object.keys(r.errors ?? {})]).toEqual([400, ['mechanic']]);
    }
    await call(u3, { version: t.version, mechanic: 'al fixit' }, a);
    s.accounts.setActive(s.ids['Al Fixit'] as number, false); // /api/users comes in a later task
    [code, t] = await call(
      u3,
      { version: t.version + 1, mechanic: 'AL FIXIT', notes: 'kept' },
      a,
    );
    expect([code, t.mechanic]).toEqual([200, 'Al Fixit']); // off now, but it's the ticket's current value
    await call(u3, { version: t.version, mechanic: 'Bo Wrench' }, a);
    expect(
      (await call(u3, { version: t.version + 1, mechanic: 'Al Fixit' }, a))[0],
    ).toBe(400); // off: not pickable
    [code, t] = await call('/api/tickets', CAR, a);
    expect(
      (
        await call(
          `/api/tickets/${t.id}/move`,
          { version: 1, to: 'working', mechanic: 'Al Fixit' },
          a,
        )
      )[0],
    ).toBe(400);

    expect((await call('/api/tickets/999', undefined, a))[0]).toBe(404);
    expect(
      (
        await call('/api/tickets/999/move', { version: 1, to: 'working' }, a)
      )[0],
    ).toBe(404);
    expect((await call('/api/tickets/abc', undefined, a))[0]).toBe(404);
    expect(
      (await call('/api/tickets/99999999999999999999', { version: 1 }, a))[0],
    ).toBe(404);
    const log = s.log();
    expect(log).toContain(`POST /api/tickets/${tid}/move 200`);
    expect(log).not.toContain('status=');
    for (const secret of [
      'JANE',
      'FIXIT',
      'WRENCH',
      ADMIN.toUpperCase(),
      PASSWORD.toUpperCase(),
      ...Object.values(PINS),
      ...[a, al, bo].map((c) => (c.split('=')[1] as string).toUpperCase()),
    ]) {
      expect(log.toUpperCase()).not.toContain(secret);
    }
  });

  it('the admin enters the whole invoice', async () => {
    const a = await s.admin();
    const al = await s.tech('Al Fixit');
    const bo = await s.tech('Bo Wrench');
    const full = {
      ...CAR,
      vin: '2t1br32614c809083',
      odometer: '45,120',
      mechanic: 'al  fixit',
      notes: 'rear pads soon',
      lines: [
        {
          desc: 'front brake pads',
          qty: 1,
          price: '100',
          labor: '80',
          code: 'FBP',
        },
        { desc: 'brake fluid flush', labor: 60 },
      ],
      status: 'approved',
      version: 9,
      id: 77,
    };
    let [code, t] = await call('/api/tickets', full, a);
    expect([code, t.status, t.version, t.mechanic]).toEqual([
      200,
      'waiting',
      1,
      'Al Fixit',
    ]);
    expect(t.id).not.toBe(77);
    expect([t.vin, t.odometer, t.vin_warning]).toEqual([
      '2T1BR32614C809083',
      '45120',
      '',
    ]);
    expect(t.totals).toEqual({
      parts: 100,
      labor: 140,
      total: 240,
      deposits: 0,
    }); // before tax
    const tid: number = t.id;
    const url = `/api/tickets/${tid}`;
    let r: J;
    for (const m of ['Cy Unknown', ['Al Fixit'], 7]) {
      // a mechanic is an active account, or not set at all
      [code, r] = await call('/api/tickets', { ...CAR, mechanic: m }, a);
      expect([code, Object.keys(r.errors ?? {})]).toEqual([400, ['mechanic']]);
    }
    [code, r] = await call(
      '/api/tickets',
      { ...full, lines: [{ desc: '' }] },
      a,
    );
    expect(code).toBe(400);
    expect(r.errors).toHaveProperty('lines');
    const [bcode, bare] = await call(
      '/api/tickets',
      { ...CAR, mechanic: '' },
      a,
    ); // just the drop-off: nobody picked yet
    expect([bcode, bare.mechanic, bare.lines]).toEqual([200, '', []]);
    const bid: number = bare.id;
    const burl = `/api/tickets/${bid}`;

    const ids = async (
      c: string,
      q = 'waiting,working,approved',
    ): Promise<number[]> =>
      (await call(`/api/tickets?status=${q}`, undefined, c))[1].tickets.map(
        (x: J) => x.id,
      );
    expect(await ids(al)).toEqual([bid, tid]);
    expect(await ids(bo)).toEqual([bid]); // Al's ticket: only Al (and the desk) see it waiting
    expect((await call(url, undefined, bo))[0]).toBe(404);
    expect(
      (await call(`${url}/move`, { version: 1, to: 'working' }, bo))[0],
    ).toBe(404); // not Bo's to accept
    expect((await call(url, { version: 1, notes: 'x' }, al))[0]).toBe(409); // Al's, but nothing to change until he works on it
    expect(
      (await call(`${url}/move`, { version: 1, to: 'approved' }, al))[0],
    ).toBe(409); // only the desk sends

    [code, r] = await call(`${burl}/move`, { version: 1, to: 'approved' }, a); // no mechanic, no lines: not an invoice
    expect([code, r.ticket.status]).toEqual([409, 'waiting']);
    expect(r.error).toContain('mechanic');
    await call(burl, { version: 1, mechanic: 'Bo Wrench' }, a);
    [code, r] = await call(`${burl}/move`, { version: 2, to: 'approved' }, a);
    expect(code).toBe(409);
    expect(r.error).toContain('line');

    [code, t] = await call(
      `${url}/move`,
      { version: 1, to: 'approved', mechanic: 'Bo Wrench' },
      a,
    ); // straight to InvoMax
    expect([code, t.status, t.mechanic, t.version]).toEqual([
      200,
      'approved',
      'Al Fixit',
      2,
    ]);
    expect(await ids(al, 'approved')).toEqual([tid]);
    expect(await ids(bo, 'approved')).toEqual([]);
    expect((await call(url, undefined, bo))[0]).toBe(404);
    expect((await call(url, { version: 2, notes: 'x' }, bo))[0]).toBe(404);

    [code, t] = await call(url, undefined, al); // the mechanic still sees and fixes their invoice
    expect(code).toBe(200);
    expect(t).not.toHaveProperty('deposits');
    expect(t.totals).toEqual({ parts: 100, labor: 140, total: 240 });
    const lines = [{ ...t.lines[0], labor: '95' }, t.lines[1]];
    [code, t] = await call(url, { version: 2, lines, odometer: '45200' }, al);
    expect([code, t.status, t.version, t.odometer]).toEqual([
      200,
      'approved',
      3,
      '45200',
    ]);
    expect(t.totals.labor).toBe(155);
    [code, r] = await call(url, { version: 3, lines: [] }, al);
    expect(code).toBe(400);
    expect(r.errors).toHaveProperty('lines');
    for (const body of [
      { first: 'X' },
      { mechanic: 'Bo Wrench' },
      { deposits: [{ amount: 5 }] },
    ]) {
      [code, r] = await call(url, { version: 3, ...body }, al);
      expect([code, r.ticket?.version]).toEqual([409, 3]);
    }
    for (const to of ['filled', 'working', 'review']) {
      expect((await call(`${url}/move`, { version: 3, to }, al))[0]).toBe(409);
    }
    t = (await call(url, undefined, a))[1];
    expect(t.lines[0].labor).toBe(95);
    expect(t.mech_edit).toBeTruthy(); // the desk sees the mechanic's change, flagged
    [code, r] = await call(
      url,
      { version: 3, lines: [{ desc: 'nothing', id: 1 }] },
      al,
    );
    expect(code).toBe(400); // not every charge off a sent invoice
    expect(r.errors).toHaveProperty('lines');
    expect(s.log()).toContain(`POST ${url} 200`);
    expect(s.log()).toContain(`mechanic#${s.ids['Al Fixit']}`); // who changed it is on record

    [code, t] = await call(`${url}/move`, { version: 3, to: 'filled' }, a);
    expect([code, t.status]).toEqual([200, 'filled']);
    expect((await call(url, undefined, al))[0]).toBe(404);
    expect(await ids(al, 'approved')).toEqual([]);
    expect((await call(url, { version: 4, notes: 'late' }, al))[0]).toBe(404);

    // a job a mechanic is working on: the desk may fix anything and send it without Finish job / review
    let w: J;
    [code, w] = await call(
      `${burl}/move`,
      { version: 2, to: 'working', mechanic: 'Bo Wrench' },
      a,
    );
    expect([code, w.status]).toEqual([200, 'working']);
    [code, w] = await call(
      burl,
      { version: 3, lines: [{ desc: 'oil change', price: 40 }] },
      bo,
    );
    [code, w] = await call(
      burl,
      { version: 4, first: 'Joan', odometer: '9', lines: w.lines },
      a,
    );
    expect([code, w.first, w.odometer, w.status]).toEqual([
      200,
      'JOAN',
      '9',
      'working',
    ]);
    expect((await call(burl, { version: 4, notes: 'old copy' }, bo))[0]).toBe(
      409,
    ); // the phone's copy is stale now
    [code, w] = await call(`${burl}/move`, { version: 5, to: 'approved' }, a);
    expect([code, w.status, w.mechanic]).toEqual([
      200,
      'approved',
      'Bo Wrench',
    ]);
    // the desk gives a sent invoice to someone else while the first mechanic's phone still holds it
    [code, w] = await call(burl, { version: 6, mechanic: 'Al Fixit' }, a);
    expect([code, w.mechanic, w.mech_edit]).toEqual([200, 'Al Fixit', '']);
    expect((await call(burl, { version: 6, notes: 'mine?' }, bo))[0]).toBe(404); // not a 409 that shows Al's ticket
    expect((await call(burl, undefined, al))[1].status).toBe('approved');

    // Save pressed again after a lost reply: the same ticket, not a second invoice
    const count = async (): Promise<number> =>
      (await call('/api/tickets', undefined, a))[1].tickets.length;
    const n = await count();
    const first = (
      await call('/api/tickets', { ...full, token: 'tok-' + 'a'.repeat(20) }, a)
    )[1];
    const again = (
      await call(
        '/api/tickets',
        { ...full, token: 'tok-' + 'a'.repeat(20), first: 'Other' },
        a,
      )
    )[1];
    expect([again.id, again.first]).toEqual([first.id, 'JANE']);
    expect(
      (
        await call(
          '/api/tickets',
          { ...full, token: 'tok-' + 'b'.repeat(20) },
          a,
        )
      )[1].id,
    ).not.toBe(first.id);
    for (const tok of ['short', 7, ['x'.repeat(20)], 'x'.repeat(65)]) {
      // not a usable token: just a new ticket each time
      expect((await call('/api/tickets', { ...full, token: tok }, a))[0]).toBe(
        200,
      );
    }
    expect(await count()).toBe(n + 6);
    // the token is the admin's own: another admin sending the same one makes their own ticket
    const other = (await s.accounts.add('Second Desk', 'admin', PASSWORD)).id;
    const a2 = await s.signIn('admin', 'Second Desk', PASSWORD);
    const theirs = (
      await call(
        '/api/tickets',
        { ...full, token: 'tok-' + 'a'.repeat(20) },
        a2,
      )
    )[1];
    expect(theirs.id).not.toBe(first.id);
    expect(other).toBeGreaterThan(0);
  });

  it('remembers the last 500 create tokens', async () => {
    const a = await s.admin();
    const tok = (i: number): string => `token-${String(i).padStart(4, '0')}`;
    const made: number[] = [];
    for (let i = 0; i < 501; i++)
      made.push(
        (await call('/api/tickets', { ...CAR, token: tok(i) }, a))[1].id,
      );
    expect(
      (await call('/api/tickets', { ...CAR, token: tok(500) }, a))[1].id,
    ).toBe(made[500]); // still known
    expect(
      (await call('/api/tickets', { ...CAR, token: tok(1) }, a))[1].id,
    ).toBe(made[1]);
    expect(
      (await call('/api/tickets', { ...CAR, token: tok(0) }, a))[1].id,
    ).toBeGreaterThan(made[500] as number); // forgotten
    expect(
      (await call('/api/tickets', { ...CAR, token: 'x'.repeat(64) }, a))[0],
    ).toBe(200); // 64: the longest kept
    const n = (await call('/api/tickets', undefined, a))[1].tickets.length;
    await call('/api/tickets', { ...CAR, token: 'x'.repeat(64) }, a);
    await call('/api/tickets', { ...CAR, token: '12345678' }, a);
    await call('/api/tickets', { ...CAR, token: '12345678' }, a);
    expect((await call('/api/tickets', undefined, a))[1].tickets.length).toBe(
      n + 1,
    ); // 8 and 64 characters both count
  });

  it('deposits are the admin only', async () => {
    const a = await s.admin();
    const al = await s.tech('Al Fixit');
    let [code, t] = await call('/api/tickets', CAR, a);
    const url = `/api/tickets/${t.id}`;
    const dep = {
      amount: '200',
      method: 'cash',
      date: today(),
      note: 'at drop-off',
    };
    [code, t] = await call(url, { version: t.version, deposits: [dep] }, a); // waiting
    expect(code).toBe(200);
    expect(t.deposits).toEqual([{ ...dep, amount: 200, id: 1 }]);
    expect(t.totals).toEqual({ parts: 0, labor: 0, total: 0, deposits: 200 });
    const mech = (x: J): boolean =>
      !('deposits' in x) &&
      JSON.stringify(Object.keys(x.totals)) === '["parts","labor","total"]';
    expect(mech((await call(url, undefined, al))[1])).toBe(true);
    expect(
      (await call('/api/tickets', undefined, al))[1].tickets.every(mech),
    ).toBe(true);
    [code, t] = await call(
      `${url}/move`,
      { version: t.version, to: 'working' },
      al,
    );
    expect([code, mech(t)]).toEqual([200, true]);
    [code, t] = await call(
      url,
      { version: t.version, lines: [{ desc: 'pads', price: 100, labor: 50 }] },
      al,
    );
    expect([code, mech(t), t.totals.total]).toEqual([200, true, 150]);
    let r: J;
    [code, r] = await call(url, { version: t.version, deposits: [] }, al);
    expect([code, mech(r.ticket)]).toEqual([409, true]); // the phone can't touch them
    expect(r.error).toContain('deposits');
    expect(
      Object.keys(
        (await call(url, { version: t.version - 1, notes: 'late' }, al))[1]
          .ticket,
      ),
    ).toEqual(Object.keys(r.ticket));

    const v = t.version;
    [code, t] = await call(
      url,
      {
        version: v,
        deposits: [
          { id: 1, ...dep },
          { amount: 9.5, method: 'card' },
        ],
      },
      a,
    ); // working
    expect([code, t.deposits.map((d: J) => d.id), t.totals.deposits]).toEqual([
      200,
      [1, 2],
      209.5,
    ]);
    [code, t] = await call(
      url,
      { version: t.version, deposits: t.deposits, notes: 'x' },
      a,
    );
    expect([code, t.deposits.length, t.notes]).toEqual([200, 2, 'x']); // working: the desk's to change too
    [code, r] = await call(
      url,
      { version: t.version, deposits: [{ amount: 5, method: 'venmo' }] },
      a,
    );
    expect(code).toBe(400);
    expect(r.errors).toHaveProperty('deposits');
    expect((await call(url, undefined, a))[1].totals.deposits).toBe(209.5);
    t = (
      await call(`${url}/move`, { version: t.version, to: 'review' }, al)
    )[1];
    expect(mech(t)).toBe(true);
    expect(mech((await call(url, undefined, al))[1])).toBe(true);
    [code, t] = await call(
      url,
      {
        version: t.version,
        deposits: [{ id: 2, amount: 9.5, method: 'card' }],
      },
      a,
    );
    expect([code, t.deposits.map((d: J) => d.id)]).toEqual([200, [2]]); // removed one (review)
    t = (
      await call(`${url}/move`, { version: t.version, to: 'approved' }, a)
    )[1];
    [code, t] = await call(
      url,
      { version: t.version, deposits: [...t.deposits, { amount: 149.5 }] },
      a,
    );
    expect([code, t.totals.deposits, t.deposits.map((d: J) => d.id)]).toEqual([
      200,
      159,
      [2, 3],
    ]);
    t = (await call(`${url}/move`, { version: t.version, to: 'filled' }, a))[1];
    expect((await call(url, { version: t.version, deposits: [] }, a))[0]).toBe(
      409,
    ); // filled: closed
  });

  it('vin', async () => {
    // made-up VINs
    const a = await s.admin();
    const al = await s.tech('Al Fixit');
    const bo = await s.tech('Bo Wrench');
    const kid = (await call('/api/tickets', CAR, a))[1].id;
    let t: J = (await call(`/api/tickets/${kid}`, undefined, a))[1];
    expect([t.vin, t.vin_warning]).toEqual(['', '']);
    const url = `/api/tickets/${kid}`;
    t = (
      await call(`${url}/move`, { version: t.version, to: 'working' }, al)
    )[1];
    expect(
      (
        await call(url, { version: t.version, vin: '1HGCM82633A004352' }, bo)
      )[0],
    ).toBe(404); // not Bo's job
    let code: number;
    [code, t] = await call(
      url,
      { version: t.version, vin: '2t1br 32614c80908' },
      al,
    );
    expect([code, t.vin, t.vin_warning]).toEqual([
      200,
      '2T1BR32614C80908',
      'VIN has 16 characters, not 17',
    ]);
    [code, t] = await call(
      url,
      { version: t.version, lines: [{ desc: 'pads', price: 100 }] },
      al,
    );
    t = (
      await call(`${url}/move`, { version: t.version, to: 'review' }, al)
    )[1];
    t = (
      await call(`${url}/move`, { version: t.version, to: 'approved' }, a)
    )[1];
    expect(t.vin_warning).toBe('VIN has 16 characters, not 17');
    [code, t] = await call(
      url,
      { version: t.version, vin: '2T1BR32614C809083' },
      a,
    ); // the desk fixes it until filled
    expect([code, t.vin, t.vin_warning]).toEqual([
      200,
      '2T1BR32614C809083',
      '',
    ]);
    expect(
      (await call('/api/tickets?status=approved', undefined, a))[1].tickets[0]
        .vin_warning,
    ).toBe('');
    t = (await call(`${url}/move`, { version: t.version, to: 'filled' }, a))[1];
    expect(
      (await call(url, { version: t.version, vin: '1HGCM82633A004352' }, a))[0],
    ).toBe(409);
  });

  it('etag per role', async () => {
    const a = await s.admin();
    const al = await s.tech('Al Fixit');
    await call('/api/tickets', CAR, a);
    const tags: Record<string, string> = {};
    for (const [name, c] of [
      ['admin', a],
      ['al', al],
    ] as const) {
      const r = await s.call('/api/tickets?status=waiting', undefined, c);
      expect(r.status).toBe(200);
      tags[name] = r.headers.etag as string;
      const same = await s.call('/api/tickets?status=waiting', undefined, c, {
        'If-None-Match': tags[name],
      });
      expect([same.status, same.text, same.headers.etag]).toEqual([
        304,
        '',
        tags[name],
      ]);
      expect(
        (
          await call('/api/tickets?status=working', undefined, c, {
            'If-None-Match': tags[name],
          })
        )[0],
      ).toBe(200);
    }
    expect(tags['admin']).not.toBe(tags['al']); // same tickets, other role: no shared tag
    expect(
      (
        await call('/api/tickets?status=waiting', undefined, al, {
          'If-None-Match': tags['admin'] as string,
        })
      )[0],
    ).toBe(200);
    const bo = await s.tech('Bo Wrench');
    expect(
      (
        await call('/api/tickets?status=waiting', undefined, bo, {
          'If-None-Match': tags['al'] as string,
        })
      )[0],
    ).toBe(200);
    await call('/api/tickets/1', { version: 1, first: 'Joan' }, a);
    expect(
      (
        await call('/api/tickets?status=waiting', undefined, al, {
          'If-None-Match': tags['al'] as string,
        })
      )[0],
    ).toBe(200); // changed
    expect((await call('/api/tickets?status=bogus', undefined, a))[1]).toEqual({
      tickets: [],
    });
    // no filter (or a blank one, as parse_qs drops it): every ticket; repeated status params join
    expect((await call('/api/tickets', undefined, a))[1].tickets).toHaveLength(
      1,
    );
    expect(
      (await call('/api/tickets?status=', undefined, a))[1].tickets,
    ).toHaveLength(1);
    expect(
      (await call('/api/tickets?status=bogus&status=waiting', undefined, a))[1]
        .tickets,
    ).toHaveLength(1);
  });

  it('owners match exactly; names fold only when picking', async () => {
    const a = await s.admin();
    const st = s.store.create(CAR); // a ticket naming Al in other letters: not Al's
    move(st, 'working', 'AL FIXIT');
    s.store.save(st, 1);
    const al = await s.tech('Al Fixit');
    expect((await call(`/api/tickets/${st.id}`, undefined, al))[0]).toBe(404);
    expect(
      (await call(`/api/tickets/${st.id}`, { version: 2, notes: 'x' }, al))[0],
    ).toBe(404);
    const t = (await call('/api/tickets', CAR, a))[1];
    const [code, w] = await call(
      `/api/tickets/${t.id}/move`,
      { version: 1, to: 'working' },
      al,
    );
    expect([code, w.mechanic]).toEqual([200, 'Al Fixit']);
  });

  it('checks every input it is sent', async () => {
    const a = await s.admin();
    const al = await s.tech('Al Fixit');
    const t = (await call('/api/tickets', CAR, a))[1];
    const url = `/api/tickets/${t.id}`;
    for (const version of [undefined, '1', true, 1.5, null, [1], { v: 1 }]) {
      for (const path of [url, `${url}/move`]) {
        expect(
          await call(path, { version, to: 'working', notes: 'x' }, a),
        ).toEqual([400, { error: 'version must be a whole number' }]);
      }
    }
    expect((await call(url, '{"version": 1e400, "notes": "x"}', a))[0]).toBe(
      400,
    );
    for (const id of ['0123456789', '1.0', '-1', '1e3', '%31%32']) {
      expect((await call(`/api/tickets/${id}`, undefined, a))[0]).toBe(404);
      expect(
        (await call(`/api/tickets/${id}`, { version: 1, notes: 'x' }, a))[0],
      ).toBe(404);
    }
    expect((await call(`${url}/`, undefined, a))[0]).toBe(404); // strict: no trailing slash
    // signed out: 401 before anything is read
    for (const [path, body] of [
      ['/api/tickets', undefined],
      [url, undefined],
      ['/api/tickets', CAR],
      [url, { version: 1 }],
      [`${url}/move`, { version: 1, to: 'working' }],
    ] as const) {
      expect(await call(path, body)).toEqual([401, { error: 'sign in' }]);
    }
    // a mechanic may check a customer in (checkin.spec.ts): JSON only, like the desk
    expect(await call('/api/tickets', 'not json', al)).toEqual([
      400,
      { error: 'not valid JSON' },
    ]);
    // a mechanic's move: `who` and `mechanic` in the body never change who accepts
    const [code, w] = await call(
      `${url}/move`,
      { version: 1, to: 'working', who: 'desk', mechanic: 'Bo Wrench' },
      al,
    );
    expect([code, w.mechanic]).toEqual([200, 'Al Fixit']);
    // unknown stored keys stay in the database but are not shown
    s.db
      .prepare(
        "UPDATE tickets SET data = json_set(data, '$.secret_extra', 'x') WHERE id = ?",
      )
      .run(t.id);
    const shown = (await call(url, undefined, a))[1];
    expect(shown).not.toHaveProperty('secret_extra');
    expect(Object.keys(shown)).toEqual([
      'id',
      'status',
      'first',
      'last',
      'phone',
      'year',
      'make',
      'model',
      'plate',
      'request',
      'mechanic',
      'odometer',
      'vin',
      'notes',
      'lines',
      'deposits',
      'back_note',
      'mech_edit',
      'created',
      'updated',
      'version',
      'deleted_at',
      'deleted_by',
      'deleted_from',
      'totals',
      'vin_warning',
    ]);
  });
});

describe('JSON bodies on POST /api/tickets', () => {
  beforeEach(async () => {
    s = await makeServer();
  });

  it('bad requests', async () => {
    const c = await s.admin();
    const post = (body: Buffer | string, ctype = 'application/json') =>
      s.call('/api/tickets', Buffer.from(body as string), c, {
        'Content-Type': ctype,
      });
    expect((await post('{not json')).status).toBe(400);
    expect(await post('[1, 2]')).toMatchObject({
      status: 400,
      body: { error: 'expected a JSON object' },
    });
    expect(await post('null')).toMatchObject({
      status: 400,
      body: { error: 'expected a JSON object' },
    });
    expect((await post(Buffer.from([0xff, 0xfe]))).status).toBe(400);
    expect((await post('['.repeat(100_000))).status).toBe(400); // too deep
    for (const ctype of ['text/plain', 'application/x-www-form-urlencoded']) {
      // what a form on another site can send
      expect(await post(JSON.stringify(CAR), ctype)).toMatchObject({
        status: 400,
        body: { error: 'send JSON (Content-Type: application/json)' },
      });
    }
    expect(
      await post(JSON.stringify(CAR), 'application/json; charset=utf-8'),
    ).toMatchObject({
      status: 200,
      body: { first: 'JANE' },
    });
    const big = await post(
      JSON.stringify({ ...CAR, notes: 'a'.repeat(1024 * 1024) }),
    );
    expect(big).toMatchObject({
      status: 400,
      body: { error: 'Request too big.' },
    });
    expect((await s.call('/api/tickets', undefined, c)).body).toMatchObject({
      tickets: [{ first: 'JANE' }],
    }); // one made
    // says 2 MB: refused before reading it, at once
    const start = Date.now();
    const got = await raw(
      s.base,
      `POST /api/tickets HTTP/1.1\r\nHost: x\r\nCookie: ${c}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${2 * 1024 * 1024}\r\n\r\n`,
    );
    expect(got).toMatch(/^HTTP\/1\.1 400 /);
    expect(got).toContain('{"error":"Request too big."}');
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('a stalled body: no reply, still serving', async () => {
    await s.close();
    s = await makeServer({ stallMs: 1000 });
    const c = await s.admin();
    const start = Date.now();
    const got = await raw(
      s.base,
      `POST /api/tickets HTTP/1.1\r\nHost: x\r\nCookie: ${c}\r\nContent-Type: application/json\r\n` +
        `Content-Length: 100\r\n\r\n{"first"`,
    );
    expect(got).toBe('');
    expect(Date.now() - start).toBeLessThan(5000);
    expect((await s.call('/api/me', undefined, c)).status).toBe(200);
    expect(s.log()).toContain('POST /api/tickets dropped');
    expect(s.store.list()).toEqual([]);
  });
});
