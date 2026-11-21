// Ports tests/test_accounts.py (with an injected clock) and shop.py's test_make_admin_command.
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Invalid } from '@shop/domain';
import {
  Accounts,
  casefold,
  checkSecret,
  clientKey,
  hashSecret,
  ITERATIONS,
  Locked,
  LoginFailed,
  makeAdmin,
  tokenHash,
} from '../src/accounts';
import { runAdminCommand } from '../src/cli';
import { openDb } from '../src/db';
import { NotFound } from '../src/errors';
import { TicketStore } from '../src/store';
import { tempDir } from './py';

jest.setTimeout(30_000);

const PW = 'correct horse 1';
const PIN = '123456';
const PIN2 = '567890';
const BAD = 'Sam\udc80'; // a lone surrogate: can't be encoded as UTF-8
const START = 1_800_000_000;

type Clock = { t: number };

async function rejects<T extends Error>(
  p: Promise<unknown>,
  cls: new (...a: never[]) => T,
): Promise<T> {
  try {
    await p;
  } catch (e) {
    if (e instanceof cls) return e;
    throw e;
  }
  throw new Error(`did not throw ${cls.name}`);
}

function throws<T extends Error>(
  f: () => unknown,
  cls: new (...a: never[]) => T,
): T {
  try {
    f();
  } catch (e) {
    if (e instanceof cls) return e;
    throw e;
  }
  throw new Error(`did not throw ${cls.name}`);
}

