// The bill print page (/bills/<no>/print) in the real app. The test shop has own billing off, so no bill of ours
// exists: the page must show a plain message, call no print window, and pass axe; paths that are not a bill
// number are 404 and a signed-out visitor goes to /admin. (The bill itself is covered by the component tests.)
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
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

// ---- the bill itself: the API's answer is mocked with a made-up snapshot (own billing is off in this shop) ----

type Row = { desc: string; amount: number };
type Snapshot = ReturnType<typeof snapshot>;

/** A made-up shop and car like the real ones: the typical header the 24-row page is measured against. */
const TYPICAL_SHOP = { name: 'TEST AUTO SERVICE', address: ['100 MAIN ST', 'ANYTOWN, VA 22000'], phone: '(555)010-0001', hours: 'MON–FRI 8:00 AM – 6:00 PM' };
const TYPICAL_CAR = { year: '2019', make: 'CADILLAC', model: 'XT5', plate: 'XKS-4827', vin: '1GYKNCRS5KZ000000', odometer: '48215' };

function snapshot(over: {
  labor?: Row[];
  parts?: Array<{ desc: string; qty: number; price: number; total: number }>;
  text?: (n: number) => string;
  typical?: boolean;
}) {
  const t = over.text ?? ((n: number) => 'JANE DOE'.slice(0, n));
  const typical = over.typical
    ? { shop: TYPICAL_SHOP, vehicle: TYPICAL_CAR, customer: { first: 'JANE', last: 'DOE', phone: '(555)010-0000' }, mechanic: 'AL FIXIT' }
    : {};
  return {
    invoice_no: '9000010',
    revision: 1,
    date: '2026-11-23',
    time: '14:22',
    customer: { first: t(30), last: t(30), phone: '(555)010-0000' },
    vehicle: { year: '2015', make: t(30), model: t(30), plate: 'XKS-4827', vin: t(17), odometer: '123456' },
    mechanic: t(80),
    labor: over.labor ?? [{ desc: 'DIAGNOSTIC', amount: 55 }],
    parts: over.parts ?? [{ desc: 'BRAKE PADS', qty: 1, price: 100, total: 100 }],
    amounts: { parts: 100, labor: 55, supplies: 7.75, tax: 6.45, total: 169.2, deposit: 0, balance: 169.2 },
    shop: {
      name: t(80),
      address: [t(80), t(80), t(80), t(80), t(80)],
      phone: t(80),
      hours: t(80),
    },
    ...typical,
  };
}

/** Open the print page (no print window) over a mocked bill; resolves when the sheets show. */
async function openBill(page: Page, bill: Snapshot): Promise<void> {
  await signIn(page.context().request, 'admin', 'Owner Test');
  await page.route('**/api/own-bills/*', (route) => route.fulfill({ json: { bill, revisions: [], ticket_id: 1 } }));
  await page.goto('/bills/9000010/print?noprint=1');
  await expect(page.locator('.sheet').first()).toBeVisible();
}

/** The number of pages in a PDF: its /Type /Page objects (not /Pages). */
const pdfPages = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

const WORDS = ['BRAKE', 'PADS', 'FRONT', 'AXLE', 'REPLACE', 'CERAMIC', 'ROTOR', 'SENSOR', 'OIL', 'FILTER'];
const long = (n: number, i: number): string =>
  Array.from({ length: Math.ceil(n / 5) }, (_, k) => WORDS[(k + i) % WORDS.length]).join(' ').slice(0, n);
const words80 = (n: number): string => Array.from({ length: 12 }, (_, k) => WORDS[(k + n) % WORDS.length]).join(' ').slice(0, 80);

/** The PDF's pages and the bill's sheets; every sheet, laid out for paper, is no taller than the page (10.2in). */
async function printed(page: Page): Promise<{ sheets: number; pdf: number; copy: number }> {
  const pdf = pdfPages(await page.pdf({ format: 'Letter', preferCSSPageSize: true }));
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: Math.round(7.7 * 96), height: Math.round(10.2 * 96) });
  const tallest = await page.locator('.sheet').evaluateAll((s) => Math.max(...s.map((e) => e.getBoundingClientRect().height)));
  expect(tallest).toBeLessThanOrEqual(10.2 * 96);
  const sheets = await page.locator('.sheet').count();
  const copy = await page.locator('.copy').first().locator('.sheet').count();
  return { sheets, pdf, copy };
}

const plain = (n: number) => ({
  labor: Array.from({ length: n }, (_, i) => ({ desc: `LABOR LINE ${i}`, amount: 10 })),
  parts: Array.from({ length: n }, (_, i) => ({ desc: `PART ${i}`, qty: 1, price: 5, total: 5 })),
});

test('printed to PDF: a plain 24/24 bill with a typical header is exactly 2 pages (one a copy)', async ({ page }) => {
  await openBill(page, snapshot({ ...plain(24), typical: true }));
  expect(await printed(page)).toEqual({ sheets: 2, pdf: 2, copy: 1 });
  await expect(page.getByText('Page 1 of 1').first()).toBeVisible();
});

test('printed to PDF: 25 pairs take a second sheet, Page 2 of 2', async ({ page }) => {
  await openBill(page, snapshot({ ...plain(25), typical: true }));
  expect(await printed(page)).toEqual({ sheets: 4, pdf: 4, copy: 2 });
  await expect(page.getByText('Page 2 of 2').first()).toBeVisible();
});

