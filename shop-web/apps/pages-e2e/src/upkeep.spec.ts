// The board's backup line and its two buttons (Task 8), and the page without them (shop.py has no /api/upkeep).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './shop';

type Status = {
  backup: { last: string | null; stale: boolean; offsite: string | null };
  import: { running: boolean; last: { finished: string; ok: boolean; invoices: number } | null };
  needs_bill: number;
};
const status = (over: Partial<Status> = {}): Status => ({
  backup: { last: '2026-11-20', stale: false, offsite: null },
  import: { running: false, last: null },
  needs_bill: 0,
  ...over,
});
const mockStatus = async (page: Page, body: Status): Promise<void> => {
  await page.route('**/api/upkeep/status', (r) => r.fulfill({ json: body }));
};

async function board(page: Page): Promise<void> {
  await signIn(page.context().request, 'admin', 'Owner Test');
  await page.goto('/admin');
}

test('the line shows the backup the server made', async ({ page }) => {
  await board(page);
  const line = page.locator('#upkeep');
  await expect(line).toContainText('Last backup: ');
  await expect(line).not.toContainText('none yet');
  await expect(line).toContainText('No copy off this PC yet');
  await expect(page.getByRole('link', { name: 'Bill history' })).toHaveAttribute('href', '/bills');
  await expect(line.getByRole('button', { name: 'Check InvoMax now' })).toBeVisible();
  await expect(line.getByRole('button', { name: 'Copy backups to USB' })).toBeVisible();
});

test('a stale backup shows red, a failed import says so, and tickets needing a bill link on', async ({ page }) => {
  await mockStatus(
    page,
    status({
      backup: { last: null, stale: true, offsite: null },
      import: { running: false, last: { finished: '2026-11-20T08:30:00', ok: false, invoices: 0 } },
      needs_bill: 3,
    }),
  );
  await board(page);
  const line = page.locator('#upkeep');
  await expect(line.getByText('Last backup: none yet')).toHaveClass(/bad/);
  await expect(line).toContainText('InvoMax checked');
  await expect(line).toContainText('(failed)');
  await expect(line.getByRole('link', { name: '3 tickets need a bill' })).toHaveAttribute('href', '/bills#needs');
});

test('a stale backup with a date is red too, and a copy off this PC drops the warning', async ({ page }) => {
  await mockStatus(page, status({ backup: { last: '2026-11-01', stale: true, offsite: '2026-11-19T10:00:00.000Z' } }));
  await board(page);
  const line = page.locator('#upkeep');
  await expect(line.locator('.bad')).toContainText('Last backup:');
  await expect(line).not.toContainText('No copy off this PC yet');
});

test('Check InvoMax now says Started, and a second press says already running', async ({ page }) => {
  await board(page);
  const btn = page.getByRole('button', { name: 'Check InvoMax now' });
  await btn.click();
  await expect(page.locator('#flash')).toContainText('Started');
  await expect(btn).toBeEnabled();
  await page.route('**/api/upkeep/import', (r) =>
    r.fulfill({ status: 409, json: { error: 'an import is already running' } }),
  );
  await btn.click();
  await expect(page.locator('#flash')).toContainText('already running');
});

test('a button is off while its request runs', async ({ page }) => {
  await board(page);
  let release!: () => void;
  const held = new Promise<void>((ok) => (release = ok));
  await page.route('**/api/upkeep/copy-backups', async (r) => {
    await held;
    await r.fulfill({ json: { copies: [{ copied: 2, skipped: 1, target: 'X' }] } });
  });
  const btn = page.getByRole('button', { name: 'Copy backups to USB' });
  await btn.click();
  await expect(btn).toBeDisabled();
  release();
  await expect(page.locator('#flash')).toContainText('Copied 2, skipped 1');
  await expect(btn).toBeEnabled();
});

test("Copy backups shows the server's reason when it can't", async ({ page }) => {
  await board(page);
  await page.route('**/api/upkeep/copy-backups', (r) => r.fulfill({ status: 400, json: { error: 'drive not found' } }));
  await page.getByRole('button', { name: 'Copy backups to USB' }).click();
  await expect(page.locator('#flash')).toContainText('drive not found');
});

test('without /api/upkeep (shop.py) there is no line, no link and no error', async ({ page }) => {
  await page.route('**/api/upkeep/status', (r) => r.fulfill({ status: 404, json: { error: 'not found' } }));
  await board(page);
  await expect(page.locator('#board')).toBeVisible();
  await expect(page.locator('#net')).toHaveText('');
  await expect(page.locator('#upkeep')).toBeHidden();
  await expect(page.getByRole('link', { name: 'Bill history' })).toBeHidden();
  await expect(page.locator('#flash')).toBeHidden();
});

test('the refresh does not stack up while a request hangs', async ({ page }) => {
  await page.clock.install();
  // the page gives up on a call after 15 s; here it must stay hung past the 60 s tick
  await page.addInitScript(() => {
    AbortSignal.timeout = () => new AbortController().signal;
  });
  let seen = 0;
  await page.route('**/api/upkeep/status', () => {
    seen++; // never answered
  });
  await board(page);
  await expect.poll(() => seen).toBe(1);
  await page.clock.fastForward(60_000 * 2);
  expect(seen).toBe(1);
});

test('the board with its footer passes the axe scan', async ({ page }) => {
  await mockStatus(
    page,
    status({ needs_bill: 2, import: { running: false, last: { finished: '2026-11-20T08:30:00', ok: true, invoices: 1 } } }),
  );
  await board(page);
  await expect(page.locator('#upkeep')).toBeVisible();
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations).toEqual([]);
});
