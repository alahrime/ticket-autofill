// The plain-JS pages (web/admin.html, web/tech.html) in Chromium against the built TS server
// (node apps/api/dist/main.js) on a temp SHOP_ROOT; src/global-setup.ts starts and stops it.
import { defineConfig, devices } from '@playwright/test';
import { BASE } from './src/shop';

export default defineConfig({
  testDir: './src',
  globalSetup: './src/global-setup.ts',
  fullyParallel: false,
  workers: 1, // one server and one board: the tests take turns
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 }, // the pages poll every 4 s
  outputDir: './test-output',
  use: {
    baseURL: BASE,
    locale: 'en-US', // dates on the pages are toLocaleDateString(undefined, ...)
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
