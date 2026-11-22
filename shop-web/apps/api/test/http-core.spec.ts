// Ports the HTTP-core cases of tests/test_shop.py: one server per port, bad requests, a stalled body,
// security headers, 500s that say nothing, cross-site posts, the client address and the request log.
import { readFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { Invalid, Refused } from '@shop/domain';
import { Locked, LoginFailed, tokenHash } from '../src/accounts';
import { errorHandler } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { BadInput, NotFound } from '../src/errors';
import { crashExit, processGuard } from '../src/http/log';
import { clientIp, jsonBody } from '../src/http/security';
import { listen, startServer } from '../src/server';
import { CAR, makeServer, PINS, send, ADMIN, PASSWORD, type TestServer } from './helpers';
import { tempDir } from './py';

jest.setTimeout(30_000);

/** Raw bytes on a socket; resolves with what came back once the server ends the connection. */
function raw(base: string, head: string, timeoutMs = 10_000): Promise<string> {
  const port = Number(new URL(base).port);
  return new Promise((ok, fail) => {
    const s = connect(port, '127.0.0.1', () => s.write(head));
    let got = '';
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      fail(new Error('server kept the connection'));
    });
    s.on('data', (c) => (got += c.toString('latin1')));
    s.on('error', () => ok(got)); // a reset: the server hung up
    s.on('close', () => ok(got));
  });
}