test('rows stay level: a 3-line labor description beside a 1-line part', async ({ page }) => {
  const labor = [
    { desc: 'REPLACE FRONT BRAKE PADS AND ROTORS, CLEAN AND LUBE THE SLIDES, BLEED THE BRAKES AND ROAD TEST', amount: 300 },
    { desc: 'TIRE ROTATION', amount: 25 },
  ];
  const parts = [
    { desc: 'PADS', qty: 1, price: 100, total: 100 },
    { desc: 'ROTORS', qty: 2, price: 70, total: 140 },
  ];
  await openBill(page, snapshot({ labor, parts, typical: true }));
  const copy = page.locator('.copy').first();
  const lab = await copy.locator('td.ld').nth(1).boundingBox();
  const par = await copy.locator('td.pd').nth(1).boundingBox();
  expect(await copy.locator('td.pd').nth(1).textContent()).toBe('ROTORS');
  expect(lab && par ? Math.abs(lab.y - par.y) : 99).toBeLessThan(1);
});

/** Elements in the first sheet whose content is wider or taller than the element: anything clipped or spilling. */
async function overflowing(page: Page): Promise<string[]> {
  await page.emulateMedia({ media: 'print' });
  return page
    .locator('.sheet')
    .first()
    .evaluate((sheet) =>
      Array.from(sheet.querySelectorAll<HTMLElement>('*'))
        .filter((e) => getComputedStyle(e).display !== 'inline')
        .filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)
        .map((e) => `${e.tagName.toLowerCase()}.${e.className}`),
    );
}

test('nothing overflows: a 24/24 bill, and one with the header at its caps', async ({ page }) => {
  await openBill(page, snapshot({ ...plain(24), typical: true }));
  expect(await overflowing(page)).toEqual([]);
  await page.unroute('**/api/own-bills/*');
  await page.route('**/api/own-bills/*', (route) =>
    route.fulfill({ json: { bill: snapshot({ ...plain(24), text: words80 }), revisions: [], ticket_id: 1 } }),
  );
  await page.emulateMedia({ media: 'screen' });
  await page.reload();
  await expect(page.locator('.sheet').first()).toBeVisible();
  expect(await overflowing(page)).toEqual([]);
});

test('printed to PDF: 20 labor and 20 part rows of 120 characters, shop and header values at their caps', async ({ page }) => {
  const labor = Array.from({ length: 20 }, (_, i) => ({ desc: long(120, i), amount: 10 }));
  const parts = Array.from({ length: 20 }, (_, i) => ({ desc: long(120, i + 3), qty: 1, price: 5, total: 5 }));
  await openBill(page, snapshot({ labor, parts, text: words80 }));
  const r = await printed(page);
  expect(r.copy).toBeGreaterThan(1);
  expect(r.pdf).toBe(2 * r.copy); // every sheet is one paper page: nothing spills over
  expect(r.sheets).toBe(2 * r.copy);
  await expect(page.getByText(/^Page 1 of \d+$/).first()).toBeVisible();
});

test('printed to PDF: the same with unbroken 80-character values (the widest letters) in the header', async ({ page }) => {
  const labor = Array.from({ length: 12 }, (_, i) => ({ desc: long(120, i), amount: 10 }));
  await openBill(page, snapshot({ labor, text: (n) => 'W'.repeat(n) }));
  const r = await printed(page);
  expect(r.pdf).toBe(r.sheets);
});

test('printed to PDF: one description far too long for a page still prints, all of it, on whole pages', async ({ page }) => {
  const desc = Array.from({ length: 400 }, (_, i) => `PART${i}`).join(' ');
  await openBill(page, snapshot({ labor: [{ desc, amount: 12.5 }] }));
  const r = await printed(page);
  expect(r.pdf).toBe(r.sheets);
  expect(r.copy).toBeGreaterThan(1);
  const text = (await page.locator('.copy').first().locator('td.ld').allTextContents()).join(' ');
  expect(text).toBe(desc);
});

test('the grey bands print without "Background graphics" ticked (print-color-adjust: exact)', async ({ page }) => {
  await openBill(page, snapshot({}));
  await page.emulateMedia({ media: 'print' });
  const adjust = await page
    .locator('.bill-print')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('print-color-adjust') || getComputedStyle(el).getPropertyValue('-webkit-print-color-adjust'));
  expect(adjust).toBe('exact');
  const band = await page.locator('.bill-print .lines thead th').first().evaluate((el) => getComputedStyle(el).getPropertyValue('print-color-adjust'));
  expect(band).toBe('exact'); // inherited by the bands
});

async function noViolations(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

test('the bill itself has no axe violations: a short bill, and a 40-line bill', async ({ page }) => {
  await openBill(page, snapshot({ text: (n) => 'JANE DOE'.slice(0, n) }));
  await noViolations(page);
  const labor = Array.from({ length: 40 }, (_, i) => ({ desc: `LABOR LINE ${i}`, amount: 10 }));
  const parts = Array.from({ length: 40 }, (_, i) => ({ desc: `PART ${i}`, qty: 2, price: 5, total: 10 }));
  await page.unroute('**/api/own-bills/*');
  await page.route('**/api/own-bills/*', (route) =>
    route.fulfill({ json: { bill: snapshot({ labor, parts }), revisions: [], ticket_id: 1 }, status: 200 }),
  );
  await page.reload();
  await expect(page.getByText(/^Page 2 of \d+$/).first()).toBeVisible();
  await noViolations(page);
});
