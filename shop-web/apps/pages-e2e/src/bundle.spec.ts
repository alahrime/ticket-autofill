// The built bundle finds its files: openapi.yaml (specPath, or the server under test wouldn't answer) and, with
// no SHOP_ROOT, its root by walking up to shop.py (loadConfig). The walk-up runs on a copy of the bundle in a
// throwaway tree outside the repo (an empty shop.py at its top), never near the real tickets.db.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { expect, test } from '@playwright/test';
import { MAIN, REPO } from './global-setup';

/** child is parent or below it. */
const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

test('the bundle finds openapi.yaml', async ({ request }) => {
  expect((await request.get('/api/me')).status()).toBe(401); // served through the contract: the spec loaded
});

test('the bundle walks up to the nearest shop.py', () => {
  const root = mkdtempSync(join(tmpdir(), 'shop-walkup-'));
  try {
    expect(inside(root, REPO) || inside(REPO, root)).toBe(false); // nowhere near the real tickets.db
    writeFileSync(join(root, 'shop.py'), ''); // the marker loadConfig looks for
    const dist = join(root, 'shop-web', 'apps', 'api', 'dist');
    mkdirSync(dist, { recursive: true });
    copyFileSync(MAIN, join(dist, 'main.js'));
    // the copy's packages, from where the real bundle finds them (the api's own, then the workspace's)
    const modules = [join(REPO, 'shop-web', 'apps', 'api', 'node_modules'), join(REPO, 'shop-web', 'node_modules')];
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: modules.join(delimiter) };
    delete env['SHOP_ROOT'];
    const pass = 'made-up-pass-9';
    const r = spawnSync(process.execPath, [join(dist, 'main.js'), 'admin', 'Walk Test'], {
      cwd: dist,
      env,
      input: `${pass}\n${pass}\n`,
      encoding: 'utf8',
    });
    expect(r.stderr).not.toMatch(/shop\.py not found|Cannot find module/);
    expect([r.status, r.stdout]).toEqual([0, expect.stringContaining('Admin Walk Test is ready')]);
    expect(existsSync(join(root, 'tickets.db'))).toBe(true); // that root, the throwaway one
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