describe('one server per port', () => {
  it('a second copy fails with EADDRINUSE; the first deletes kiosk sessions and makes a setup code', async () => {
    const { dir, done } = tempDir();
    try {
      // the nightly run reads a temp InvoMax folder, never the real one
      const config = loadConfig({ SHOP_ROOT: dir, SHOP_PORT: '0', INVOMAX_DIR: join(dir, 'InvoMax') });
      const db = openDb(config.db);
      db.exec(
        'CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER, role TEXT NOT NULL, ' +
          'expires REAL NOT NULL, created REAL NOT NULL)',
      );
      db.prepare("INSERT INTO sessions VALUES (?, NULL, 'kiosk', ?, 0)").run(tokenHash('k'.repeat(43)), 4e9);
      db.close();
      const first = await startServer(config);
      try {
        const check = openDb(config.db);
        expect(check.prepare("SELECT COUNT(*) AS n FROM sessions WHERE role = 'kiosk'").get()).toEqual({ n: 0 });
        check.close();
        expect(readFileSync(config.setup, 'utf8').trim()).toMatch(/^[\w-]{12}$/); // no admin yet
        await expect(startServer({ ...config, port: first.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
        const r = await send(`http://127.0.0.1:${first.port}`, 'GET', '/');
        expect(r.status).toBe(200); // the first still answers
      } finally {
        await first.close();
      }
    } finally {
      done();
    }
  });

  it('listens with the 20 s stall limits by default', async () => {
    const { dir, done } = tempDir();
    const config = loadConfig({ SHOP_ROOT: dir, SHOP_PORT: '0' });
    const server = await listen(express(), config);
    try {
      expect([server.requestTimeout, server.headersTimeout]).toEqual([20_000, 20_000]);
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    } finally {
      await new Promise((ok) => server.close(ok));
      done();
    }
  });

  it('a server error after listening is logged, and the server keeps serving', async () => {
    const { dir, done } = tempDir();
    const config = loadConfig({ SHOP_ROOT: dir, SHOP_PORT: '0' });
    const server = await listen(express().get('/', (_q, r) => void r.send('hi')), config, { log: config.log });
    try {
      const boom = Object.assign(new Error('EMFILE: too many open files C:\\secret'), { code: 'EMFILE' });
      expect(() => server.emit('error', boom)).not.toThrow(); // no listener would throw here: the process dies
      expect(server.listening).toBe(true);
      const r = await send(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'GET', '/');
      expect(r.text).toBe('hi');
      const log = readFileSync(config.log, 'utf8');
      expect(log).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d error Error\n$/);
    } finally {
      await new Promise((ok) => server.close(ok));
      done();
    }
  });

  it('the process guard logs the class name only and throws nothing', () => {
    const { dir, done } = tempDir();
    try {
      const log = join(dir, 'shop.log');
      const guard = processGuard(log);
      expect(() => guard(new TypeError('secret of undefined'))).not.toThrow();
      expect(() => guard('a secret string')).not.toThrow();
      expect(() => guard(Object.assign(Object.create(null), { secret: 1 }))).not.toThrow();
      expect(() => processGuard(join(dir, 'no', 'such', 'dir.log'))(new Error('x'))).not.toThrow(); // log unwritable
      const lines = readFileSync(log, 'utf8').trim().split('\n');
      expect(lines.map((l) => l.slice(20))).toEqual(['error TypeError', 'error string', 'error Object']);
    } finally {
      done();
    }
  });

  it('an uncaught error is logged (class name only) before the process exits 1 (R13)', () => {
    const { dir, done } = tempDir();
    try {
      const log = join(dir, 'shop.log');
      const codes: number[] = [];
      const onCrash = crashExit(log, (code) => {
        expect(readFileSync(log, 'utf8')).toMatch(/ error RangeError\n$/); // already written when it exits
        codes.push(code);
      });
      onCrash(new RangeError('secret 123'));
      expect(codes).toEqual([1]);
      expect(readFileSync(log, 'utf8')).not.toContain('secret');
      crashExit(join(dir, 'no', 'such', 'dir.log'), (code) => codes.push(code))(new Error('x')); // log unwritable
      expect(codes).toEqual([1, 1]);
    } finally {
      done();
    }
  });
});

describe('http core', () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await makeServer();
  });
  afterEach(() => s.close());

  it('bad requests', async () => {
    // jsonBody on a stand-in route (the ticket routes come in Task 6), with the app's error mapping
    const app = express();
    app.post('/api/tickets', jsonBody, (req, res) => {
      res.json(req.body);
    });
    app.use(errorHandler(s.config));
    const server = await listen(app, { host: '127.0.0.1', port: 0 });
    const b = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: Buffer | string, ctype = 'application/json') =>
      send(b, 'POST', '/api/tickets', Buffer.from(body as string), { 'Content-Type': ctype });
    try {
      expect((await post('{not json')).status).toBe(400);
      expect(await post('[1, 2]')).toMatchObject({ status: 400, body: { error: 'expected a JSON object' } });
      expect((await post(Buffer.from([0xff, 0xfe]))).status).toBe(400);
      // too deep for Python's json (RecursionError when it reads the row back): refused before parsing
      const deep = { status: 400, body: { error: 'JSON nested too deep' } };
      const chain = (n: number): string => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
      expect(await post('['.repeat(100_000))).toMatchObject(deep);
      expect(await post(chain(65))).toMatchObject(deep);
      expect(await post(chain(100_000))).toMatchObject(deep);
      expect(await post(`{"lines": ${'['.repeat(100)}${']'.repeat(100)}}`)).toMatchObject(deep); // deep in a field
      expect(await post(chain(64))).toMatchObject({ status: 200 }); // 64 levels: fine
      const brackets = `{"notes": "${'{['.repeat(5000)}\\"${'[{'.repeat(5000)}"}`; // inside a string: not nesting
      expect(await post(brackets)).toMatchObject({ status: 200, body: JSON.parse(brackets) });
      expect((await post('null')).status).toBe(400);
      for (const ctype of ['text/plain', 'application/x-www-form-urlencoded']) {
        expect(await post(JSON.stringify(CAR), ctype)).toMatchObject({
          status: 400,
          body: { error: 'send JSON (Content-Type: application/json)' },
        });
      }
      expect(await post(JSON.stringify(CAR), 'application/json; charset=utf-8')).toMatchObject({ status: 200, body: CAR });
      expect(await post('')).toMatchObject({ status: 200, body: {} }); // as Python: no body is {}
      const big = await post(JSON.stringify({ x: 'a'.repeat(1024 * 1024) }));
      expect(big).toMatchObject({ status: 400, body: { error: 'Request too big.' } });
    } finally {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
    }

    const c = await s.admin();
    expect((await s.call('/api/me', undefined, 'sid="\\x; bad')).status).toBe(401); // a mangled cookie: no session
    for (const path of ['/api/tickets', '/login/admin']) {
      // says 2 MB: refused before reading it, at once
      const start = Date.now();
      const got = await raw(
        s.base,
        `POST ${path} HTTP/1.1\r\nHost: x\r\nCookie: ${c}\r\nContent-Type: application/json\r\n` +
          `Content-Length: ${2 * 1024 * 1024}\r\n\r\n`,
      );
      expect(got).toMatch(/^HTTP\/1\.1 400 /);
      expect(got).toContain('{"error":"Request too big."}');
      expect(Date.now() - start).toBeLessThan(5000);
    }
  });

  it('stalled body: the request ends with no reply, the server keeps serving', async () => {
    await s.close();
    s = await makeServer({ stallMs: 1000 });
    const c = await s.admin();
    const start = Date.now();
    // the form route reads its body (Task 6's JSON routes share readBody); 100 bytes promised, 8 sent
    const got = await raw(
      s.base,
      `POST /login/admin HTTP/1.1\r\nHost: x\r\nCookie: ${c}\r\nContent-Type: application/json\r\n` +
        `Content-Length: 100\r\n\r\n{"first"`,
    );
    expect(got).toBe(''); // no reply at all
    expect(Date.now() - start).toBeLessThan(5000);
    expect((await s.call('/api/me', undefined, c)).status).toBe(200); // still serving
    expect(s.log()).toContain('POST /login/admin dropped');
  });

  it('security headers', async () => {
    for (const p of ['/', '/admin', '/tech']) {
      const { headers: h } = await s.call(p);
      expect([h['x-content-type-options'], h['referrer-policy'], h['cache-control']]).toEqual([
        'nosniff',
        'same-origin',
        'no-store',
      ]);
      expect(h['content-security-policy']).toBe(
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
          "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(h['x-powered-by']).toBeUndefined();
      expect(h['content-type']).toBe('text/html; charset=utf-8');
    }
    for (const p of ['/api/tickets', '/checkin', '/nowhere']) {
      const { headers: h } = await s.call(p);
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['cache-control']).toBe('no-store');
      expect(h['content-security-policy']).toBeUndefined();
      expect(h['x-powered-by']).toBeUndefined();
    }
  });

  it('a server error says nothing; the log gets the class name only', async () => {
    const c = await s.admin();
    const real = s.accounts.session.bind(s.accounts);
    const dbLocked = Object.assign(new Error('database is locked C:\\secret\\tickets.db'), { code: 'ERR_SQLITE_ERROR' });
    const cases: Array<[unknown, string]> = [
      [new Error('C:\\secret\\path tickets.db locked'), 'Error'],
      [dbLocked, 'Error'],
      [new SyntaxError('Unexpected token secret in JSON'), 'SyntaxError'],
      [new RangeError('secret stack'), 'RangeError'],
      [new TypeError('secret of undefined'), 'TypeError'],
      ['a secret string', 'string'],
    ];
    for (const [boom, name] of cases) {
      s.accounts.session = () => {
        throw boom;
      };
      expect(await s.call('/api/me', undefined, c)).toMatchObject({ status: 500, body: { error: 'server error' } });
      expect(s.log()).toContain(`GET /api/me error ${name}`);
    }
    s.accounts.session = real;
    // an async route rejecting: Express 5 forwards it
    s.accounts.login = () => Promise.reject(new TypeError('secret'));
    expect(await s.call('/login/admin', { name: ADMIN, secret: PASSWORD })).toMatchObject({
      status: 500,
      body: { error: 'server error' },
    });
    expect(s.log()).toContain('GET /api/me 500');
    expect(s.log()).toContain('POST /login/admin 500');
    expect(s.log()).not.toMatch(/secret/i);
  });

  it('maps the known errors', async () => {
    const app = express();
    const errors: Record<string, unknown> = {
      invalid: new Invalid({ first: 'first name is required' }),
      bad: new BadInput('version must be a whole number'),
      login: new LoginFailed('wrong name or PIN'),
      locked: new Locked(42),
      missing: new NotFound('no ticket 7 at C:\\secret'),
      refused: new Refused('only the desk can do that'),
    };
    app.get('/:what', (req) => {
      throw errors[req.params['what'] as string];
    });
    app.use(errorHandler(s.config));
    const server = await listen(app, { host: '127.0.0.1', port: 0 });
    const b = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await send(b, 'GET', '/invalid')).toMatchObject({
        status: 400,
        body: { error: 'first: first name is required', errors: { first: 'first name is required' } },
      });
      expect(await send(b, 'GET', '/bad')).toMatchObject({ status: 400, body: { error: 'version must be a whole number' } });
      expect(await send(b, 'GET', '/login')).toMatchObject({ status: 401, body: { error: 'wrong name or PIN' } });
      const locked = await send(b, 'GET', '/locked');
      expect([locked.status, locked.headers['retry-after']]).toEqual([429, '42']);
      expect(await send(b, 'GET', '/missing')).toMatchObject({ status: 404, body: { error: 'not found' } });
      expect(await send(b, 'GET', '/refused')).toMatchObject({ status: 409, body: { error: 'only the desk can do that' } });
    } finally {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
    }
  });

  it('cross-site posts are refused', async () => {
    const host = s.base.slice(7);
    const form = { name: ADMIN, secret: PASSWORD };
    for (const h of [
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
      { Origin: `http://${host}.evil.example` },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { Origin: `http://${host}`, 'Sec-Fetch-Site': 'cross-site' },
    ] as Array<Record<string, string>>) {
      const r = await s.call('/login/admin', form, undefined, h);
      expect(r.status).toBe(403);
      expect(r.headers['set-cookie']).toBeUndefined();
      expect((await s.call('/login/tech', { name: 'Al Fixit', secret: PINS['Al Fixit'] }, undefined, h)).status).toBe(403);
      const a = await s.admin();
      expect((await s.call('/logout', '', a, h)).status).toBe(403);
      expect((await s.call('/api/me', undefined, a)).status).toBe(200);
      expect((await s.call('/api/tickets', CAR, a, h)).status).toBe(403);
      expect((await s.call('/setup', { code: 'x' }, undefined, h)).status).toBe(403);
    }
    for (const h of [
      { Origin: `http://${host}` },
      { Origin: `https://${host}` },
      { 'Sec-Fetch-Site': 'same-origin' },
      { 'Sec-Fetch-Site': 'none' },
      { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }, // Chrome's own forms
    ] as Array<Record<string, string>>) {
      expect((await s.call('/login/admin', form, undefined, h)).status).toBe(303);
    }
  });

  it('the client is CF-Connecting-IP only from loopback', async () => {
    const req = (peer: string | undefined, headers: Record<string, string> = {}) => ({
      headers,
      socket: { remoteAddress: peer },
    });
    const cf = { 'cf-connecting-ip': '203.0.113.9' };
    expect(clientIp(req('192.168.1.20', cf))).toBe('192.168.1.20');
    expect(clientIp(req('127.0.0.1', cf))).toBe('203.0.113.9');
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(clientIp(req('::1', cf))).toBe('203.0.113.9');
    expect(clientIp(req('::ffff:127.0.0.1', cf))).toBe('203.0.113.9');
    expect(clientIp(req('::ffff:192.168.1.20', cf))).toBe('::ffff:192.168.1.20');
    expect(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '  ' }))).toBe('127.0.0.1');
    expect(clientIp(req(undefined, cf))).toBe('');
    // X-Forwarded-For never counts
    expect(clientIp(req('192.168.1.20', { 'x-forwarded-for': '203.0.113.1' }))).toBe('192.168.1.20');
  });

  it('one log line per request: path without the query, the caller, seconds', async () => {
    const m = await s.tech('Al Fixit');
    await s.call('/api/me?secret=x', undefined, m);
    const line = s.log().trim().split('\n').pop();
    expect(line).toMatch(
      new RegExp(`^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d GET /api/me 200 mechanic#${s.ids['Al Fixit']} \\d+\\.\\ds$`),
    );
    expect(s.log()).toMatch(/ POST \/login\/tech 303 \d+\.\ds\n/);
    expect(s.log()).not.toContain('secret');
  });
});

