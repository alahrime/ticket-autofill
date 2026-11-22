// Starts the built shop server (apps/api/dist/main.js) on a fresh temp SHOP_ROOT: a copy of web/, parts.csv and
// vehicles.json, the admin app built into the temp root (shop-web/apps/admin-app/dist there, where config.app
// looks), a new tickets.db, the admin made with the server's own `admin <name>` command, two mechanics added
// through the API, and Bill history's made-up data (two InvoMax bills and two filled XKS-4827 tickets, one linked).
// Never the real tickets.db; never start-shop.bat. Returns the teardown.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { btrieveFile, detailBytes, invoiceBytes } from '@shop/invomax/testing';
import { ADMIN, BASE, PASSWORD, PINS, PORT } from './shop';

export const REPO = resolve(__dirname, '../../../..'); // the folder holding shop.py and web/
export const MAIN = resolve(__dirname, '../../api/dist/main.js');
const SHOP_WEB = resolve(__dirname, '../../..');
const VITE = join(SHOP_WEB, 'node_modules', 'vite', 'bin', 'vite.js');

/** Local YYYY-MM-DD, `days` from today. */
function day(days = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** apps/admin-app built straight into the temp root (the repo's own dist/ is left alone). */
function buildAdminApp(root: string): void {
  const out = join(root, 'shop-web', 'apps', 'admin-app', 'dist');
  const r = spawnSync(process.execPath, [VITE, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: join(SHOP_WEB, 'apps', 'admin-app'),
    encoding: 'utf8',
  });
  if (r.status !== 0 || !existsSync(join(out, 'index.html'))) throw new Error(`admin-app build failed: ${r.stdout} ${r.stderr}`);
}

type Api = (path: string, body?: unknown) => Promise<unknown>;

/** Until the import the server ran at start is done (so no later import auto-links what we seed next). */
async function importDone(api: Api): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const s = (await api('/api/upkeep/status')) as { import: { running: boolean; last: { ok: boolean } | null } };
    if (!s.import.running && s.import.last) {
      if (!s.import.last.ok) throw new Error('the InvoMax import of the made-up tables failed');
      return;
    }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error('the InvoMax import at start did not finish');
}

/** A filled ticket for Jane Testcase's XKS-4827 (BRAKE PADS: $100 parts, $50 labor) -> its id. */
async function filledTicket(api: Api, request: string): Promise<number> {
  let t = (await api('/api/tickets', {
    first: 'Jane',
    last: 'Testcase',
    phone: '(555)010-0000',
    year: '2019',
    make: 'Cadillac',
    model: 'XT5',
    plate: 'XKS-4827',
    request,
    mechanic: 'Al Fixit',
    lines: [{ desc: 'BRAKE PADS', qty: 1, price: 100, labor: 50 }],
  })) as { id: number; version: number };
  for (const to of ['approved', 'filled'])
    t = (await api(`/api/tickets/${t.id}/move`, { version: t.version, to })) as { id: number; version: number };
  return t.id;
}

/**
 * Until the server we spawned is the one answering: it printed its own "Serving on" (only after its listen
 * succeeded) and is still running. Something else already on the port makes ours exit: that fails here.
 */
async function waitUp(server: ChildProcess, output: () => string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`the shop server stopped (port ${PORT} in use?): ${output()}`);
    if (output().includes('Serving on')) {
      try {
        if ((await fetch(BASE + '/')).ok && server.exitCode === null) return;
      } catch {
        // not answering yet
      }
    }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error(`the shop server didn't start on ${BASE}: ${output()}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npx nx run api:build`);
  const root = mkdtempSync(join(tmpdir(), 'shop-pages-e2e-'));
  try {
    buildAdminApp(root);
  } catch (e) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    throw e;
  }
  cpSync(join(REPO, 'web'), join(root, 'web'), { recursive: true });
  for (const f of ['parts.csv', 'vehicles.json']) copyFileSync(join(REPO, f), join(root, f));
  // InvoMax's tables: made-up ones in a temp folder (never C:\hunni), so Check InvoMax now reads nothing real.
  const invomax = join(root, 'fake-invomax');
  mkdirSync(invomax);
  writeFileSync(
    join(invomax, 'INVOICE.btv'),
    btrieveFile({
      pageSize: 1536,
      recordLength: 498,
      records: [
        invoiceBytes({ invoice_no: '9000001', date: '2026-11-20', last: 'DOE', first: 'JANE', phone: '(555)010-0000', plate: 'XKS-4827', parts: 12000, labor: 9000, total: 21000 }),
        // two days before the tickets are filled: a needs-bill candidate (14 days), never auto-linked (1 day)
        invoiceBytes({ invoice_no: '9000002', date: day(-2), last: 'DOE', first: 'JANE', phone: '(555)010-0000', plate: 'XKS-4827', parts: 10000, labor: 5000, total: 15000 }),
      ],
    }),
  );
  writeFileSync(
    join(invomax, 'DETAIL.btv'),
    btrieveFile({
      pageSize: 1024,
      recordLength: 265,
      records: [
        detailBytes({ invoice_no: '9000001', code: 'LABOR', description: 'REPLACE FRONT PADS', kind: 'labor', qty: 1, unit: 9000, date: '2026-11-20' }),
        detailBytes({ invoice_no: '9000002', code: 'PADS', description: 'BRAKE PAD SET', kind: 'part', qty: 1, unit: 10000, date: day(-2) }),
      ],
    }),
  );
  // The USB target: a folder in the temp root, never a real drive; the backups stay in <root>/backups.
  writeFileSync(join(root, 'shop-settings.json'), JSON.stringify({ backupTargets: [join(root, 'usb-stick')] }));
  const env = { ...process.env, SHOP_ROOT: root, SHOP_PORT: String(PORT), INVOMAX_DIR: invomax };

  const made = spawnSync(process.execPath, [MAIN, 'admin', ADMIN], {
    env,
    input: `${PASSWORD}\n${PASSWORD}\n`,
    encoding: 'utf8',
  });
  if (made.status !== 0) throw new Error(`admin command failed: ${made.stdout} ${made.stderr}`);

  const server = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (c: Buffer) => (output += c.toString()));
  server.stderr.on('data', (c: Buffer) => (output += c.toString()));
  const exited = new Promise<void>((ok) => server.once('exit', () => ok()));
  try {
    await waitUp(server, () => output);
    // the mechanics, through the admin's own API
    const login = await fetch(BASE + '/login/admin', {
      method: 'POST',
      body: new URLSearchParams({ name: ADMIN, secret: PASSWORD }),
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    if (login.status !== 303 || !cookie) throw new Error(`admin sign-in failed: ${login.status}`);
    for (const [name, secret] of Object.entries(PINS)) {
      const r = await fetch(BASE + '/api/users', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role: 'mechanic', secret }),
      });
      if (!r.ok) throw new Error(`adding ${name} failed: ${r.status} ${await r.text()}`);
    }
    const api: Api = async (path, body) => {
      const r = await fetch(BASE + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return r.json();
    };
    // Bill history: one XKS-4827 ticket linked to bill 9000001, one waiting for its bill (9000002 its candidate)
    await importDone(api);
    const linked = await filledTicket(api, 'brakes squeak (linked)');
    await api(`/api/invoices/t${linked}/link`, { invoice_no: '9000001', version: null });
    await filledTicket(api, 'brakes squeak (needs its bill)');
  } catch (e) {
    server.kill();
    await exited;
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    throw e;
  }

  return async () => {
    server.kill();
    await exited;
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  };
}