describe('accounts', () => {
  let db: DatabaseSync;
  let a: Accounts;
  let clock: Clock;
  let path: string;
  let done: () => void;

  beforeEach(() => {
    const tmp = tempDir();
    done = tmp.done;
    path = join(tmp.dir, 'tickets.db');
    db = openDb(path);
    clock = { t: START };
    a = new Accounts(db, { iterations: 1000, now: () => clock.t });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    db.close();
    done();
  });

  const rows = (sql: string): unknown[] => db.prepare(sql).all();
  const fails = (): Promise<LoginFailed> =>
    rejects(a.login('Sam', '000000', 'mechanic', 'c'), LoginFailed);

  it('hash round trip and format', async () => {
    const h = await hashSecret(PIN, 1000);
    const [kind, iters, salt, digest] = h.split('$') as [
      string,
      string,
      string,
      string,
    ];
    expect([
      kind,
      iters,
      Buffer.from(salt, 'hex').length,
      digest.length,
    ]).toEqual(['pbkdf2', '1000', 16, 64]);
    expect(await checkSecret(PIN, h)).toBe(true);
    expect(await checkSecret(PIN2, h)).toBe(false);
    expect(await hashSecret(PIN, 1000)).not.toBe(h); // fresh salt each time
    expect(ITERATIONS).toBe(200_000);
    expect((await hashSecret('x')).split('$')[1]).toBe('200000');
    const corrupt = h.slice(0, -2) + 'éé'; // non-ASCII in the stored digest
    for (const bad of [
      '',
      'nope',
      'pbkdf2$x$00$00',
      'md5$1000$00$00',
      null,
      5,
      corrupt,
      h + '$x',
      h.slice(0, -1),
    ]) {
      expect(await checkSecret(PIN, bad)).toBe(false);
    }
    expect(await checkSecret(BAD, h)).toBe(false);
    expect(await checkSecret(null, h)).toBe(false);
  });

  it('add validation', async () => {
    const e = await rejects(a.add(' a ', 'boss', 'x'), Invalid);
    expect(Object.keys(e.errors).sort()).toEqual(['name', 'role']);
    expect(
      Object.keys(
        (await rejects(a.add('x'.repeat(41), 'mechanic', PIN), Invalid)).errors,
      ),
    ).toEqual(['name']);
    expect(
      Object.keys(
        (await rejects(a.add('Bob\x00', 'mechanic', PIN), Invalid)).errors,
      ),
    ).toEqual(['name']);
    expect(
      Object.keys(
        (await rejects(a.add(['Bob'], 'mechanic', PIN), Invalid)).errors,
      ),
    ).toEqual(['name']);
    expect(
      (await rejects(a.add(BAD, 'mechanic', PIN), Invalid)).errors,
    ).toEqual({
      name: "name has characters that can't be used",
    });
    for (const pin of [
      '1234',
      '12345',
      '123456789',
      '12a456',
      '１２３４５６',
      '١٢٣٤٥٦',
      ' 123456',
      '12345\udc80',
    ]) {
      expect(
        (await rejects(a.add('Sam', 'mechanic', pin), Invalid)).errors,
      ).toEqual({ secret: 'PIN must be 6 to 8 digits' });
    }
    expect(
      (await rejects(a.add('Sam', 'mechanic', 123456), Invalid)).errors,
    ).toEqual({ secret: 'must be text' });
    expect(
      Object.keys(
        (await rejects(a.add('Owner', 'admin', 'short pw'), Invalid)).errors,
      ),
    ).toEqual(['secret']);
    expect(
      Object.keys(
        (await rejects(a.add('Owner', 'admin', 'x'.repeat(201)), Invalid))
          .errors,
      ),
    ).toEqual(['secret']);
    expect(
      (await rejects(a.add('Owner', 'admin', 'long enough\udc80'), Invalid))
        .errors,
    ).toEqual({
      secret: "password has characters that can't be used",
    });
    const u = await a.add('  Sam   Lee ', 'mechanic', PIN);
    expect([u.name, u.role, u.active, u.id > 0]).toEqual([
      'Sam Lee',
      'mechanic',
      true,
      true,
    ]);
    expect(u.created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    expect((await a.add('Ann', 'mechanic', '12345678')).name).toBe('Ann');
    expect((await a.add('Owner', 'admin', '0123456789')).role).toBe('admin');
    expect(a.get(u.id)).toEqual(u);
    expect(a.get(999)).toBeNull();
    expect(a.find(BAD)).toBeNull();
  });

  it('duplicate names any case', async () => {
    await a.add('Sam', 'mechanic', PIN);
    for (const n of ['sam', 'SAM', ' sAm ']) {
      expect(
        (await rejects(a.add(n, 'mechanic', PIN2), Invalid)).errors,
      ).toEqual({ name: `${n.trim()} is already taken` });
    }
    expect(
      (await rejects(a.add('SAM', 'admin', PW), Invalid)).errors['name'],
    ).toMatch(/already taken$/);
    expect(a.find('sAM')?.name).toBe('Sam');
  });

  it('duplicate names fold beyond ASCII, as casefold', async () => {
    await a.add('Strauss', 'mechanic', PIN);
    for (const n of ['Strauß', 'STRAUẞ', 'strauß']) {
      expect(
        (await rejects(a.add(n, 'mechanic', PIN2), Invalid)).errors,
      ).toEqual({ name: `${n} is already taken` });
    }
    expect(casefold('ﬁ')).toBe('fi');
    expect(casefold('ı')).not.toBe(casefold('i')); // casefold keeps the dotless i apart
    expect((await a.add('Fıla', 'mechanic', PIN)).name).toBe('Fıla');
    expect((await a.add('Fila', 'mechanic', PIN)).name).toBe('Fila');
  });

  it('list never returns hashes and filters', async () => {
    const sam = await a.add('Sam', 'mechanic', PIN);
    await a.add('ann', 'mechanic', PIN2);
    await a.add('Owner', 'admin', PW);
    a.setActive(sam.id, false);
    const all = a.list();
    const names = (us: { name: string }[]): string[] => us.map((u) => u.name);
    expect(names(all)).toEqual(['ann', 'Owner', 'Sam']);
    expect(names(a.list('mechanic'))).toEqual(['ann', 'Sam']);
    expect(names(a.list('mechanic', true))).toEqual(['ann']);
    expect(names(a.list(undefined, false))).toEqual(['Sam']);
    expect(names(a.list('admin', false))).toEqual([]);
    for (const u of [...all, a.get(1), a.find('sam')]) {
      expect(Object.keys(u ?? {}).sort()).toEqual([
        'active',
        'created',
        'id',
        'name',
        'role',
      ]);
      expect(JSON.stringify(u)).not.toContain('pbkdf2');
    }
    expect(
      (rows('SELECT hash FROM users') as { hash: string }[]).every((r) =>
        r.hash.startsWith('pbkdf2$1000$'),
      ),
    ).toBe(true);
  });

  it('login success and failure', async () => {
    const sam = await a.add('Sam', 'mechanic', PIN);
    const { token, user } = await a.login(' sam ', PIN, 'mechanic', '1.2.3.4');
    expect(user).toEqual(sam);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(a.session(token)).toEqual({
      role: 'mechanic',
      user_id: sam.id,
      name: 'Sam',
      expires: START + 30 * 86400,
    });
    expect(
      (await rejects(a.login('Sam', PIN2, 'mechanic', 'c'), LoginFailed))
        .message,
    ).toBe('wrong name or PIN');
    expect(
      (await rejects(a.login('Nobody', PIN, 'mechanic', 'c'), LoginFailed))
        .message,
    ).toBe('wrong name or PIN');
    await rejects(a.login('Sam', null, 'mechanic', 'c'), LoginFailed);
    await rejects(a.login(null, PIN, 'mechanic', 'c'), LoginFailed);
    await rejects(
      a.login('Sam', PIN + 'x'.repeat(300), 'mechanic', 'c'),
      LoginFailed,
    );
    await rejects(
      a.login('Sam', PIN, 'mechanic', undefined as unknown as string),
      TypeError,
    ); // client is required
    await a.add('Owner', 'admin', PW);
    const adm = await a.login('OWNER', PW, 'admin', 'c');
    expect(a.session(adm.token)?.expires).toBe(START + 7 * 86400);
    expect(
      (await rejects(a.login('Owner', 'nope', 'admin', 'c'), LoginFailed))
        .message,
    ).toBe('wrong name or password');
  });

  it('unknown name still hashes', async () => {
    const calls = jest.spyOn(a, 'verify');
    await rejects(a.login('Ghost', PIN, 'mechanic', 'c'), LoginFailed);
    const dummy = await a.dummy;
    expect(calls.mock.calls.map((c) => c[1])).toEqual([dummy]);
    expect(dummy.startsWith('pbkdf2$1000$')).toBe(true);
  });

  it('lone surrogates at login', async () => {
    await a.add('Sam', 'mechanic', PIN);
    const calls = jest.spyOn(a, 'verify');
    const prepare = jest.spyOn(db, 'prepare');
    await rejects(a.login(BAD, PIN, 'mechanic', 'c'), LoginFailed); // name: unknown, no query, dummy hash
    expect(calls.mock.calls.map((c) => c[1])).toEqual([await a.dummy]);
    expect(
      prepare.mock.calls.filter(([sql]) => sql.includes('FROM users')),
    ).toEqual([]);
    await rejects(a.login('Sam', '12345\udc80', 'mechanic', 'c'), LoginFailed); // secret: never matches
    expect(a.fails.get(`name:${casefold(BAD)}`)?.length).toBeTruthy(); // both counted
    expect(a.fails.get('name:sam')?.length).toBe(1);
    for (let i = 0; i < 4; i++)
      await rejects(a.login(BAD, PIN, 'mechanic', 'd'), LoginFailed);
    await rejects(a.login(BAD, PIN, 'mechanic', 'd'), Locked);
    expect(a.session('x'.repeat(30) + '\udc80')).toBeNull();
    a.logout('x'.repeat(30) + '\udc80');
  });

  it('wrong role and inactive refused', async () => {
    const sam = await a.add('Sam', 'mechanic', PIN);
    await a.add('Owner', 'admin', PW);
    await rejects(a.login('Sam', PIN, 'admin', 'c'), LoginFailed);
    await rejects(a.login('Owner', PW, 'mechanic', 'c'), LoginFailed);
    await rejects(a.login('Sam', PIN, 'kiosk', 'c'), LoginFailed);
    a.setActive(sam.id, false);
    expect(a.get(sam.id)?.active).toBe(false);
    await rejects(a.login('Sam', PIN, 'mechanic', 'c'), LoginFailed);
    a.setActive(sam.id, true);
    expect((await a.login('Sam', PIN, 'mechanic', 'c')).user.active).toBe(true);
    throws(() => a.setActive(999, false), NotFound);
    await rejects(a.setSecret(999, PIN), NotFound);
  });

  it('last admin guard', async () => {
    const own = await a.add('Owner', 'admin', PW);
    const sam = await a.add('Sam', 'mechanic', PIN);
    expect(throws(() => a.setActive(own.id, false), Invalid).errors).toEqual({
      active: 'keep at least one admin',
    });
    a.setActive(sam.id, false); // mechanics can all be off
    const boss = await a.add('Boss', 'admin', PW);
    a.setActive(own.id, false);
    throws(() => a.setActive(boss.id, false), Invalid);
    a.setActive(own.id, false); // already off: fine
    a.setActive(boss.id, true);
    expect(a.list('admin', true).map((u) => u.name)).toEqual(['Boss']);
  });

  it('lockout per name', async () => {
    await a.add('Sam', 'mechanic', PIN);
    for (let i = 0; i < 5; i++) {
      clock.t += 1;
      await rejects(
        a.login(i % 2 ? 'SAM' : 'sam', '000000', 'mechanic', `10.0.0.${i}`),
        LoginFailed,
      );
    }
    const e = await rejects(
      a.login('Sam', PIN, 'mechanic', '10.0.0.99'),
      Locked,
    ); // right PIN, still locked
    expect(e.retryAfter).toBe(600);
    await rejects(
      a.login('Ann', '000000', 'mechanic', '10.0.0.99'),
      LoginFailed,
    ); // other names unaffected
    clock.t += 599;
    expect(
      (await rejects(a.login('Sam', PIN, 'mechanic', '10.0.0.98'), Locked))
        .retryAfter,
    ).toBe(1);
    clock.t += 2;
    expect((await a.login('Sam', PIN, 'mechanic', '10.0.0.98')).user.name).toBe(
      'Sam',
    );
  });

  it('success clears name failures and the window slides', async () => {
    await a.add('Sam', 'mechanic', PIN);
    for (let i = 0; i < 4; i++) await fails();
    await a.login('Sam', PIN, 'mechanic', 'c');
    for (let i = 0; i < 4; i++) await fails(); // count restarted: not locked yet
    await a.login('Sam', PIN, 'mechanic', 'c');
    for (let i = 0; i < 4; i++) await fails();
    clock.t += 601; // old failures age out of the 10-minute window
    for (let i = 0; i < 4; i++) await fails();
    await fails();
    await rejects(a.login('Sam', PIN, 'mechanic', 'c'), Locked);
  });

  it('day cap per name', async () => {
    const sam = await a.add('Sam', 'mechanic', PIN);
    for (let burst = 0; burst < 4; burst++) {
      // 4 slow bursts of 5: never more than 5 per 10 minutes, 20 in a day
      for (let i = 0; i < 5; i++)
        await rejects(
          a.login('Sam', '000000', 'mechanic', `10.0.${burst}.${i}`),
          LoginFailed,
        );
      if (burst < 3) clock.t += 601;
    }
    expect(
      (await rejects(a.login('Sam', PIN, 'mechanic', '10.9.9.9'), Locked))
        .retryAfter,
    ).toBe(86400);
    clock.t += 3600; // the 10-minute lock is long over; the day lock holds
    expect(
      (await rejects(a.login('Sam', PIN, 'mechanic', '10.9.9.9'), Locked))
        .retryAfter,
    ).toBe(86400 - 3600);
    clock.t = START + 3 * 601 + 86400 - 1;
    await rejects(a.login('Sam', PIN, 'mechanic', '10.9.9.9'), Locked);
    clock.t += 1;
    expect(await a.login('Sam', PIN, 'mechanic', '10.9.9.9')).toBeTruthy();
    // a PIN reset by the admin lifts the day lock at once
    for (let burst = 0; burst < 4; burst++) {
      for (let i = 0; i < 5; i++)
        await rejects(
          a.login('Sam', '000000', 'mechanic', `10.1.${burst}.${i}`),
          LoginFailed,
        );
      clock.t += 601;
    }
    await rejects(a.login('Sam', PIN, 'mechanic', '10.9.9.9'), Locked);
    await a.setSecret(sam.id, PIN2);
    expect(await a.login('Sam', PIN2, 'mechanic', '10.9.9.9')).toBeTruthy();
  });

  it('unlock', async () => {
    await a.add('Sam', 'mechanic', PIN);
    for (let i = 0; i < 5; i++) await fails();
    await rejects(a.login('Sam', PIN, 'mechanic', 'd'), Locked);
    a.unlock(' SAM ');
    expect(await a.login('Sam', PIN, 'mechanic', 'd')).toBeTruthy();
    a.unlock('nobody'); // unknown name: nothing to do
  });

  it('lockout per client', async () => {
    await a.add('Sam', 'mechanic', PIN);
    for (let i = 0; i < 20; i++) {
      clock.t += 1;
      await rejects(
        a.login(`guess${i}`, '000000', 'mechanic', '6.6.6.6'),
        LoginFailed,
      );
    }
    expect(
      (await rejects(a.login('Sam', PIN, 'mechanic', '6.6.6.6'), Locked))
        .retryAfter,
    ).toBe(600); // new name, same client
    clock.t += 300;
    expect(
      (await rejects(a.login('Sam', PIN, 'mechanic', '6.6.6.6'), Locked))
        .retryAfter,
    ).toBe(300);
    expect((await a.login('Sam', PIN, 'mechanic', '7.7.7.7')).user.name).toBe(
      'Sam',
    ); // other clients fine
    clock.t += 300;
    expect(await a.login('Sam', PIN, 'mechanic', '6.6.6.6')).toBeTruthy();
  });

  it('client keys', async () => {
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:2:ffff::9')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:3::1')).not.toBe(clientKey('2001:db8:1:2::1'));
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('not an ip')).toBe('not an ip');
    expect(clientKey('')).toBe('');
    for (let i = 0; i < 20; i++) {
      // one IPv6 /64 hopping addresses is still one client
      await rejects(
        a.login(
          `guess${i}`,
          '000000',
          'mechanic',
          `2001:db8:1:2::${(i + 1).toString(16)}`,
        ),
        LoginFailed,
      );
    }
    await rejects(
      a.login('x', '000000', 'mechanic', '2001:db8:1:2::ffff'),
      Locked,
    );
    await rejects(
      a.login('x', '000000', 'mechanic', '2001:db8:1:3::1'),
      LoginFailed,
    );
  });

  it("parallel guesses can't pass the limit", async () => {
    await a.add('Sam', 'mechanic', PIN);
    const out = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        a.login('Sam', '000000', 'mechanic', 'c'),
      ),
    );
    const names = out.map((r) =>
      r.status === 'rejected' ? (r.reason as Error).name : 'ok',
    );
    expect(names.filter((n) => n === 'LoginFailed').length).toBe(5);
    expect(names.filter((n) => n === 'Locked').length).toBe(7);
  });

  it('hash semaphore', async () => {
    await a.add('Sam', 'mechanic', PIN);
    a.hashWaitMs = 50;
    for (let i = 0; i < 4; i++)
      expect(await a.hashing.acquire(1000)).toBe(true); // four logins busy hashing
    try {
      const e = await rejects(a.login('Sam', PIN, 'mechanic', 'c'), Locked);
      expect([e.retryAfter, e.busy, a.fails.size]).toEqual([5, true, 0]); // turned away before counting
    } finally {
      for (let i = 0; i < 4; i++) a.hashing.release();
    }
    expect(await a.login('Sam', PIN, 'mechanic', 'c')).toBeTruthy();
    expect(() => a.hashing.release()).toThrow(RangeError); // bounded: every acquire was released
  });

  it('a 5th login waits for a free hashing slot', async () => {
    await a.add('Sam', 'mechanic', PIN);
    for (let i = 0; i < 4; i++) await a.hashing.acquire(1000);
    const later = a.login('Sam', PIN, 'mechanic', 'c');
    setTimeout(() => a.hashing.release(), 20);
    expect((await later).user.name).toBe('Sam');
    for (let i = 0; i < 3; i++) a.hashing.release();
  });

  it('reset racing login issues no session', async () => {
    const sam = await a.add('Sam', 'mechanic', PIN);
    const real = a.verify.bind(a);
    // the admin resets the PIN while this login is checking the old one
    jest.spyOn(a, 'verify').mockImplementationOnce(async (s, h) => {
      const ok = await real(s, h);
      await a.setSecret(sam.id, PIN2);
      return ok;
    });
    await rejects(a.login('Sam', PIN, 'mechanic', 'c'), LoginFailed);
    expect(rows('SELECT COUNT(*) AS n FROM sessions')).toEqual([{ n: 0 }]);
    jest.spyOn(a, 'verify').mockImplementationOnce(async (s, h) => {
      // same, turning the account off
      const ok = await real(s, h);
      a.setActive(sam.id, false);
      return ok;
    });
    await rejects(a.login('Sam', PIN2, 'mechanic', 'c'), LoginFailed);
    expect(rows('SELECT COUNT(*) AS n FROM sessions')).toEqual([{ n: 0 }]);
  });

  it('session expiry and logout', async () => {
    await a.add('Sam', 'mechanic', PIN);
    await a.add('Owner', 'admin', PW);
    const mech = (await a.login('Sam', PIN, 'mechanic', 'c')).token;
    const adm = (await a.login('Owner', PW, 'admin', 'c')).token;
    clock.t += 7 * 86400 - 1;
    expect(a.session(adm) && a.session(mech)).toBeTruthy();
    clock.t += 1;
    expect(a.session(adm)).toBeNull();
    expect(a.session(mech)).toBeTruthy();
    expect(rows('SELECT * FROM sessions').length).toBe(1); // the expired one was deleted
    clock.t += 23 * 86400;
    expect(a.session(mech)).toBeNull();
    const tok = (await a.login('Sam', PIN, 'mechanic', 'c')).token;
    a.logout(tok);
    expect(a.session(tok)).toBeNull();
    for (const junk of [null, '', 'x'.repeat(500), 5, tok + 'x'])
      expect(a.session(junk)).toBeNull();
    a.logout(null);
  });

  it('expired sessions pruned on new session', async () => {
    await a.add('Sam', 'mechanic', PIN);
    for (let i = 0; i < 3; i++) await a.login('Sam', PIN, 'mechanic', 'c');
    clock.t += 31 * 86400;
    await a.login('Sam', PIN, 'mechanic', 'c');
    expect(rows('SELECT * FROM sessions').length).toBe(1);
  });

  it('revoke on reset and deactivate', async () => {
    const sam = await a.add('Sam', 'mechanic', PIN);
    const ann = await a.add('Ann', 'mechanic', PIN2);
    const t1 = (await a.login('Sam', PIN, 'mechanic', 'c')).token;
    const t2 = (await a.login('Sam', PIN, 'mechanic', 'c')).token;
    let ta = (await a.login('Ann', PIN2, 'mechanic', 'c')).token;
    await rejects(a.setSecret(sam.id, '12'), Invalid); // bad PIN: nothing changes
    expect(a.session(t1)).toBeTruthy();
    await a.setSecret(sam.id, '999999');
    expect([a.session(t1), a.session(t2)]).toEqual([null, null]);
    expect(a.session(ta)).toBeTruthy();
    await rejects(a.login('Sam', PIN, 'mechanic', 'c'), LoginFailed);
    const t3 = (await a.login('Sam', '999999', 'mechanic', 'c')).token;
    a.setActive(ann.id, false);
    expect(a.session(ta)).toBeNull();
    expect(a.session(t3)).toBeTruthy();
    // a session row left for an inactive user (e.g. turned off by another process) is refused and deleted
    a.setActive(ann.id, true);
    ta = (await a.login('Ann', PIN2, 'mechanic', 'c')).token;
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(ann.id);
    expect(a.session(ta)).toBeNull();
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
        .get(ann.id),
    ).toEqual({ n: 0 });
    // revokeUser signs a user out everywhere
    a.revokeUser(sam.id);
    expect(a.session(t3)).toBeNull();
  });

  it('kiosk sessions are never valid and are deleted', async () => {
    await a.add('Sam', 'mechanic', PIN);
    const m = (await a.login('Sam', PIN, 'mechanic', 'c')).token;
    const kiosk = (k: string): void => {
      db.prepare(
        "INSERT INTO sessions (token_hash, user_id, role, expires, created) VALUES (?, NULL, 'kiosk', ?, ?)",
      ).run(tokenHash(k), clock.t + 365 * 86400, clock.t);
    };
    kiosk('k'.repeat(43));
    expect(a.session('k'.repeat(43))).toBeNull(); // the kiosk isn't ported: refused and deleted on read
    expect(rows("SELECT * FROM sessions WHERE role = 'kiosk'")).toEqual([]);
    kiosk('k1'.repeat(22));
    kiosk('k2'.repeat(22));
    expect(a.deleteKioskSessions()).toBe(2);
    expect(a.deleteKioskSessions()).toBe(0);
    expect(a.session(m)).toBeTruthy();
  });

  it('tokens not stored in plain text', async () => {
    await a.add('Sam', 'mechanic', PIN);
    const tok = (await a.login('Sam', PIN, 'mechanic', 'c')).token;
    const dump = JSON.stringify([
      rows('SELECT * FROM users'),
      rows('SELECT * FROM sessions'),
    ]);
    expect(dump).not.toContain(tok);
    expect(dump).not.toContain(PIN);
    const hashes = (
      rows('SELECT token_hash FROM sessions') as { token_hash: string }[]
    ).map((r) => r.token_hash);
    expect(hashes).toEqual([tokenHash(tok)]);
    expect(hashes[0]).toHaveLength(64);
  });

  it('shares the ticket store database', async () => {
    const st = new TicketStore(db);
    await a.add('Sam', 'mechanic', PIN);
    expect(st.list()).toEqual([]);
    expect(a.find('sam')).toBeTruthy();
    db.close();
    db = openDb(path);
    const a2 = new Accounts(db, { iterations: 1000 }); // tables already there
    expect(a2.list().map((u) => u.name)).toEqual(['Sam']);
  });

  it('make admin', async () => {
    await rejects(makeAdmin(a, 'Owner', 'short'), Invalid);
    const u = await makeAdmin(a, '  Owner ', PW);
    expect([u.role, u.name]).toEqual(['admin', 'Owner']);
    let tok = (await a.login('owner', PW, 'admin', 'c')).token;
    const boss = await a.add('Boss', 'admin', PW);
    a.setActive(u.id, false);
    const u2 = await makeAdmin(a, 'OWNER', 'another password');
    expect([u2.id, u2.active, a.session(tok)]).toEqual([u.id, true, null]);
    await rejects(a.login('Owner', PW, 'admin', 'c'), LoginFailed);
    tok = (await a.login('Owner', 'another password', 'admin', 'c')).token;
    await makeAdmin(a, 'Owner', 'third password');
    expect(a.session(tok)).toBeNull();
    for (let i = 0; i < 5; i++)
      await rejects(
        a.login('Owner', 'wrong password', 'admin', 'c'),
        LoginFailed,
      );
    await rejects(a.login('Owner', 'third password', 'admin', 'd'), Locked);
    await makeAdmin(a, 'owner', 'fourth password'); // also lifts the lock
    expect(
      await a.login('Owner', 'fourth password', 'admin', 'd'),
    ).toBeTruthy();
    await a.add('Sam', 'mechanic', PIN);
    expect((await rejects(makeAdmin(a, 'sam', PW), Invalid)).errors).toEqual({
      name: 'Sam is a mechanic',
    });
    expect(a.list('admin').length).toBe(2);
    expect(boss.role).toBe('admin');
  });
});

