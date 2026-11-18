// Shop accounts in tickets.db (accounts.py): admin and mechanic users, hashed secrets, sessions and a login
// lockout per name and per client. The server maps Invalid -> 400, LoginFailed -> 401, Locked -> 429.
// The kiosk role is not ported: kiosk session rows are never valid here and are deleted on read.
import { createHash, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { Invalid, nowIso, squash } from '@shop/domain';
import { NotFound } from './errors';

export const ITERATIONS = 200_000;
export const LIFETIME: Record<string, number> = {
  admin: 7 * 86400,
  mechanic: 30 * 86400,
};
export const ROLES = ['admin', 'mechanic'] as const;
const WINDOW = 600; // failures counted over 10 minutes
const LOCKOUT = 600; // a lock lasts 10 minutes
const DAY = 86400; // long cap: 20 failures for a name in 24 h locks it for 24 h (or until a reset)
const MAX_NAME_FAILS = 5;
const MAX_CLIENT_FAILS = 20;
const MAX_DAY_FAILS = 20;
export const MAX_SECRET = 200; // longer secrets are refused (and never hashed at login)
const MAX_KEYS = 50_000; // lockout memory cap
const HASHERS = 4; // at most 4 logins hashing at once; a 5th waits up to 2 s, then gets Locked(5)
const HASH_WAIT_MS = 2000;

export type Role = (typeof ROLES)[number];
export type User = {
  id: number;
  name: string;
  role: Role;
  active: boolean;
  created: string;
};
export type Session = {
  role: string;
  user_id: number | null;
  name: string;
  expires: number;
};

/** Wrong name, secret or role, or the account is off; the message never says which. */
export class LoginFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginFailed';
  }
}

/** Too many wrong tries for this name or client (or the server is busy); retryAfter is whole seconds to wait. */
export class Locked extends Error {
  readonly retryAfter: number;
  readonly busy: boolean; // too many logins at once
  constructor(
    retryAfter: number,
    message = 'too many wrong tries; wait and try again',
    busy = false,
  ) {
    super(message);
    this.name = 'Locked';
    this.retryAfter = Math.max(Math.floor(retryAfter + 0.999), 1);
    this.busy = busy;
  }
}

// ---- Python string semantics ----

/** True if s is a string that encodes as UTF-8 (no lone surrogates; with /u a valid pair is one code point). */
export const utf8 = (s: unknown): s is string =>
  typeof s === 'string' && !/[\uD800-\uDFFF]/u.test(s);

/** Python's len(): code points, counting no further than `cap` + 1. */
function cpLen(s: string, cap: number): number {
  if (s.length <= cap) return [...s].length;
  let n = 0;
  const it = s[Symbol.iterator]();
  while (n <= cap && !it.next().done) n++;
  return n;
}

/** a[a.length - n]: the n-th newest failure time (callers check the length first). */
const nthLast = (a: number[], n: number): number => a[a.length - n] ?? 0;

/** Python's s[:n] on code points. */
function cpSlice(s: string, n: number): string {
  if (s.length <= n) return s;
  let i = 0;
  let out = '';
  for (const c of s) {
    if (i++ >= n) break;
    out += c;
  }
  return out;
}

/** Python's str.isprintable(): no Other (Cc, Cf, Cs, Co, Cn) or Separator characters except the ASCII space. */
const isPrintable = (s: string): boolean => !/(?! )[\p{C}\p{Z}]/u.test(s);

/**
 * Python's str.casefold() for comparing names. Full case folding equals lower(upper(lower(s))) for every code
 * point except the dotless ı, which casefold keeps apart from i (checked against Python 3.12 over all of
 * Unicode; the only other differences are case pairs added after Unicode 15, which Python doesn't know yet).
 */
export function casefold(s: string): string {
  return s
    .split('ı')
    .map((p) => p.toLowerCase().toUpperCase().toLowerCase())
    .join('ı');
}

// ---- secrets ----

const derive = (
  secret: string,
  salt: Buffer,
  iterations: number,
): Promise<Buffer> =>
  new Promise((ok, fail) =>
    pbkdf2(secret, salt, iterations, 32, 'sha256', (e, key) =>
      e ? fail(e) : ok(key),
    ),
  );

