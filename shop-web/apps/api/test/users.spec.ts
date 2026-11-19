// Ports test_users_and_sessions, test_user_changes_all_or_nothing and test_names_fold_and_owners_match_exactly
// of tests/test_shop.py (the kiosk parts left out: the check-in iPad is retired).
import { Invalid, move } from '@shop/domain';
import { ADMIN, CAR, makeServer, PASSWORD, PINS, sid, type TestServer } from './helpers';

jest.setTimeout(60_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any; // a reply's JSON, as loosely as the Python test reads it

let s: TestServer;
beforeEach(async () => {
  s = await makeServer();
});
afterEach(() => s.close());

/** -> [status, JSON], as test_shop.py's call(). */
async function call(path: string, data?: unknown, cookie?: string): Promise<[number, J]> {
  const r = await s.call(path, data, cookie);
  return [r.status, r.body];
}

const me = (cookie: string): Promise<number> => s.call('/api/me', undefined, cookie).then((r) => r.status);
const techLogin = (name: string, secret: string) => s.call('/login/tech', { name, secret });

describe('users', () => {
  it('users and sessions', async () => {
    const a = await s.admin();
    let [code, r] = await call('/api/users', undefined, a);
    expect(code).toBe(200);
    expect(r.users.map((u: J) => u.name)).toEqual(['Al Fixit', 'Bo Wrench', ADMIN]);
    for (const u of r.users) expect(Object.keys(u).sort()).toEqual(['active', 'created', 'id', 'name', 'role']); // no hashes
    const [made, u] = await call('/api/users', { name: 'Cy Newhire', role: 'mechanic', secret: '11223344' }, a);
    expect([made, u.name, u.active]).toEqual([200, 'Cy Newhire', true]);
    expect((await call('/api/users', { name: 'cy newhire', role: 'mechanic', secret: '11223344' }, a))[0]).toBe(400);
    [code, r] = await call('/api/users', { name: 'Di Short', role: 'mechanic', secret: '12' }, a);
    expect(code).toBe(400);
    expect(r.errors).toHaveProperty('secret');
    expect((await call('/api/mechanics', undefined, a))[1].mechanics).toContain('Cy Newhire');

    const alId = s.ids['Al Fixit'] as number;
    let al = await s.tech('Al Fixit');
    const reset = await s.call(`/api/users/${alId}`, { secret: '975310' }, a); // reset PIN: Al is signed out
    expect(reset.status).toBe(200);
    expect(reset.body).not.toHaveProperty('hash');
    expect(reset.headers['set-cookie']).toBeUndefined();
    expect(await me(al)).toBe(401);
    expect((await techLogin('Al Fixit', PINS['Al Fixit'] as string)).status).toBe(401);
    const back = await techLogin('Al Fixit', '975310');
    expect(back.status).toBe(303);
    al = sid(back);
    expect(await call(`/api/users/${alId}`, { active: 'no' }, a)).toEqual([400, { error: 'active must be true or false' }]);
    expect((await call(`/api/users/${alId}`, { active: false }, a))[1].active).toBe(false); // off: signed out
    expect(await me(al)).toBe(401);
    expect((await techLogin('Al Fixit', '975310')).status).toBe(401);
    expect((await call('/api/mechanics', undefined, a))[1].mechanics).not.toContain('Al Fixit');
    expect((await call(`/api/users/${alId}`, { active: true }, a))[1].active).toBe(true);
    expect(await call('/api/users/999', { active: true }, a)).toEqual([404, { error: 'no such user' }]);

    const mine = `/api/users/${s.ids[ADMIN]}`;
    expect((await call(mine, { active: false }, a))[0]).toBe(400); // the last admin stays on
    const other = await s.admin();
    expect((await call(mine, { secret: 'short' }, a))[0]).toBe(400);
    const own = await s.call(mine, { secret: 'made-up-pass-2' }, a); // own password: this device gets a new sid
    expect(own.status).toBe(200);
    expect(own.headers['set-cookie']?.[0]).toMatch(/^sid=/);
    const a2 = sid(own);
    expect(a2).not.toBe(a);
    expect(await me(a)).toBe(401);
    expect(await me(other)).toBe(401);
    expect((await call('/api/me', undefined, a2))[1].role).toBe('admin');
    await s.admin('made-up-pass-2');

    const bo = await s.tech('Bo Wrench');
    let out = await s.call('/logout', '', bo);
    expect([out.status, out.headers.location]).toEqual([303, '/tech']);
    expect(out.headers['set-cookie']?.[0]).toContain('Max-Age=0');
    expect(await me(bo)).toBe(401);
    out = await s.call('/logout', '', a2);
    expect([out.status, out.headers.location]).toEqual([303, '/admin']);
    out = await s.call('/logout', '');
    expect([out.status, out.headers.location]).toEqual([303, '/']);
  });

  it('user changes all or nothing', async () => {
    const a = await s.admin();
    const al = `/api/users/${s.ids['Al Fixit']}`;
    let [code, r] = await call(al, { secret: '12', active: false }, a); // bad PIN: Al isn't turned off either
    expect(code).toBe(400);
    expect(r.errors).toHaveProperty('secret');
    expect((await call('/api/users', undefined, a))[1].users[0].active).toBe(true);
    const mine = `/api/users/${s.ids[ADMIN]}`;
    [code, r] = await call(mine, { secret: 'made-up-pass-9', active: false }, a); // last admin: password not changed
    expect(code).toBe(400);
    expect(r.errors).toHaveProperty('active');
    expect(await me(a)).toBe(200);
    await s.admin(); // the old password still works
    await call('/api/users', { name: 'Second Boss', role: 'admin', secret: 'made-up-pass-3' }, a);
    const both = await s.call(mine, { secret: 'made-up-pass-9', active: false }, a); // now allowed: both applied
    expect([both.status, (both.body as J).active]).toEqual([200, false]);
    expect(both.headers['set-cookie']).toBeUndefined();
    expect(await me(a)).toBe(401);
  });

  it('names fold and owners match exactly', async () => {
    const a = await s.admin();
    expect((await call('/api/users', { name: 'Strauss', role: 'mechanic', secret: '11223344' }, a))[0]).toBe(200);
    for (const name of ['STRAUß', 'strauß', 'STRAUSS']) {
      const [code, r] = await call('/api/users', { name, role: 'mechanic', secret: '11223344' }, a);
      expect([name, code, Object.keys(r.errors ?? {})]).toEqual([name, 400, ['name']]);
    }
    // the same rule straight on accounts
    const e: unknown = await s.accounts.add('Strauß', 'admin', PASSWORD).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Invalid);
    expect((e as Invalid).errors).toHaveProperty('name');
    const st = s.store.create(CAR); // a ticket naming Al in other letters: not Al's
    move(st, 'working', 'AL FIXIT');
    s.store.save(st, 1);
    const al = await s.tech('Al Fixit');
    expect((await call(`/api/tickets/${st.id}`, undefined, al))[0]).toBe(404);
    expect((await call(`/api/tickets/${st.id}`, { version: 2, notes: 'x' }, al))[0]).toBe(404);
    const [, t] = await call('/api/tickets', CAR, a);
    const strauss = await s.signIn('mechanic', 'Strauss', '11223344');
    const [code, moved] = await call(`/api/tickets/${t.id}/move`, { version: 1, to: 'working' }, strauss);
    expect([code, moved.mechanic]).toEqual([200, 'Strauss']);
  });

  it('only admin and mechanic accounts can be made', async () => {
    const a = await s.admin();
    const [code, r] = await call('/api/users', { name: 'Ki Osk', role: 'kiosk', secret: '11223344' }, a);
    expect([code, r.errors]).toEqual([400, { role: 'role must be admin or mechanic' }]);
    expect(s.accounts.find('Ki Osk')).toBeNull();
  });

  it('a user change ignores name and role in the body', async () => {
    const a = await s.admin();
    const id = s.ids['Al Fixit'] as number;
    const before = s.accounts.get(id);
    const [code, u] = await call(`/api/users/${id}`, { name: 'Al Renamed', role: 'admin', active: true }, a);
    expect([code, u.name, u.role]).toEqual([200, 'Al Fixit', 'mechanic']);
    expect(s.accounts.get(id)).toEqual(before);
  });

  it('users routes are admin only', async () => {
    const al = await s.tech('Al Fixit');
    const no = [403, { error: 'not allowed' }];
    expect(await call('/api/users', undefined, al)).toEqual(no);
    expect(await call('/api/mechanics', undefined, al)).toEqual(no);
    expect(await call('/api/users', { name: 'Cy Newhire', role: 'mechanic', secret: '11223344' }, al)).toEqual(no);
    expect(await call(`/api/users/${s.ids['Al Fixit']}`, { secret: '975310' }, al)).toEqual(no);
    expect(await call(`/api/users/${s.ids['Bo Wrench']}`, 'not json', al)).toEqual(no); // before the body is read
    expect(s.accounts.find('Cy Newhire')).toBeNull();
    expect(await call('/api/users', undefined)).toEqual([401, { error: 'sign in' }]);
    const a = await s.admin();
    expect(await call('/api/users/abc', { active: true }, a)).toEqual([404, { error: 'not found' }]);
    expect((await call(`/api/users/${s.ids['Al Fixit']}`, 'not json', a))[0]).toBe(400);
  });
});
