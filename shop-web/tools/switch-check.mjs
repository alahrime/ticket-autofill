// Before switching start-shop.bat to the TypeScript server: prints `ready` only when every check passes.
//   cd shop-web && node tools/switch-check.mjs
// 1. builds the api (apps/api/dist/main.js) and the admin app (apps/admin-app/dist);  2. nx run-many -t test;  3. the parity guard;
// 4. every tests/test_*.py prints ok;  5. the built main.js, started on a throwaway root and a spare port
// (never 8081, never the real tickets.db), answers GET / with 200, loads openapi.yaml and serves a copy of the
// built admin app (/bills 303 to /admin when signed out, /app/assets/*.js as JavaScript);
// 6. a second server on that port fails while the first listens (TypeScript: exit 3, or Python's OnlyServer);
// 7. with no SHOP_ROOT, the bundle in its real place finds the repo root (shop.py) by itself.
// It never stops or starts the live shop server. (The Playwright page tests are separate: npx nx e2e pages-e2e.)
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE_PORT = 8081;
const PORT_IN_USE = 3; // main.js's exit code when another copy has the port (run-shop.cmd then stops)
const here = dirname(fileURLToPath(import.meta.url));
const shopWeb = join(here, '..');
const repo = join(shopWeb, '..'); // the folder holding shop.py
const main = join(shopWeb, 'apps', 'api', 'dist', 'main.js');
const appDist = join(shopWeb, 'apps', 'admin-app', 'dist');
const nx = join(shopWeb, 'node_modules', 'nx', 'dist', 'bin', 'nx.js');

const failed = [];
const pass = (what) => console.log(`  ok    ${what}`);
const fail = (what, detail = '') => {
  failed.push(what);
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail.trim().split('\n').slice(-15).join('\n        ')}` : ''}`);
};
const step = (title) => console.log(`\n${title}`);

/** Runs a command to the end with its output on this console -> true when it exits 0. */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  return r.status === 0;
}

const inside = (child, parent) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/** A port nobody listens on right now, never the live one. */
function sparePort() {
  return new Promise((ok, no) => {
    const s = createServer();
    s.once('error', no);
    s.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = s.address();
      s.close(() => (port === LIVE_PORT ? sparePort().then(ok, no) : ok(port)));
    });
  });
}

/** A throwaway SHOP_ROOT with copies of web/, parts.csv and vehicles.json; tickets.db starts empty there. */
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'shop-switch-check-'));
  if (inside(root, repo) || inside(repo, root)) throw new Error(`temp root ${root} overlaps the repo`);
  cpSync(join(repo, 'web'), join(root, 'web'), { recursive: true });
  for (const f of ['parts.csv', 'vehicles.json']) copyFileSync(join(repo, f), join(root, f));
  cpSync(appDist, join(root, 'shop-web', 'apps', 'admin-app', 'dist'), { recursive: true }); // where config.app looks
  return root;
}

