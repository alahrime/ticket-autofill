// Ports the pages, sign-in and first-run setup cases of tests/test_shop.py (the kiosk parts left out:
// the check-in iPad is retired, see 'checkin is gone').
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenHash } from '../src/accounts';
import { loadConfig } from '../src/config';
import { makeSetupCode } from '../src/routes/auth';
import { ADMIN, CAR, errLine, makeServer, PASSWORD, PINS, sid, type TestServer } from './helpers';

jest.setTimeout(30_000);

let s: TestServer;
afterEach(() => s.close());

const readCode = (): string => readFileSync(s.config.setup, 'utf8').trim();

describe('pages and sign-in', () => {
  beforeEach(async () => {
    s = await makeServer();
  });

  it('pages and sign in', async () => {
    const page = (await s.call('/')).text;
    for (const p of ['tech', 'admin']) expect(page).toContain(`href="/${p}"`);
    let r = await s.call('/desk');
    expect([r.status, r.headers.location]).toEqual([302, '/admin']);
    const admin = (await s.call('/admin')).text;
    expect(admin).toContain('action="/login/admin"');
    expect(admin).toContain('type="password"');
    const tech = (await s.call('/tech')).text;
    expect(tech).toContain('action="/login/tech"');
    expect(tech).toContain('inputmode="numeric"');
    expect((await s.call('/api/tickets')).status).toBe(401);
    expect((await s.call('/api/tickets', CAR)).status).toBe(401);
    expect((await s.call('/api/tickets/1/move', { version: 1, to: 'working' })).status).toBe(401);
    expect(await s.call('/api/me', undefined, 'sid=' + 'x'.repeat(43))).toMatchObject({
      status: 401,
      body: { error: 'sign in' },
    }); // made-up token
    expect(await s.call('/nowhere')).toMatchObject({ status: 404, body: { error: 'not found' } });
    const a = await s.admin();
    const m = await s.tech('Al Fixit');
    rmSync(s.config.web, { recursive: true });
    expect((await s.call('/admin', undefined, a)).text).toContain("isn't built yet");
    mkdirSync(s.config.web);
    for (const name of ['admin', 'tech']) writeFileSync(join(s.config.web, `${name}.html`), `<p>${name} page</p>`);
    for (const [c, mine] of [
      [a, '/admin'],
      [m, '/tech'],
    ] as const) {
      for (const p of ['/admin', '/tech']) {
        r = await s.call(p, undefined, c); // each page only to its role, read fresh
        expect(r.text === `<p>${p.slice(1)} page</p>`).toBe(p === mine);
      }
    }
    writeFileSync(join(s.config.web, 'tech.html'), '<p>edited</p>');
    expect((await s.call('/tech', undefined, m)).text).toBe('<p>edited</p>');
    expect((await s.call('/api/me', undefined, m)).body).toEqual({
      role: 'mechanic',
      name: 'Al Fixit',
      id: s.ids['Al Fixit'],
    });
    expect((await s.call('/api/me', undefined, a)).body).toEqual({ role: 'admin', name: ADMIN, id: s.ids[ADMIN] });
    expect(loadConfig({}).host).toBe('127.0.0.1'); // everything comes in through the tunnel
  });

  it('checkin is gone', async () => {
    const r = await s.call('/checkin');
    expect([r.status, r.headers.location]).toEqual([303, '/']);
    const a = await s.admin();
    expect((await s.call('/api/kiosk', {}, a)).status).toBe(404);
    expect((await s.call('/api/kiosk/revoke', {}, a)).status).toBe(404);
    expect((await s.call('/api/me', undefined, a)).status).toBe(200); // nothing signed this admin out
    expect((await s.call('/')).text).not.toContain('/checkin');
    // a kiosk session Python made is no session here
    const token = 'k'.repeat(43);
    s.db.prepare("INSERT INTO sessions VALUES (?, NULL, 'kiosk', ?, 0)").run(tokenHash(token), 4e9);
    expect((await s.call('/api/me', undefined, `sid=${token}`)).status).toBe(401);
  });

  it('roles refused at the wrong door', async () => {
    let r = await s.call('/login/tech', { name: ADMIN, secret: PASSWORD });
    expect(r.status).toBe(401);
    expect(r.text).toContain('Wrong name or PIN.');
    expect(r.headers['set-cookie']).toBeUndefined();
    r = await s.call('/login/admin', { name: 'Al Fixit', secret: PINS['Al Fixit'] });
    expect(r.status).toBe(401);
    expect(r.text).toContain('Wrong name or password.');
    const unknown = errLine(await s.call('/login/tech', { name: 'Nobody Here', secret: '123456' }));
    expect(unknown).toEqual(errLine(await s.call('/login/tech', { name: 'Al Fixit', secret: '123456' })));
    expect(unknown).toEqual([401, 'Wrong name or PIN.']);
    r = await s.call('/login/tech', { name: '<b>x</b>', secret: '1' });
    expect(r.text).not.toContain('<b>');
    expect(r.text).toContain('value="&lt;b&gt;x&lt;/b&gt;"'); // escaped
    r = await s.call('/login/tech', { name: `"><script>'`, secret: '1' });
    expect(r.text).toContain('value="&quot;&gt;&lt;script&gt;&#x27;"');
  });

  it('lockout', async () => {
    const codes: number[] = [];
    for (const p of ['1', '2', '3', '4', '5'])
      codes.push((await s.call('/login/tech', { name: 'Al Fixit', secret: p })).status);
    const r = await s.call('/login/tech', { name: 'Al Fixit', secret: PINS['Al Fixit'] });
    expect(codes).toEqual([401, 401, 401, 401, 401]);
    expect(r.status).toBe(429); // even the right PIN waits
    expect(r.text).toContain('Wait 10 min.');
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(590);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(600);
    await s.tech('Bo Wrench'); // another name is fine
    const cf = (ip: string) => ({ 'CF-Connecting-IP': ip }); // through cloudflared on this PC
    for (let i = 0; i < 20; i++) await s.call('/login/tech', { name: `Guess ${i}`, secret: '000000' }, undefined, cf('203.0.113.5'));
    const bo = { name: 'Bo Wrench', secret: PINS['Bo Wrench'] };
    const locked = await s.call('/login/tech', bo, undefined, cf('203.0.113.5'));
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(600);
    expect((await s.call('/login/tech', bo, undefined, cf('203.0.113.6'))).status).toBe(303);
    // the header only counts from loopback: the pure cases are in http-core.spec.ts
  });

  it('cookie flags', async () => {
    for (const [path, form, age] of [
      ['/login/admin', { name: ADMIN, secret: PASSWORD }, 7 * 86400],
      ['/login/tech', { name: 'Al Fixit', secret: PINS['Al Fixit'] }, 30 * 86400],
    ] as const) {
      let r = await s.call(path, form);
      const c = r.headers['set-cookie']?.[0] ?? '';
      expect(c).toMatch(new RegExp(`^sid=[\\w-]{43}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict$`));
      r = await s.call(path, form, undefined, { 'X-Forwarded-Proto': 'https' });
      expect(r.headers['set-cookie']?.[0]).toMatch(/; SameSite=Strict; Secure$/); // through the tunnel
    }
  });

  it('sign-in messages', async () => {
    s.accounts.setActive(s.ids['Bo Wrench'] as number, false);
    const off = errLine(await s.call('/login/tech', { name: 'Bo Wrench', secret: PINS['Bo Wrench'] }));
    expect(off).toEqual(errLine(await s.call('/login/tech', { name: 'Nobody Here', secret: '123456' })));
    expect(off).toEqual([401, 'Wrong name or PIN.']);
    const now = Date.now() / 1000;
    s.accounts.until.set('name:al fixit', now + 5 * 3600); // a day-cap lock: hours, not minutes
    expect(errLine(await s.call('/login/tech', { name: 'Al Fixit', secret: '1' }))).toEqual([
      429,
      'Too many tries. Wait 5 hours.',
    ]);
    s.accounts.until.set('name:al fixit', now + 90 * 60);
    expect(errLine(await s.call('/login/tech', { name: 'Al Fixit', secret: '1' }))).toEqual([
      429,
      'Too many tries. Wait 90 min.',
    ]);
    s.accounts.hashWaitMs = 50;
    for (let i = 0; i < 4; i++) await s.accounts.hashing.acquire(0); // every hashing slot taken
    try {
      const r = await s.call('/login/admin', { name: ADMIN, secret: PASSWORD });
      expect(r.status).toBe(429);
      expect(r.text).toContain('The server is busy');
      expect(r.headers['retry-after']).toBe('5');
    } finally {
      for (let i = 0; i < 4; i++) s.accounts.hashing.release();
    }
  });

  it('logout', async () => {
    const bo = await s.tech('Bo Wrench');
    let r = await s.call('/logout', '', bo);
    expect([r.status, r.headers.location]).toEqual([303, '/tech']);
    expect(r.headers['set-cookie']?.[0]).toBe('sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
    expect((await s.call('/api/me', undefined, bo)).status).toBe(401);
    const a = await s.admin();
    r = await s.call('/logout', '', a);
    expect([r.status, r.headers.location]).toEqual([303, '/admin']);
    expect((await s.call('/api/me', undefined, a)).status).toBe(401);
    r = await s.call('/logout', '');
    expect([r.status, r.headers.location]).toEqual([303, '/']);
    // signing in again on a device signs its old session out
    const first = await s.admin();
    const again = sid(await s.call('/login/admin', { name: ADMIN, secret: PASSWORD }, first));
    expect((await s.call('/api/me', undefined, first)).status).toBe(401);
    expect((await s.call('/api/me', undefined, again)).status).toBe(200);
  });
});

describe('first-run setup', () => {
  beforeEach(async () => {
    s = await makeServer({ admin: false });
  });

  it('first run setup', async () => {
    expect(existsSync(s.config.setup)).toBe(false);
    makeSetupCode(s.accounts, s.config.setup);
    const code = readCode();
    expect(code).toMatch(/^[\w-]{12}$/);
    makeSetupCode(s.accounts, s.config.setup); // a restart keeps a live code
    expect(readCode()).toBe(code);
    expect((await s.call('/setup')).text).toContain('action="/setup"');
    const form = { code, name: 'First Boss', password: 'made-up-pass-5', again: 'made-up-pass-5' };
    let r = await s.call('/setup', { ...form, again: 'other-pass-55' });
    expect(errLine(r)).toEqual([400, 'The passwords don&#x27;t match.']); // code kept: not used yet
    r = await s.call('/setup', { ...form, name: '<b>x</b>', again: 'x' });
    expect(r.text).toContain('value="&lt;b&gt;x&lt;/b&gt;"');
    expect(r.text).not.toContain('<b>');
    expect((await s.call('/setup', { ...form, password: 'short', again: 'short' })).status).toBe(400);
    for (let i = 0; i < 5; i++) {
      expect(errLine(await s.call('/setup', { ...form, code: `wrong${i}` }))).toEqual([401, 'Wrong or expired setup code.']);
    }
    r = await s.call('/setup', form); // 5 wrong codes: even the right one waits
    expect(r.status).toBe(429);
    expect(r.text).toContain('Wait 10 min.');
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(590);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(600);
    r = await s.call('/setup', form, undefined, { 'CF-Connecting-IP': '203.0.113.7' }); // another client
    expect([r.status, r.headers.location]).toEqual([303, '/admin']);
    const c = sid(r);
    expect(r.headers['set-cookie']?.[0]).toMatch(/; Max-Age=604800; HttpOnly; SameSite=Strict$/);
    expect(((await s.call('/api/me', undefined, c)).body as { name: string }).name).toBe('First Boss');
    expect(existsSync(s.config.setup)).toBe(false);
    expect(await s.call('/setup')).toMatchObject({ status: 404, body: { error: 'not found' } });
    expect((await s.call('/setup', form, undefined, { 'CF-Connecting-IP': '203.0.113.8' })).status).toBe(404); // once only
    makeSetupCode(s.accounts, s.config.setup); // with an admin: no code made
    expect(existsSync(s.config.setup)).toBe(false);
    writeFileSync(s.config.setup, 'stale\n');
    makeSetupCode(s.accounts, s.config.setup); // ... and an old one is removed
    expect(existsSync(s.config.setup)).toBe(false);
    const log = s.log();
    for (const secret of ['made-up-pass-5', code, 'First Boss']) expect(log).not.toContain(secret);
  });

  it('two setups at once make one admin', async () => {
    makeSetupCode(s.accounts, s.config.setup);
    const form = { code: readCode(), password: 'made-up-pass-5', again: 'made-up-pass-5' };
    const [one, two] = await Promise.all([
      s.call('/setup', { ...form, name: 'First Boss' }),
      s.call('/setup', { ...form, name: 'Second Boss' }),
    ]);
    expect([one.status, two.status].sort()).toEqual([303, 404]);
    expect(s.accounts.list('admin').length).toBe(1);
  });

  it('setup code expires', async () => {
    makeSetupCode(s.accounts, s.config.setup);
    const old = readCode();
    const t = Date.now() / 1000 - 86401;
    utimesSync(s.config.setup, t, t);
    const form = { code: old, name: 'First Boss', password: 'made-up-pass-5', again: 'made-up-pass-5' };
    expect((await s.call('/setup', form)).status).toBe(401); // over 24 hours old
    makeSetupCode(s.accounts, s.config.setup); // the next start makes a new one
    expect(readCode()).not.toBe(old);
  });
});
