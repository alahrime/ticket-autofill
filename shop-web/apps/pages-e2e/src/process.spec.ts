// The built server's exit codes, which shop-web/tools/run-shop.cmd acts on (ruling R13): an uncaught error is
// logged and exits 1 (restart a clean copy); a port already taken exits 3 (another copy serves: stop). Each run
// is a child process on its own throwaway root and a spare port, never 8081 or the real tickets.db.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { MAIN } from './global-setup';

/** A listening socket on a spare 127.0.0.1 port (never 8081). */
async function holdPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen({ host: '127.0.0.1', port: 0 }, ok);
  });
  const port = (server.address() as { port: number }).port;
  expect(port).not.toBe(8081);
  return { port, server };
}

const close = (server: Server): Promise<void> => new Promise((ok) => server.close(() => ok()));

/** Runs the built main.js on root/port with extra node args -> its exit code and output (killed after 20 s). */
function runMain(root: string, port: number, nodeArgs: string[] = []): Promise<{ code: number | null; output: string }> {
  return new Promise((ok, fail) => {
    const child: ChildProcess = spawn(process.execPath, [...nodeArgs, MAIN], {
      cwd: root,
      env: { ...process.env, SHOP_ROOT: root, SHOP_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', fail);
    child.on('exit', (code) => {
      clearTimeout(timer);
      ok({ code, output });
    });
  });
}

test.describe('the built server exits for run-shop.cmd', () => {
  let root = '';
  test.beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shop-exit-'));
  });
  test.afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  test('a thrown timer callback is logged as its class and exits 1', async () => {
    // a preload that throws from a timer once the server is serving (the crash handler is installed then)
    const preload = join(root, 'throw-later.cjs');
    writeFileSync(
      preload,
      "const t = setInterval(() => { if (process.listenerCount('uncaughtException') > 0) { clearInterval(t);" +
        " setTimeout(() => { throw new RangeError('secret 4827'); }, 50); } }, 50);\n",
    );
    const { port, server } = await holdPort();
    await close(server); // free again: the shop server takes it
    const r = await runMain(root, port, ['--require', preload]);
    expect(r.code).toBe(1);
    const log = readFileSync(join(root, 'shop.log'), 'utf8');
    expect(log).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d started 127\\.0\\.0\\.1:${port}\\n`));
    expect(log).toMatch(/ error RangeError\n$/);
    expect(log + r.output).not.toContain('secret 4827'); // the class only, never the message
  });

  test('a port already in use exits 3, with no started line', async () => {
    const { port, server } = await holdPort();
    try {
      const r = await runMain(root, port);
      expect(r.code).toBe(3);
      expect(r.output).toContain('The shop server is already running on this port.');
      let log = '';
      try {
        log = readFileSync(join(root, 'shop.log'), 'utf8');
      } catch {
        // no log at all is fine too
      }
      expect(log).not.toContain('started');
    } finally {
      await close(server);
    }
  });
});
