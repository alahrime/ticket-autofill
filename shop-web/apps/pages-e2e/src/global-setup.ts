// Starts the built shop server (apps/api/dist/main.js) on a fresh temp SHOP_ROOT: a copy of web/, parts.csv and
// vehicles.json, a new tickets.db, the admin made with the server's own `admin <name>` command and two mechanics
// added through the API. Never the real tickets.db; never start-shop.bat. Returns the teardown.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ADMIN, BASE, PASSWORD, PINS, PORT } from './shop';

export const REPO = resolve(__dirname, '../../../..'); // the folder holding shop.py and web/
export const MAIN = resolve(__dirname, '../../api/dist/main.js');

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
  cpSync(join(REPO, 'web'), join(root, 'web'), { recursive: true });
  for (const f of ['parts.csv', 'vehicles.json']) copyFileSync(join(REPO, f), join(root, f));
  const env = { ...process.env, SHOP_ROOT: root, SHOP_PORT: String(PORT) };

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