/** -> "pbkdf2$iters$salt_hex$hash_hex" (sha256, 16-byte random salt), as accounts.hash_secret. */
export async function hashSecret(
  secret: string,
  iterations = ITERATIONS,
  salt?: Buffer,
): Promise<string> {
  const s = salt && salt.length ? salt : randomBytes(16);
  const h = await derive(secret, s, iterations);
  return `pbkdf2$${iterations}$${s.toString('hex')}$${h.toString('hex')}`;
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/;

/** True if secret matches a hashSecret() string; false for anything malformed (either side). */
export async function checkSecret(
  secret: unknown,
  stored: unknown,
): Promise<boolean> {
  if (!utf8(secret) || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const [kind, iters, salt, want] = parts as [string, string, string, string];
  if (!/^[0-9]{1,9}$/.test(iters) || !HEX.test(salt) || !HEX.test(want))
    return false;
  const n = Number(iters);
  if (kind !== 'pbkdf2' || !(n > 0 && n <= 10_000_000)) return false;
  const got = await derive(secret, Buffer.from(salt, 'hex'), n);
  const w = Buffer.from(want, 'hex');
  return got.length === w.length && timingSafeEqual(got, w);
}

export const tokenHash = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

// ---- client keys ----

/** IPv6 text -> 8 groups (embedded IPv4 tail expanded); the caller has checked isIP() === 6. */
function ipv6Groups(ip: string): number[] {
  let s = ip.replace(/%.*$/, '');
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    s =
      s.slice(0, v4.index) +
      ((a << 8) | b).toString(16) +
      ':' +
      ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill =
    tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16));
}

/** Python's compressed IPv6 text (longest run of 2+ zero groups as ::, the first one on a tie). */
function ipv6Text(g: number[]): string {
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) [best, bestLen] = [i, j - i];
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/** IPv4 address as is; IPv6 by its /64 (one home or phone gets a whole /64); anything else as text. */
export function clientKey(client: string): string {
  const s = String(client).trim();
  if (isIP(s) === 4) return s; // isIP refuses leading zeros, as Python does: s is already canonical
  if (isIP(s) !== 6 || s.includes('%')) return String(client); // a zoned address never comes from a client
  const g = ipv6Groups(s);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [hi, lo] = [g[6] ?? 0, g[7] ?? 0];
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return `${ipv6Text([...g.slice(0, 4), 0, 0, 0, 0])}/64`;
}

// ---- validation ----

/** -> squashed name, or throw Invalid({name}). */
export function cleanName(name: unknown): string {
  if (typeof name !== 'string')
    throw new Invalid({ name: 'name must be text' });
  const n = squash(name);
  const len = cpLen(n, 40);
  if (len < 2 || len > 40)
    throw new Invalid({ name: 'name must be 2 to 40 characters' });
  if (!isPrintable(n) || !utf8(n))
    throw new Invalid({ name: "name has characters that can't be used" });
  return n;
}

/** Throw Invalid({secret}) unless secret suits role: admin password 10+ characters, mechanic PIN 6-8 digits. */
export function checkNewSecret(role: string, secret: unknown): void {
  if (typeof secret !== 'string') throw new Invalid({ secret: 'must be text' });
  if (role === 'admin') {
    const len = cpLen(secret, MAX_SECRET);
    if (len < 10 || len > MAX_SECRET)
      throw new Invalid({
        secret: `password must be 10 to ${MAX_SECRET} characters`,
      });
    if (!utf8(secret))
      throw new Invalid({
        secret: "password has characters that can't be used",
      });
  } else if (!/^[0-9]{6,8}$/.test(secret)) {
    throw new Invalid({ secret: 'PIN must be 6 to 8 digits' });
  }
}

// ---- hashing slots ----

/** A bounded counting semaphore whose acquire gives up after a wait. */
export class Semaphore {
  private free: number;
  private readonly waiting: Array<(got: boolean) => void> = [];
  constructor(private readonly size: number) {
    this.free = size;
  }

  acquire(timeoutMs: number): Promise<boolean> {
    if (this.free > 0 && !this.waiting.length) {
      this.free--;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(wake), 1);
        resolve(false);
      }, timeoutMs);
      const wake = (got: boolean): void => {
        clearTimeout(timer);
        resolve(got);
      };
      this.waiting.push(wake);
    });
  }

  /** Hands the slot to the first waiter, else frees it; throws if nothing was held. */
  release(): void {
    const next = this.waiting.shift();
    if (next) return next(true);
    if (this.free >= this.size)
      throw new RangeError('semaphore released too many times');
    this.free++;
  }
}

// ---- accounts ----

type UserRow = {
  id: number;
  name: string;
  role: Role;
  active: number;
  created: string;
};
type LoginRow = UserRow & { hash: string };
const USER_COLS = 'SELECT id, name, role, active, created FROM users';
const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  role: r.role,
  active: Boolean(r.active),
  created: r.created,
});