describe('config', () => {
  it('SHOP_ROOT and SHOP_PORT; host is this PC only', () => {
    const c = loadConfig({ SHOP_ROOT: 'C:\\shop', SHOP_PORT: '9090' });
    expect(c).toEqual({
      host: '127.0.0.1',
      port: 9090,
      root: 'C:\\shop',
      db: join('C:\\shop', 'tickets.db'),
      catalog: join('C:\\shop', 'parts.csv'),
      vehicles: join('C:\\shop', 'vehicles.json'),
      web: join('C:\\shop', 'web'),
      setup: join('C:\\shop', 'setup_code.txt'),
      log: join('C:\\shop', 'shop.log'),
      invomaxDir: String.raw`C:\hunni\files`,
      importInvomax: true,
      invomaxDb: join('C:\\shop', 'invomax.db'),
      importDir: join('C:\\shop', 'invomax-import'),
      backups: join('C:\\shop', 'backups'),
      backupTargets: [],
      app: join('C:\\shop', 'shop-web', 'apps', 'admin-app', 'dist'),
    });
    expect(loadConfig({}).port).toBe(8081);
    expect(readFileSync(join(loadConfig({}).root, 'shop.py'), 'utf8')).toContain('HOST, PORT');
    for (const bad of ['x', '-1', '65536', '80.5']) expect(() => loadConfig({ SHOP_PORT: bad })).toThrow();
  });
});