/** Starts the built server on root/port; `output()` is what it printed so far, `exited` its exit code. */
function startServer(root, port) {
  if (port === LIVE_PORT) throw new Error('never the live port');
  const child = spawn(process.execPath, [main], {
    cwd: root,
    env: { ...process.env, SHOP_ROOT: root, SHOP_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (c) => (text += c));
  child.stderr.on('data', (c) => (text += c));
  const exited = new Promise((ok) => {
    child.once('exit', (code) => ok(code));
    child.once('error', (e) => {
      text += String(e?.message ?? e);
      ok('failed to start');
    });
  });
  return { child, exited, output: () => text };
}

/** Stops a server we started (our own child, on a spare port) and waits until it is gone. */
async function stop(server) {
  if (server.child.exitCode === null && server.child.pid !== undefined) server.child.kill();
  await server.exited;
}

/** Until the server we started answers GET / (it printed "Serving on" and is still running) -> the reply. */
async function waitUp(server, port) {
  for (let i = 0; i < 150; i++) {
    if (server.child.exitCode !== null) throw new Error(`it stopped: ${server.output()}`);
    if (server.output().includes('Serving on')) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`);
        if (server.child.exitCode === null) return r;
      } catch {
        // not answering yet
      }
    }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error(`no answer on port ${port}: ${server.output()}`);
}

/** Resolves with the exit code, or 'running' if it is still up after ms. */
const exitWithin = (server, ms) =>
  Promise.race([server.exited, new Promise((ok) => setTimeout(() => ok('running'), ms))]);

/** A server started on a taken port: true when it exits 3 with the "already running" line, else the reason. */
async function refused(server) {
  const code = await exitWithin(server, 15_000);
  await stop(server);
  return code === PORT_IN_USE && server.output().includes('already running on this port')
    ? true
    : `exit ${code}: ${server.output()}`;
}

/**
 * A Python process that binds port the way shop.py does (pinweb.OnlyServer) or, with plain, the way a default
 * socketserver does (SO_REUSEADDR). `said` is `bound` or `in use` (or what went wrong, after 15 s at most);
 * it then holds the port until release() closes its stdin.
 */
function pythonBind(port, plain) {
  const code = [
    'import socket, sys',
    `sys.path.insert(0, ${JSON.stringify(repo)})`,
    'from http.server import BaseHTTPRequestHandler, HTTPServer',
    'from pinweb import OnlyServer',
    'class Plain(HTTPServer): allow_reuse_address = True',
    `cls = ${plain ? 'Plain' : 'OnlyServer'}`,
    'try:',
    `    s = cls(("127.0.0.1", ${port}), BaseHTTPRequestHandler)`,
    'except OSError:',
    '    print("in use", flush=True); sys.exit(0)',
    'print("bound", flush=True)',
    'sys.stdin.read()',
    's.server_close()',
  ].join('\n');
  const child = spawn('python', ['-c', code], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // it may have exited already (in use)
  let text = '';
  child.stdout.on('data', (c) => (text += c));
  child.stderr.on('data', (c) => (text += c));
  let gone = false;
  const exited = new Promise((ok) => {
    const done = () => {
      gone = true;
      ok();
    };
    child.once('exit', done);
    child.once('error', (e) => {
      text += `python didn't start: ${e?.message ?? e}`;
      done();
    });
  });
  const said = new Promise((ok) => {
    const until = Date.now() + 15_000;
    const look = () => {
      if (/bound|in use/.test(text) || gone) ok(text.trim());
      else if (Date.now() > until) ok(`no answer from python: ${text.trim()}`);
      else setTimeout(look, 50);
    };
    look();
  });
  const release = async () => {
    child.stdin.end();
    if (!gone && /^no answer/.test(await said)) child.kill(); // our own child, stuck
    await exited;
  };
  return { said, release };
}

