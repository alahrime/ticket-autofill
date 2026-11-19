// The built bundle finds its files: openapi.yaml (specPath, or the server under test wouldn't answer) and, with
// no SHOP_ROOT, the repo root by walking up to shop.py (loadConfig). `admin` alone only prints the usage line:
// it never opens a tickets.db.
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { MAIN } from './global-setup';

test('the bundle finds openapi.yaml and the repo root', async ({ request }) => {
  expect((await request.get('/api/me')).status()).toBe(401); // served through the contract: the spec loaded
  const env = { ...process.env };
  delete env['SHOP_ROOT'];
  const r = spawnSync(process.execPath, [MAIN, 'admin'], { env, encoding: 'utf8' });
  expect(r.stderr).not.toContain('shop.py not found');
  expect([r.status, r.stdout.trim()]).toEqual([1, 'usage: node shop-web/apps/api/dist/main.js [admin <name>]']);
});
