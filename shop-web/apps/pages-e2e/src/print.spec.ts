// The bill print page (/bills/<no>/print) in the real app. The test shop has own billing off, so no bill of ours
// exists: the page must show a plain message, call no print window, and pass axe; paths that are not a bill
// number are 404 and a signed-out visitor goes to /admin. (The bill itself is covered by the component tests.)
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { BASE, signIn } from './shop';

test('print page: a bill that does not load says so, prints nothing, no axe violations', async ({ page }) => {
  await signIn(page.context().request, 'admin', 'Owner Test');
  await page.addInitScript(() => {
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
  await page.goto('/bills/9000010/print');
  await expect(page.getByRole('alert')).toContainText('Bill 9000010 could not be loaded');
  await expect(page.getByRole('link', { name: 'Back to tickets' })).toHaveCount(0); // a bare page: no app header
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('print page: not a bill number is 404; signed out goes to /admin', async ({ page, browser }) => {
  await signIn(page.context().request, 'admin', 'Owner Test');
  expect((await page.request.get('/bills/abc/print')).status()).toBe(404);
  const anon = await browser.newContext();
  const res = await anon.request.get(`${BASE}/bills/9000010/print`, { maxRedirects: 0 });
  expect([res.status(), res.headers()['location']]).toEqual([303, '/admin']);
  await anon.close();
});