/** Steps 5 and 6 on one throwaway root, removed afterwards whatever happened. */
async function bundleChecks() {
  const root = tempRoot();
  try {
    await serverChecks(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function serverChecks(root) {
  const port = await sparePort();
  console.log(`  (throwaway root ${root}, port ${port})`);
  const first = startServer(root, port);
  try {
    const home = await waitUp(first, port);
    if (home.status === 200) pass(`GET / answers 200 on the spare port`);
    else fail('GET / answers 200', `got ${home.status}`);

    const me = await fetch(`http://127.0.0.1:${port}/api/me`);
    if (me.status === 401) pass('GET /api/me answers 401 (openapi.yaml loaded from the bundle)');
    else fail('GET /api/me answers 401', `got ${me.status}`);

    const bills = await fetch(`http://127.0.0.1:${port}/bills`, { redirect: 'manual' });
    const js = readdirSync(join(root, 'shop-web', 'apps', 'admin-app', 'dist', 'assets')).find((f) => f.endsWith('.js'));
    const asset = js ? await fetch(`http://127.0.0.1:${port}/app/assets/${js}`) : null;
    if (bills.status === 303 && bills.headers.get('location') === '/admin' && asset?.status === 200 &&
        (asset.headers.get('content-type') ?? '').startsWith('text/javascript'))
      pass('the admin app: /bills sends a signed-out caller to /admin, /app/assets serves its JavaScript');
    else fail('the admin app is served', `/bills ${bills.status}, /app/assets/${js} ${asset?.status}`);

    const logFile = join(root, 'shop.log');
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    if (existsSync(join(root, 'tickets.db')) && existsSync(join(root, 'setup_code.txt')) && log.includes(` started 127.0.0.1:${port}\n`))
      pass('it used the throwaway root: tickets.db, a setup code and a "started" line in its shop.log');
    else fail('it used the throwaway root', `${readdirSync(root).join(', ')} / ${log}`);

    step('6. One server per port');
    const second = await refused(startServer(root, port));
    if (second === true)
      pass(`a second TypeScript server on the same port exits ${PORT_IN_USE}: "The shop server is already running on this port."`);
    else fail(`a second TypeScript server on the same port exits ${PORT_IN_USE}`, second);

    const only = pythonBind(port, false);
    const onlySaid = await only.said;
    await only.release();
    if (onlySaid === 'in use') pass("Python's OnlyServer (shop.py) can't bind while the TypeScript server listens");
    else fail("Python's OnlyServer can't bind while the TypeScript server listens", onlySaid);

    const plain = pythonBind(port, true);
    const plainSaid = await plain.said;
    await plain.release();
    if (plainSaid === 'in use') pass("even a plain Python server with SO_REUSEADDR can't bind there (note only)");
    else console.log(`  note  a plain Python server with SO_REUSEADDR said "${plainSaid}" on that port (shop.py doesn't use it)`);

    if ((await fetch(`http://127.0.0.1:${port}/`)).status === 200 && first.child.exitCode === null)
      pass('the first server still answers');
    else fail('the first server still answers');
  } catch (e) {
    fail('the built main.js starts on a throwaway root', String(e?.message ?? e));
  } finally {
    await stop(first);
  }

  // the other way round: Python's OnlyServer first, then the TypeScript server
  const port2 = await sparePort();
  const py = pythonBind(port2, false);
  try {
    const pySaid = await py.said;
    if (pySaid !== 'bound') fail("Python's OnlyServer binds a spare port", pySaid);
    else {
      const ts = await refused(startServer(root, port2));
      if (ts === true) pass(`the TypeScript server exits ${PORT_IN_USE} while Python's OnlyServer holds the port`);
      else fail(`the TypeScript server exits ${PORT_IN_USE} while Python holds the port`, ts);
    }
  } finally {
    await py.release();
  }
}

/** The bundle in its real place, with no SHOP_ROOT: loadConfig walks up to the repo's shop.py. */
function walkUpCheck() {
  // only the repo root holds shop.py between dist/ and the drive root's first match
  const between = [join(shopWeb, 'apps', 'api', 'dist'), join(shopWeb, 'apps', 'api'), join(shopWeb, 'apps'), shopWeb];
  const stray = between.filter((d) => existsSync(join(d, 'shop.py')));
  if (stray.length || !existsSync(join(repo, 'shop.py'))) return fail('shop.py sits only in the repo root', stray.join(', '));
  const env = { ...process.env };
  delete env['SHOP_ROOT'];
  delete env['SHOP_PORT'];
  // a usage-only call: loadConfig() runs, then the usage line; no file is opened or written
  const r = spawnSync(process.execPath, [main, 'usage-only'], { cwd: tmpdir(), env, encoding: 'utf8' });
  if (r.status === 1 && r.stdout.includes('usage: node shop-web/apps/api/dist/main.js') && !/shop\.py not found/.test(r.stderr))
    pass('with no SHOP_ROOT the bundle finds the repo root (shop.py) from shop-web/apps/api/dist');
  else fail('the bundle finds the repo root by itself', `exit ${r.status}: ${r.stdout}${r.stderr}`);
}

async function checks() {
  step('1. Build the api and the admin app');
  if (!run(process.execPath, [nx, 'build', 'api'], shopWeb) || !existsSync(main))
    return fail('npx nx build api', `${main} missing`);
  pass(`built ${relative(repo, main)}`);
  if (!run(process.execPath, [nx, 'build', 'admin-app'], shopWeb) || !existsSync(join(appDist, 'index.html')))
    return fail('npx nx build admin-app', `${join(appDist, 'index.html')} missing`);
  pass(`built ${relative(repo, appDist)}`);

  step('2. nx run-many -t test');
  if (run(process.execPath, [nx, 'run-many', '-t', 'test'], shopWeb)) pass('nx run-many -t test');
  else fail('nx run-many -t test');

  step('3. Parity guard');
  if (run(process.execPath, [join(here, 'parity-guard.mjs')], shopWeb)) pass('parity guard');
  else fail('parity guard');

  step('4. Python tests');
  const tests = readdirSync(join(repo, 'tests')).filter((f) => /^test_.*\.py$/.test(f)).sort();
  for (const f of tests) {
    const r = spawnSync('python', [join('tests', f)], { cwd: repo, encoding: 'utf8' });
    if (r.status === 0 && /^ok$/m.test(r.stdout)) pass(`python tests/${f}`);
    else fail(`python tests/${f}`, `${r.error ?? ''}${r.stdout ?? ''}${r.stderr ?? ''}`);
  }

  step('5. The built server on a throwaway root');
  try {
    await bundleChecks();
  } catch (e) {
    fail('the built server checks ran to the end', String(e?.message ?? e));
  }

  step('7. The bundle finds its root by itself');
  walkUpCheck();
}

await checks();
if (failed.length) {
  console.log(`\nnot ready: ${failed.length} check(s) failed:\n  - ${failed.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nready');
