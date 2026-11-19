// The desk page: delete with its confirmation, the Deleted list and Restore; the iPad kiosk is gone.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { car, createTicket, scrollsSideways, signIn, type Ticket } from './shop';

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function deskWithTicket(page: Page, deposit: boolean): Promise<Ticket> {
  await signIn(page.context().request, 'admin', 'Owner Test');
  const t = await createTicket(page.context().request, {
    ...car(),
    ...(deposit ? { deposits: [{ amount: 100, method: 'cash', date: today(), note: '' }] } : {}),
  });
  await page.goto('/admin');
  await page.locator('#board .card', { hasText: t.last }).click();
  await expect(page.locator('#title')).toHaveText(`Ticket #${t.id}`);
  return t;
}

test('admin delete with deposit warning', async ({ page }) => {
  const t = await deskWithTicket(page, true);
  const del = page.getByRole('button', { name: 'Delete', exact: true });
  await del.click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(`Delete ticket #${t.id} — ${t.first} ${t.last}, ${t.plate}, $0.00?`);
  await expect(dlg).toContainText('It has $100.00 in deposits.');
  await expect(dlg).toContainText('It stays in the Deleted list until you restore it.'); // R10: never purged
  await expect(dlg).not.toContainText('14 days');
  await expect(dlg.getByRole('button', { name: 'Cancel' })).toBeFocused();

  // Esc cancels and focus goes back to Delete
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(del).toBeFocused();
  await expect(page.locator('#title')).toHaveText(`Ticket #${t.id}`);

  await del.click();
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#flash')).toContainText(`Deleted ticket #${t.id}`);
  await expect(page.locator('#board')).toBeVisible();
  await expect(page.locator('#board .card', { hasText: t.last })).toHaveCount(0);

  await page.getByRole('button', { name: 'Deleted', exact: true }).click();
  const row = page.locator('#delList .drow', { hasText: t.last });
  await expect(row).toContainText('from Waiting');
  await expect(row).toContainText('Kept (deposit)'); // R10: purge_on is null, so never removed for good
  await row.getByRole('button', { name: `Restore ticket #${t.id}` }).click();
  await expect(page.locator('#flash')).toContainText(`Restored #${t.id}`);
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to board' }).click();
  await expect(page.locator('#board .col.waiting .card', { hasText: t.last })).toHaveCount(1);
});

test('admin delete without a deposit: 14 days, and the purge date', async ({ page }) => {
  const t = await deskWithTicket(page, false);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Deleted tickets can be restored for 14 days.');
  await expect(dlg).not.toContainText('deposits');
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#flash')).toContainText(`Deleted ticket #${t.id}`);
  await page.getByRole('button', { name: 'Deleted', exact: true }).click();
  const row = page.locator('#delList .drow', { hasText: t.last });
  const on = new Date();
  on.setDate(on.getDate() + 14); // the server's purge_on, shown as a local date
  const shown = on.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  await expect(row).toContainText(`removed for good on ${shown}`);
});

test('a11y: the delete modal has no axe violations', async ({ page }) => {
  await deskWithTicket(page, true);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog', { name: /^Delete ticket #/ })).toBeVisible(); // aria-labelledby
  const result = await new AxeBuilder({ page }).include('#delDlg').analyze();
  expect(result.violations).toEqual([]);
});

test('admin page at 375 px: no sideways scroll, modal open', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await deskWithTicket(page, false);
  expect(await scrollsSideways(page)).toBe(false);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
  const box = await page.getByRole('dialog').boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to board' }).click();
  await page.getByRole('button', { name: 'Deleted', exact: true }).click();
  expect(await scrollsSideways(page)).toBe(false);
});

test('no kiosk', async ({ page }) => {
  await page.goto('/checkin');
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('a[href="/checkin"]')).toHaveCount(0);
  await signIn(page.context().request, 'admin', 'Owner Test');
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Mechanics & admins' }).click();
  await expect(page.locator('#viewUsers')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Check-in iPad');
  await expect(page.locator('#btnKiosk, #btnRevoke')).toHaveCount(0);
  expect(await page.content()).not.toContain('/api/kiosk');
});