/** Users and sessions in the tickets.db SQLite file (one DatabaseSync on the event loop: no lock needed). */
export class Accounts {
  readonly iterations: number;
  readonly now: () => number;
  /** Verified when the name is unknown, so a wrong name costs as much as a wrong secret. */
  readonly dummy: Promise<string>;
  /** Lockout, in memory: key ("name:<casefold>" / "client:<key>") -> failure times / lock end. */
  readonly fails = new Map<string, number[]>();
  readonly until = new Map<string, number>();
  private pruned = 0;
  readonly hashing = new Semaphore(HASHERS);
  hashWaitMs = HASH_WAIT_MS;

  constructor(
    private readonly db: DatabaseSync,
    opts: { iterations?: number; now?: () => number } = {},
  ) {
    this.iterations = opts.iterations ?? ITERATIONS;
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.dummy = hashSecret(randomBytes(16).toString('hex'), this.iterations);
    db.exec(
      'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, ' +
        'name TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL, hash TEXT NOT NULL, ' +
        'active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL)',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER, ' +
        'role TEXT NOT NULL, expires REAL NOT NULL, created REAL NOT NULL)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)');
  }

  /** The secret check login runs (a method so a test can watch or slow it). */
  verify(secret: string, stored: string): Promise<boolean> {
    return checkSecret(secret, stored);
  }

  // users

