// Suggested prices on the desk's invoice lines: filled from history, never over what the desk typed.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { car, createTicket, signIn } from './shop';

type Sugg = { price: number; count: number; low: number; high: number; basis: Record<string, unknown> };
const PART: Sugg = {
  price: 50,
  count: 14,
  low: 45,
  high: 55,
  basis: { level: 'model_years', years: [2017, 2021], make: 'HONDA', model: 'HR-V', recent: true },
};
const LABOR: Sugg = {
  price: 90,
  count: 1,
  low: 80,
  high: 100,
  basis: { level: 'make', years: null, make: 'HONDA', model: 'HR-V', recent: false },
};
const URLS = '**/api/price-suggestions*';

async function stub(page: Page, body: unknown, opts: { status?: number; delay?: number } = {}): Promise<URL[]> {
  const seen: URL[] = [];
  await page.route(URLS, async (route: Route) => {
    seen.push(new URL(route.request().url()));
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    await route.fulfill({ status: opts.status ?? 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return seen;
}

async function openTicket(page: Page): Promise<void> {
  await signIn(page.context().request, 'admin', 'Owner Test');
  const t = await createTicket(page.context().request, { ...car() });
  await page.goto('/admin');
  await page.locator('#board .card', { hasText: t.last }).click();
  await expect(page.locator('#title')).toHaveText(`Ticket #${t.id}`);
  await page.getByRole('button', { name: 'Add line' }).click();
}

const row = (page: Page) => page.locator('#tLines tr').last();

/** Types into the last line's description until the catalog hint is loaded, then completes the part name. */
async function pick(page: Page, name = 'FRONT BRAKE PADS'): Promise<void> {
  const d = row(page).locator('.d');
  await d.fill(name.slice(0, 11));
  await expect(page.locator(`#part-list option[value="${name}"]`)).toHaveCount(1);
  await d.fill(name);
}

test('picking a part fills price and labor from history and says where they come from', async ({ page }) => {
  const seen = await stub(page, { part: PART, labor: LABOR });
  await openTicket(page);
  await pick(page);
  await expect(row(page).locator('.p')).toHaveValue('50.00');
  await expect(row(page).locator('.l')).toHaveValue('90.00');
  const sugg = row(page).locator('.sugg');
  await expect(sugg).toContainText('Part: from 14 jobs · 2017–2021 HONDA HR-V · last 2 yrs: $45.00–$55.00');
  await expect(sugg).toContainText('Labor: from 1 job · any HONDA · all time: $80.00–$100.00');
  expect(seen).toHaveLength(1);
  expect(seen[0].searchParams.get('code')).toBe('FBP');
  expect(seen[0].searchParams.get('qty')).toBe('1');
  expect(seen[0].searchParams.get('year')).toBe('2019');
  expect(seen[0].searchParams.get('make')).toBe('CADILLAC');
  expect(seen[0].searchParams.get('model')).toBe('XT5');
  await expect(page.getByRole('button', { name: /Update suggested prices/ })).toHaveCount(0);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('the request carries the qty; a bad year is left out and a bad qty skips the fetch', async ({ page }) => {
  const seen = await stub(page, { part: PART, labor: LABOR });
  await openTicket(page);
  await row(page).locator('.q').fill('2');
  await page.locator('#t-year').fill('19');
  await pick(page);
  await expect(row(page).locator('.sugg')).toContainText('Part:');
  expect(seen).toHaveLength(1);
  expect(seen[0].searchParams.get('qty')).toBe('2');
  expect(seen[0].searchParams.has('year')).toBe(false);

  await row(page).locator('.q').fill('0');
  await page.locator('#t-year').fill('2020');
  await page.getByRole('button', { name: /Update suggested prices/ }).click();
  await page.waitForTimeout(300);
  expect(seen).toHaveLength(1); // qty 0: nothing sent
});

test('a labor price typed first stays; the price fills', async ({ page }) => {
  await stub(page, { part: PART, labor: LABOR });
  await openTicket(page);
  await row(page).locator('.l').fill('33.00');
  await pick(page);
  await expect(row(page).locator('.p')).toHaveValue('50.00');
  await expect(row(page).locator('.l')).toHaveValue('33.00');
});

test('a late reply leaves a box the desk typed in', async ({ page }) => {
  await stub(page, { part: PART, labor: LABOR }, { delay: 1000 });
  await openTicket(page);
  await pick(page);
  await row(page).locator('.p').fill('61.25');
  await expect(row(page).locator('.l')).toHaveValue('90.00', { timeout: 5000 });
  await expect(row(page).locator('.p')).toHaveValue('61.25');
});

test('changing the make offers Update suggested prices, and nothing changes until it is pressed', async ({ page }) => {
  const seen = await stub(page, { part: PART, labor: LABOR });
  await openTicket(page);
  await pick(page);
  await expect(row(page).locator('.p')).toHaveValue('50.00');
  await page.locator('#t-make').fill('Honda');
  const link = page.getByRole('button', { name: /Update suggested prices/ });
  await expect(link).toBeVisible();
  await page.waitForTimeout(400);
  expect(seen).toHaveLength(1); // no fetch on typing
  await expect(row(page).locator('.p')).toHaveValue('50.00');

  await page.unroute(URLS);
  const seen2 = await stub(page, { part: { ...PART, price: 52.5 }, labor: null });
  await link.click();
  await expect(row(page).locator('.p')).toHaveValue('52.50');
  await expect(row(page).locator('.l')).toHaveValue('90.00');
  expect(seen2[0].searchParams.get('make')).toBe('Honda');
  await expect(link).toHaveCount(0);

  await row(page).locator('.q').fill('3'); // labor depends on qty
  await expect(link).toBeVisible();
  await row(page).locator('.p').fill('1.00');
  await row(page).locator('.l').fill('2.00'); // both touched: nothing left to update
  await expect(link).toHaveCount(0);
});

for (const status of [404, 500]) {
  test(`a ${status} leaves the catalog prices, with no suggestion line and no flash`, async ({ page }) => {
    await stub(page, { error: 'nope' }, { status });
    await openTicket(page);
    await pick(page);
    await expect(row(page).locator('.p')).toHaveValue('100.00');
    await expect(row(page).locator('.l')).toHaveValue('100.00');
    await page.waitForTimeout(500);
    await expect(row(page).locator('.sugg')).toHaveCount(0);
    await expect(page.locator('#flash')).toBeHidden();
  });
}

test('saving stores the prices shown', async ({ page }) => {
  await stub(page, { part: PART, labor: LABOR });
  await openTicket(page);
  await pick(page);
  await expect(row(page).locator('.p')).toHaveValue('50.00');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#saved')).toHaveText('Saved.');
  await expect(row(page).locator('.p')).toHaveValue('50.00');
  await expect(row(page).locator('.l')).toHaveValue('90.00');
  await expect(row(page).locator('.lt')).toHaveText('$140.00');
});

test('removing a line drops its suggestion and a late reply', async ({ page }) => {
  await stub(page, { part: PART, labor: LABOR }, { delay: 500 });
  await openTicket(page);
  await pick(page);
  await page.getByRole('button', { name: 'Remove line' }).click();
  await page.waitForTimeout(800);
  await expect(page.locator('.sugg')).toHaveCount(0);
  await expect(page.locator('#flash')).toBeHidden();
});
