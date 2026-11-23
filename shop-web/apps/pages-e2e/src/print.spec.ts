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

function snapshot(over: { labor?: Row[]; parts?: Array<{ desc: string; qty: number; price: number; total: number }>; text?: (n: number) => string }) {
  const t = over.text ?? ((n: number) => 'JANE DOE'.slice(0, n));
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

async function printed(page: Page): Promise<{ sheets: number; pdf: number; copy: number }> {
  const pdf = pdfPages(await page.pdf({ format: 'Letter', preferCSSPageSize: true }));
  const sheets = await page.locator('.sheet').count();
  const copy = await page.locator('.copy').first().locator('.sheet').count();
  return { sheets, pdf, copy };
}

test('printed to PDF: a plain 20/20 bill is exactly 2 pages (one a copy)', async ({ page }) => {
  const labor = Array.from({ length: 20 }, (_, i) => ({ desc: `LABOR LINE ${i}`, amount: 10 }));
  const parts = Array.from({ length: 20 }, (_, i) => ({ desc: `PART ${i}`, qty: 1, price: 5, total: 5 }));
  await openBill(page, snapshot({ labor, parts }));
  expect(await printed(page)).toEqual({ sheets: 2, pdf: 2, copy: 1 });
});

test('printed to PDF: 20 labor and 20 part rows of 120 characters, shop and header values at their caps', async ({ page }) => {
  const labor = Array.from({ length: 20 }, (_, i) => ({ desc: long(120, i), amount: 10 }));
  const parts = Array.from({ length: 20 }, (_, i) => ({ desc: long(120, i + 3), qty: 1, price: 5, total: 5 }));
  await openBill(page, snapshot({ labor, parts, text: words80 }));
  const r = await printed(page);
  expect(r.copy).toBeGreaterThan(1);
  expect(r.pdf).toBe(2 * r.copy); // every sheet is one paper page: nothing spills over
  expect(r.sheets).toBe(2 * r.copy);
  await expect(page.getByText('Page 1').first()).toBeVisible();
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
  const text = (await page.locator('.copy').first().locator('.labor tbody td:first-child').allTextContents()).join(' ');
  expect(text).toBe(desc);
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
  await expect(page.getByText('Page 2').first()).toBeVisible();
  await noViolations(page);
});