  get(id: number): User | null {
    const row = this.db.prepare(`${USER_COLS} WHERE id = ?`).get(id) as
      UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /** The user with this name (any case), or null. */
  find(name: unknown): User | null {
    const n = squash(name);
    if (!utf8(n)) return null;
    const row = this.db.prepare(`${USER_COLS} WHERE name = ?`).get(n) as
      UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /** Users without hashes, by name; role / active undefined = any. */
  list(role?: string | null, active?: boolean | null): User[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (role) {
      where.push('role = ?');
      args.push(role);
    }
    if (active !== undefined && active !== null) {
      where.push('active = ?');
      args.push(active ? 1 : 0);
    }
    const sql =
      USER_COLS +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY name COLLATE NOCASE';
    return (this.db.prepare(sql).all(...args) as UserRow[]).map(toUser);
  }

  /** New active user; throws Invalid ({name|role|secret: message}). */
  async add(name: unknown, role: unknown, secret: unknown): Promise<User> {
    const errors: Record<string, string> = {};
    let n = '';
    try {
      n = cleanName(name);
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      Object.assign(errors, e.errors);
    }
    if (
      typeof role !== 'string' ||
      !(ROLES as readonly string[]).includes(role)
    ) {
      errors['role'] = 'role must be admin or mechanic';
    } else {
      try {
        checkNewSecret(role, secret);
      } catch (e) {
        if (!(e instanceof Invalid)) throw e;
        Object.assign(errors, e.errors);
      }
    }
    if (Object.keys(errors).length) throw new Invalid(errors);
    const h = await hashSecret(secret as string, this.iterations);
    const created = nowIso(new Date(this.now() * 1000));
    // NOCASE only folds ASCII: Strauss and Strauß are one name too. Synchronous from here to the insert.
    const folded = casefold(n);
    const names = this.db.prepare('SELECT name FROM users').all() as Array<{
      name: string;
    }>;
    if (names.some((r) => casefold(r.name) === folded))
      throw new Invalid({ name: `${n} is already taken` });
    let id: number;
    try {
      id = Number(
        this.db
          .prepare(
            'INSERT INTO users (name, role, hash, active, created) VALUES (?, ?, ?, 1, ?)',
          )
          .run(n, role as string, h, created).lastInsertRowid,
      );
    } catch (e) {
      if ((e as { errcode?: number }).errcode === 2067)
        throw new Invalid({ name: `${n} is already taken` }); // UNIQUE
      throw e;
    }
    return { id, name: n, role: role as Role, active: true, created };
  }

  /** New PIN/password (NotFound if unknown; Invalid if unsuitable); signs them out everywhere, clears their lockout. */
  async setSecret(userId: number, secret: unknown): Promise<void> {
    const user = this.get(userId);
    if (!user) throw new NotFound(`no user ${userId}`);
    checkNewSecret(user.role, secret);
    const h = await hashSecret(secret as string, this.iterations);
    // synchronous: no session can be issued between the new hash and the sign-out
    this.db.prepare('UPDATE users SET hash = ? WHERE id = ?').run(h, userId);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    this.unlock(user.name);
  }

  /** Turn an account on or off (NotFound if unknown); off signs them out. Never turns off the last active admin. */
  setActive(userId: number, active: boolean): void {
    const row = this.db
      .prepare('SELECT role, active FROM users WHERE id = ?')
      .get(userId) as { role: string; active: number } | undefined;
    if (!row) throw new NotFound(`no user ${userId}`);
    if (!active && row.role === 'admin' && row.active === 1) {
      const c = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1",
        )
        .get() as { n: number };
      if (c.n <= 1) throw new Invalid({ active: 'keep at least one admin' });
    }
    this.db
      .prepare('UPDATE users SET active = ? WHERE id = ?')
      .run(active ? 1 : 0, userId);
    if (!active)
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  // lockout (in memory; synchronous, so no lock is needed)

  /** Seconds this key stays locked (0 = open). */
  private locked(t: number, key: string): number {
    const times = this.fails.get(key) ?? [];
    const waits = [(this.until.get(key) ?? 0) - t];
    if (key.startsWith('name:')) {
      const recent = times.filter((x) => t - x < WINDOW);
      if (recent.length >= MAX_NAME_FAILS)
        waits.push(nthLast(recent, MAX_NAME_FAILS) + WINDOW - t);
      if (times.length >= MAX_DAY_FAILS)
        waits.push(nthLast(times, MAX_DAY_FAILS) + DAY - t);
    } else if (times.length >= MAX_CLIENT_FAILS) {
      waits.push(nthLast(times, MAX_CLIENT_FAILS) + WINDOW - t);
    }
    return Math.max(Math.max(...waits), 0);
  }

  private prune(t: number): void {
    if (t - this.pruned < 60 && this.fails.size < MAX_KEYS) return; // once a minute is plenty
    this.pruned = t;
    for (const [key, times] of this.fails) {
      const keep = key.startsWith('name:') ? DAY : WINDOW;
      const left = times.filter((x) => t - x < keep);
      if (left.length) this.fails.set(key, left);
      else this.fails.delete(key);
    }
    for (const [key, u] of this.until) if (u <= t) this.until.delete(key);
    if (this.fails.size >= MAX_KEYS) {
      // flood of made-up names: forget the oldest name keys (locks stay)
      const names = [...this.fails].filter(([k]) => k.startsWith('name:'));
      names.sort((a, b) => nthLast(a[1], 1) - nthLast(b[1], 1));
      for (const [k] of names.slice(0, MAX_KEYS / 2)) this.fails.delete(k);
    }
  }

  private fail(t: number, keys: string[]): void {
    const lockUntil = (k: string, end: number): void => {
      this.until.set(k, Math.max(this.until.get(k) ?? 0, end));
    };
    for (const k of keys) {
      const times = this.fails.get(k) ?? [];
      if (k.startsWith('name:')) {
        if (times.filter((x) => t - x < WINDOW).length >= MAX_NAME_FAILS)
          lockUntil(k, t + LOCKOUT);
        if (times.length >= MAX_DAY_FAILS) lockUntil(k, t + DAY);
      } else if (times.length >= MAX_CLIENT_FAILS) {
        lockUntil(k, t + LOCKOUT);
      }
    }
  }

  /** Forget a name's wrong tries and locks (an admin reset, or makeAdmin). */
  unlock(name: unknown): void {
    const key = `name:${casefold(squash(name))}`;
    this.fails.delete(key);
    this.until.delete(key);
  }

  // sessions

  /** New session token, only while the user's hash is still `verified` and they are active (a reset or
   * turn-off racing the login wins); null if not. */
  private newSession(
    userId: number,
    role: string,
    verified: string,
  ): string | null {
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(t); // prune on every new session
    const made = this.db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, role, expires, created) SELECT ?, id, ?, ?, ? ' +
          'FROM users WHERE id = ? AND hash = ? AND active = 1 AND role = ?',
      )
      .run(
        tokenHash(token),
        role,
        t + (LIFETIME[role] ?? 0),
        t,
        userId,
        verified,
        role,
      );
    return made.changes ? token : null;
  }

