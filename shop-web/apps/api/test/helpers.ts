// A real server on a free port over a temp SHOP_ROOT, and a client like tests/test_shop.py's call().
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Accounts } from '../src/accounts';
import { createApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { openDb } from '../src/db';
import type { History } from '../src/history/bills';
import type { LinkStore } from '../src/history/links';
import type { Deps } from '../src/http/deps';
import { type Nightly, type NightlyOpts, startNightly } from '../src/nightly';
import { listen, openHistory } from '../src/server';
import { TicketStore } from '../src/store';
import { REPO_ROOT, tempDir } from './py';

export const ADMIN = 'Owner Test';
export const PASSWORD = 'made-up-pass-1';
export const PINS: Record<string, string> = { 'Al Fixit': '246810', 'Bo Wrench': '135790' };
export const CAR = {
  first: 'Jane',
  last: 'Testcase',
  phone: '555 010 0000',
  year: '2019',
  make: 'Cadillac',
  model: 'XT5',
  plate: 'tst-0001',
  request: 'brakes squeak',
};

export type Reply = {
  status: number;
  /** Parsed JSON, else the body as text. */
  body: unknown;
  text: string;
  headers: IncomingHttpHeaders;
};

/** One request on its own connection (Connection: close, as urllib). */
export function send(
  base: string,
  method: string,
  path: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request(base + path, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // not JSON: the text
        }
        ok({ status: res.statusCode ?? 0, body: parsed, text, headers: res.headers });
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(body);
  });
}

/** The sid cookie a reply set, as a Cookie header value. */
export function sid(r: Reply): string {
  const c = r.headers['set-cookie']?.[0];
  if (!c) throw new Error(`no Set-Cookie (status ${r.status})`);
  return c.split(';')[0] as string;
}

export type TestServer = {
  base: string;
  config: Config;
  db: DatabaseSync;
  store: TicketStore;
  accounts: Accounts;
  server: Server;
  /** invomax.db (read-write: tests put bills straight in), the links, Bill history and the nightly run. */
  im: DatabaseSync;
  links: LinkStore;
  history: History;
  nightly: Nightly;
  deps: Deps;
  /** The nightly run's checks (none at start): call one to tick it. */
  ticks: Array<() => void>;
  /** Lets every import retry sleep (and later ones) end: until then an import that retries waits. */
  openSleep(): void;
  ids: Record<string, number>;
  /** GET without data; POST with it. Objects go as JSON to /api/ paths, as a form elsewhere. */
  call(path: string, data?: unknown, cookie?: string, headers?: Record<string, string>): Promise<Reply>;
  signIn(role: 'admin' | 'mechanic', name: string, secret: string): Promise<string>;
  admin(password?: string): Promise<string>;
  tech(name: string): Promise<string>;
  log(): string;
  close(): Promise<void>;
};

/**
 * Temp SHOP_ROOT holding a copy of web/, parts.csv and vehicles.json, a fresh DB, the admin and two mechanics,
 * and an empty temp InvoMax folder (never the real one). The nightly run checks only when a test ticks it.
 */
export async function makeServer(opts: { admin?: boolean; stallMs?: number; nightly?: NightlyOpts } = {}): Promise<TestServer> {
  const { dir, done } = tempDir();
  cpSync(join(REPO_ROOT, 'web'), join(dir, 'web'), { recursive: true });
  for (const f of ['parts.csv', 'vehicles.json']) copyFileSync(join(REPO_ROOT, f), join(dir, f));
  mkdirSync(join(dir, 'InvoMax'));
  const config = loadConfig({ SHOP_ROOT: dir, SHOP_PORT: '0', INVOMAX_DIR: join(dir, 'InvoMax') });
  const db = openDb(config.db);
  const store = new TicketStore(db);
  const accounts = new Accounts(db, { iterations: 1000 }); // fast hashes
  const ids: Record<string, number> = {};
  if (opts.admin !== false) ids[ADMIN] = (await accounts.add(ADMIN, 'admin', PASSWORD)).id;
  for (const [name, pin] of Object.entries(PINS)) ids[name] = (await accounts.add(name, 'mechanic', pin)).id;
  const parts = openHistory(config, db);
  const ticks: Array<() => void> = [];
  let open!: () => void;
  const gate = new Promise<void>((ok) => (open = ok));
  const nightly = startNightly(
    { config, links: parts.links, im: parts.im, jobs: parts.jobs },
    {
      atStart: false,
      schedule: (f) => {
        ticks.push(f);
        return { stop: () => void ticks.splice(0) };
      },
      sleep: () => gate,
      ...opts.nightly,
    },
  );
  const deps: Deps = {
    store,
    accounts,
    config,
    links: parts.links,
    history: parts.history,
    jobs: parts.jobs,
    nightly,
    ownBills: parts.ownBills,
  };
  const server = await listen(createApp(deps), config, { stallMs: opts.stallMs });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call: TestServer['call'] = (path, data, cookie, headers = {}) => {
    const api = path.startsWith('/api/');
    const h: Record<string, string> = cookie ? { Cookie: cookie } : {};
    let body: Buffer | undefined;
    if (data !== undefined) {
      if (Buffer.isBuffer(data)) body = data;
      else if (typeof data === 'string') body = Buffer.from(data);
      else if (api) body = Buffer.from(JSON.stringify(data));
      else body = Buffer.from(new URLSearchParams(data as Record<string, string>).toString());
      h['Content-Type'] = api ? 'application/json' : 'application/x-www-form-urlencoded';
    }
    return send(base, data === undefined ? 'GET' : 'POST', path, body, { ...h, ...headers });
  };
  const signIn: TestServer['signIn'] = async (role, name, secret) => {
    const r = await call(role === 'admin' ? '/login/admin' : '/login/tech', { name, secret });
    const home = role === 'admin' ? '/admin' : '/tech';
    if (r.status !== 303 || r.headers.location !== home) throw new Error(`sign-in failed: ${r.status}`);
    return sid(r);
  };
  return {
    base,
    config,
    db,
    store,
    accounts,
    server,
    im: parts.im,
    links: parts.links,
    history: parts.history,
    nightly,
    deps,
    ticks,
    openSleep: () => open(),
    ids,
    call,
    signIn,
    admin: (password = PASSWORD) => signIn('admin', ADMIN, password),
    tech: (name) => signIn('mechanic', name, PINS[name] as string),
    log: () => (existsSync(config.log) ? readFileSync(config.log, 'utf8') : ''),
    close: async () => {
      nightly.stop();
      open(); // an import waiting on a retry sleep ends
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      await nightly.settled();
      parts.close();
      db.close();
      done();
    },
  };
}

/** The sign-in / setup page's error line. */
export function errLine(r: Reply): [number, string] {
  const m = /class="err">(.*?)</.exec(r.text);
  return [r.status, m ? (m[1] as string) : ''];
}
