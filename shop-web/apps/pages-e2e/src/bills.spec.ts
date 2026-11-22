// The React admin app's Bill history (/bills), against the made-up shop global-setup.ts seeds: InvoMax bills
// 9000001 (linked there to a filled XKS-4827 ticket) and 9000002, and a second filled XKS-4827 ticket with no bill.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { scrollsSideways, signIn } from './shop';

async function noViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
}

test('Bill history: search, both sides, link a ticket that needs its bill, no axe violations', async ({ page }) => {
  await signIn(page.context().request, 'admin', 'Owner Test');
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Bill history' }).click();
  await expect(page).toHaveURL(/\/bills$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Bill history' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to tickets' })).toHaveAttribute('href', '/admin');

  // search by tag: the filter lands in the URL
  await page.getByLabel('Tag').fill('XKS-4827');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/[?&]tag=XKS-4827/);
  const results = page.getByRole('table', { name: /bills/i });
  await expect(results.getByRole('row', { name: /9000001/ })).toContainText('JANE TESTCASE');
  await expect(results.getByRole('row', { name: /9000002/ })).toContainText('JANE DOE');

  // open the linked bill: both sides
  await page.getByRole('button', { name: 'Open bill 9000001' }).click();
  await expect(page).toHaveURL(/[?&]open=im9000001/);
  const detail = page.getByRole('region', { name: /InvoMax bill #9000001/ });
  const ours = detail.getByRole('region', { name: 'Our ticket' });
  const theirs = detail.getByRole('region', { name: 'InvoMax bill' });
  await expect(ours).toContainText('BRAKE PADS');
  await expect(ours).toContainText('$150.00');
  await expect(theirs).toContainText('REPLACE FRONT PADS');
  await expect(theirs).toContainText('$210.00');
  await expect(detail).toContainText('Our subtotal differs by $60.00');
  await expect(detail.getByRole('button', { name: 'Unlink' })).toBeVisible();
  await noViolations(page);

  // the ticket with no bill yet: link it to its candidate
  const needs = page.locator('#needs');
  const link = needs.getByRole('button', { name: /^Link bill 9000002 to ticket #\d+$/ });
  await expect(link).toBeVisible();
  const ticket = /#(\d+)$/.exec((await link.getAttribute('aria-label')) ?? '')?.[1];
  expect(ticket).toBeTruthy();
  await link.click();
  await expect(needs.getByRole('status')).toHaveText(`Linked ticket #${ticket} to bill 9000002`);
  await expect(needs.getByRole('button', { name: /^Link bill 9000002 to ticket/ })).toHaveCount(0);
  await expect(results.getByRole('row', { name: /9000002/ })).toContainText('JANE TESTCASE'); // the list refreshed
  await noViolations(page);

  // a phone's width: the detail goes below the table, nothing scrolls sideways
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  await expect(detail.getByRole('region', { name: 'Our ticket' })).toBeVisible();
  const tableBox = await results.boundingBox();
  const detailBox = await detail.boundingBox();
  expect(detailBox && tableBox && detailBox.y >= tableBox.y + tableBox.height).toBe(true);
  expect(await scrollsSideways(page)).toBe(false);
  await noViolations(page);
});

test('the detail sits beside the table at desktop width', async ({ page }) => {
  await signIn(page.context().request, 'admin', 'Owner Test');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/bills?tag=XKS-4827&open=im9000001');
  const results = page.getByRole('table', { name: /bills/i });
  const detail = page.getByRole('region', { name: /InvoMax bill #9000001/ });
  await expect(detail.getByRole('region', { name: 'Our ticket' })).toBeVisible();
  const tableBox = await results.boundingBox();
  const detailBox = await detail.boundingBox();
  expect(detailBox && tableBox && detailBox.x >= tableBox.x + tableBox.width).toBe(true);
});

test('signed out, /bills goes to the admin sign-in', async ({ page }) => {
  await page.goto('/bills');
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