  /**
   * -> {token, user}. Throws Locked (too many wrong tries, even with the right secret, or too many logins
   * hashing at once) or LoginFailed. client is the caller's IP. Every attempt counts as a failure for name and
   * client until it succeeds, so parallel guesses can't slip past the limits.
   */
  async login(
    name: unknown,
    secret: unknown,
    role: string,
    client: string,
  ): Promise<{ token: string; user: User }> {
    if (typeof client !== 'string') throw new TypeError('client is required');
    const n = cpSlice(squash(typeof name === 'string' ? name : ''), 80);
    const keys = [`name:${casefold(n)}`, `client:${clientKey(client)}`];
    if (!(await this.hashing.acquire(this.hashWaitMs)))
      throw new Locked(5, 'busy; try again in a few seconds', true);
    let t: number;
    let row: LoginRow | undefined;
    let ok: boolean;
    try {
      t = this.now();
      this.prune(t);
      const wait = Math.max(...keys.map((k) => this.locked(t, k)));
      if (wait > 0) throw new Locked(wait);
      for (const k of keys) {
        const times = this.fails.get(k);
        if (times) times.push(t);
        else this.fails.set(k, [t]);
      }
      // a lone surrogate can't be a stored name: treat as unknown, no query
      if (utf8(n)) {
        row = this.db
          .prepare(
            'SELECT id, name, role, active, created, hash FROM users WHERE name = ?',
          )
          .get(n) as LoginRow | undefined;
      }
      const usable =
        typeof secret === 'string' &&
        cpLen(secret, MAX_SECRET) <= MAX_SECRET &&
        utf8(secret);
      ok =
        (await this.verify(
          usable ? secret : '',
          row ? row.hash : await this.dummy,
        )) && usable; // hash even if unknown
    } finally {
      this.hashing.release();
    }
    let token: string | null = null;
    if (ok && row && row.active && row.role === role)
      token = this.newSession(row.id, role, row.hash);
    if (token === null || !row) {
      this.fail(t, keys);
      throw new LoginFailed(
        `wrong name or ${role === 'admin' ? 'password' : 'PIN'}`,
      );
    }
    const [nameKey, clientK] = keys as [string, string];
    this.fails.delete(nameKey);
    this.until.delete(nameKey);
    const ct = this.fails.get(clientK);
    const at = ct ? ct.indexOf(t) : -1;
    if (ct && at >= 0) ct.splice(at, 1); // this attempt was right: not a client failure
    return { token, user: toUser(row) };
  }

  /** {role, user_id, name, expires} for a live session, else null (expired, account off, or kiosk: deleted). */
  session(token: unknown): Session | null {
    if (typeof token !== 'string' || token.length > 400 || !utf8(token))
      return null;
    const len = cpLen(token, 200);
    if (len < 20 || len > 200) return null;
    const th = tokenHash(token);
    const row = this.db
      .prepare(
        'SELECT s.role, s.user_id, s.expires, u.name, u.active, u.role AS urole FROM sessions s ' +
          'LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      )
      .get(th) as
      | {
          role: string;
          user_id: number | null;
          expires: number;
          name: string | null;
          active: number | null;
          urole: string | null;
        }
      | undefined;
    if (!row) return null;
    const good =
      row.expires > this.now() &&
      row.user_id !== null &&
      Boolean(row.active) &&
      row.urole === row.role;
    if (!good) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th);
      return null;
    }
    return {
      role: row.role,
      user_id: row.user_id,
      name: row.name ?? '',
      expires: row.expires,
    };
  }

  logout(token: unknown): void {
    if (utf8(token))
      this.db
        .prepare('DELETE FROM sessions WHERE token_hash = ?')
        .run(tokenHash(token));
  }

  revokeUser(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  /** Deletes the kiosk sessions Python made (the kiosk isn't ported); -> how many. */
  deleteKioskSessions(): number {
    return Number(
      this.db.prepare("DELETE FROM sessions WHERE role = 'kiosk'").run()
        .changes,
    );
  }
}

/**
 * Create the admin, or reset their password, turn them on, sign them out everywhere and clear their lockout in
 * this process (from the command line, a running server keeps its own lockout until restarted).
 * Throws Invalid (bad name/password, or the name belongs to a mechanic).
 */
export async function makeAdmin(
  accounts: Accounts,
  name: unknown,
  password: unknown,
): Promise<User> {
  let user = accounts.find(cleanName(name));
  if (!user) {
    user = await accounts.add(name, 'admin', password);
  } else if (user.role !== 'admin') {
    throw new Invalid({ name: `${user.name} is a mechanic` });
  } else {
    await accounts.setSecret(user.id, password); // validates, revokes sessions, unlocks
    accounts.setActive(user.id, true);
  }
  accounts.unlock(user.name);
  return accounts.get(user.id) as User;
}
