// Runs Python against the repo's own modules (tickets.py, accounts.py, ...) for interop tests.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The repo root: the folder holding tickets.py (shop-web/apps/api/test -> up four). */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

/** Environment for a Python child: UTF-8 stdout, extra variables on top. */
export const pyEnv = (env: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  ...env,
});

/** `python -c code` with the repo root as cwd (so `import tickets` works); stdout. Throws on exit != 0. */
export function py(code: string, env: Record<string, string> = {}): string {
  return execFileSync('python', ['-c', code], {
    cwd: REPO_ROOT,
    env: pyEnv(env),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A fresh temp folder for a test database; `done()` removes it. */
export function tempDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'shop-api-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