describe('admin command', () => {
  it('makes an admin; a mistyped repeat changes nothing', async () => {
    const tmp = tempDir();
    const path = join(tmp.dir, 'tickets.db');
    try {
      const typed = [
        'made-up-pass-1',
        'made-up-pass-1',
        'made-up-pass-1',
        'something-else-2',
      ];
      const out: string[] = [];
      const prompts: Array<[string, boolean]> = [];
      const io = {
        prompt: async (q: string, hidden: boolean): Promise<string> => {
          prompts.push([q, hidden]);
          return typed.shift() ?? '';
        },
        out: (s: string): void => void out.push(s),
      };
      expect(await runAdminCommand(['admin', 'Test Boss'], io, path)).toBe(0);
      expect(out.pop()).toBe(
        'Admin Test Boss is ready; sign in at /admin. A running server keeps its lockout until start-shop.bat restarts it.',
      );
      expect(await runAdminCommand(['admin', 'Test Boss'], io, path)).toBe(1); // typed twice, not the same
      expect(out.pop()).toMatch(/match/);
      expect(prompts).toEqual([
        ['New password (10+ characters): ', true],
        ['Same password again: ', true],
        ['New password (10+ characters): ', true],
        ['Same password again: ', true],
      ]);
      expect(out.join('\n')).not.toContain('made-up-pass');
      expect(await runAdminCommand(['admin'], io, path)).toBe(1);
      expect(out.pop()).toBe('usage: node shop-web/apps/api/dist/main.js [admin <name> | import-invomax]');
      typed.push('short', 'short');
      expect(await runAdminCommand(['admin', 'Test Boss'], io, path)).toBe(1);
      expect(out.pop()).toBe('password must be 10 to 200 characters');
      const db = openDb(path);
      try {
        const acc = new Accounts(db, { iterations: 1000 });
        expect(acc.list().map((u) => [u.name, u.role])).toEqual([
          ['Test Boss', 'admin'],
        ]);
        expect(
          (await acc.login('test boss', 'made-up-pass-1', 'admin', '127.0.0.1'))
            .user.name,
        ).toBe('Test Boss');
      } finally {
        db.close();
      }
    } finally {
      tmp.done();
    }
  });
});
