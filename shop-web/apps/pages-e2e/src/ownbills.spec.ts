// Our own bills on the desk page (web/admin.html), end to end: Approve & print, the first invoice number, the
// print page in a new tab, Reprint, Fix bill and Save & reprint, and Bill history's "Revised". This runs its own
// shop (own billing on, made-up shop details, made-up InvoMax bills 9000001-9000005) on a spare port and temp
// root, beside the shared test shop (own billing off). window.print is stubbed: no print window ever opens.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { btrieveFile, detailBytes, invoiceBytes } from '@shop/invomax/testing';
import { MAIN, REPO } from './global-setup';
import { ADMIN, PASSWORD, PINS, car, createTicket, moveTicket, signIn } from './shop';

const SHOP = {
  name: 'TEST AUTO REPAIR',
  address: ['100 MAIN ST', 'ANYTOWN, ST 00000'],
  phone: '(555)010-0000',
  hours: 'MON-FRI 8-5',
};

function day(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let root = '';
let OWN = '';
let server: ChildProcess | null = null;
let exited: Promise<void> = Promise.resolve();

/** A spare 127.0.0.1 port, free a moment ago (never 8081 nor the shared test shop's). */
async function sparePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok, fail) => {
    s.once('error', fail);
    s.listen({ host: '127.0.0.1', port: 0 }, ok);
  });
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

/** The shop with own billing on: its root, the admin, and the server answering. */
async function startOwnShop(): Promise<void> {
  const port = await sparePort();
  OWN = `http://127.0.0.1:${port}`;
  root = mkdtempSync(join(tmpdir(), 'shop-ownbills-e2e-'));
  const app = process.env['PAGES_E2E_APP'];
  if (!app || !existsSync(join(app, 'index.html'))) throw new Error('the built admin app is missing (global-setup)');
  cpSync(app, join(root, 'shop-web', 'apps', 'admin-app', 'dist'), { recursive: true });
  cpSync(join(REPO, 'web'), join(root, 'web'), { recursive: true });
  for (const f of ['parts.csv', 'vehicles.json']) cpSync(join(REPO, f), join(root, f));
  const invomax = join(root, 'fake-invomax');
  mkdirSync(invomax);
  const nos = ['9000001', '9000002', '9000003', '9000004', '9000005'];
  writeFileSync(
    join(invomax, 'INVOICE.btv'),
    btrieveFile({
      pageSize: 1536,
      recordLength: 498,
      records: nos.map((no) =>
        invoiceBytes({ invoice_no: no, date: day(-1), last: 'DOE', first: 'JOHN', phone: '(555)010-0000', plate: 'TST-0001', parts: 1000, labor: 1000, total: 2000 }),
      ),
    }),
  );
  writeFileSync(
    join(invomax, 'DETAIL.btv'),
    btrieveFile({
      pageSize: 1024,
      recordLength: 265,
      records: nos.map((no) => detailBytes({ invoice_no: no, code: 'LABOR', description: 'TEST LABOR', kind: 'labor', qty: 1, unit: 1000, date: day(-1) })),
    }),
  );
  writeFileSync(join(root, 'shop-settings.json'), JSON.stringify({ backupTargets: [join(root, 'usb-stick')], ownBilling: true, shop: SHOP }));
  const env = { ...process.env, SHOP_ROOT: root, SHOP_PORT: String(port), INVOMAX_DIR: invomax };
  const made = spawnSync(process.execPath, [MAIN, 'admin', ADMIN], { env, input: `${PASSWORD}\n${PASSWORD}\n`, encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`admin command failed: ${made.stdout} ${made.stderr}`);
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server = child;
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`the own-billing shop stopped (port ${port} in use?): ${output}`);
    if (output.includes('Serving on')) break;
    if (i > 150) throw new Error(`the own-billing shop didn't start: ${output}`);
    await new Promise((ok) => setTimeout(ok, 100));
  }
}

/** A context on the own-billing shop, signed in as the admin, with window.print stubbed and counted. */
async function ownContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: OWN, locale: 'en-US' });
  await context.addInitScript(() => {
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
  await signIn(context.request, 'admin', ADMIN);
  return context;
}

test.describe('own billing on', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    await startOwnShop();
    const context = await browser.newContext({ baseURL: OWN });
    await signIn(context.request, 'admin', ADMIN);
    const r = await context.request.post('/api/users', { data: { name: 'Al Fixit', role: 'mechanic', secret: PINS['Al Fixit'] } });
    expect(r.status(), await r.text()).toBeLessThan(300);
    await context.close();
  });

  test.afterAll(async () => {
    server?.kill();
    await exited;
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const ANY_NO = String.raw`\d{7}`; // printTab's `no` is a pattern: any bill number

  /** The new tab the click opens, once it shows the bill (a blank tab opened and closed before it is skipped). */
  async function printTab(context: BrowserContext, click: () => Promise<void>, no: string): Promise<Page> {
    const before = new Set(context.pages());
    const url = new RegExp(`/bills/${no}/print(\\?|$)`);
    await click();
    let found: Page | undefined;
    await expect
      .poll(() => (found = context.pages().find((p) => !before.has(p) && !p.isClosed() && url.test(p.url()))) !== undefined)
      .toBe(true);
    const tab = found as Page;
    await expect(tab.locator('.copy').first().getByText(new RegExp(`INVOICE : ${no}`))).toBeVisible();
    await expect.poll(() => tab.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
    return tab;
  }

  const totalOf = (tab: Page) => tab.locator('.copy').first().locator('table.totals tr', { hasText: /^TOTAL/ });

  test('Approve & print, the first number, Reprint, Fix bill, Save & reprint and Revised', async ({ browser }) => {
    const context = await ownContext(browser);
    const page = await context.newPage();
    await page.goto('/admin');
    await expect(page.locator('#linkBills')).toBeVisible(); // the upkeep status (own billing on) has loaded

    // 1. JANE DOE, typed on a new ticket: one part line, one labor line, the mechanic
    await page.getByRole('button', { name: 'New ticket' }).click();
    await page.locator('#t-first').fill('JANE');
    await page.locator('#t-last').fill('DOE');
    await page.locator('#t-phone').fill('(555)010-0000');
    await page.locator('#t-plate').fill('XKS-4827');
    await page.locator('#t-year').fill('2019');
    await page.locator('#t-make').fill('CADILLAC');
    await page.locator('#t-model').fill('XT5');
    await page.locator('#t-mechanic').selectOption('Al Fixit');
    await expect(page.getByRole('button', { name: 'Send to InvoMax' })).toHaveCount(0);
    for (const [desc, qty, price, labor] of [
      ['TEST PART XKS', '1', '100.00', ''],
      ['TEST LABOR XKS', '1', '', '50.00'],
    ]) {
      await page.getByRole('button', { name: 'Add line' }).click();
      const row = page.locator('#tLines tr').last();
      await row.locator('.d').fill(desc as string);
      await row.locator('.q').fill(qty as string);
      await row.locator('.p').fill(price as string);
      await row.locator('.l').fill(labor as string);
    }

    // 2. Approve & print: saved, InvoMax checked, the first number asked once
    await page.getByRole('button', { name: 'Approve & print' }).click();
    const dlg = page.getByRole('dialog', { name: 'First invoice number: 9000006. Use it?' });
    await expect(dlg).toBeVisible({ timeout: 30_000 });
    expect(context.pages()).toHaveLength(1); // no tab in front of the question: "Use it" opens it
    await expect(dlg.getByLabel('Invoice number')).toHaveValue('9000006');
    await expect(dlg.getByLabel('Invoice number')).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await dlg.getByLabel('Invoice number').fill('9000005'); // at or below InvoMax's highest: refused here first
    await dlg.getByRole('button', { name: 'Use it' }).click();
    await expect(dlg).toContainText('Type 7 digits: 9000006 or higher.');
    await dlg.getByLabel('Invoice number').fill('9000006');

    // 3. the print page in a new tab: the bill and its total (parts 100 + labor 50 + supplies 7.50 + tax 6.45)
    const tab = await printTab(context, () => dlg.getByRole('button', { name: 'Use it' }).click(), '9000006');
    await expect(totalOf(tab)).toContainText('163.95');
    await tab.close();

    // 4. the ticket is filled, and billed by us
    await expect(page.locator('#viewTicket .status')).toHaveText('filled');
    await expect(page.locator('#viewTicket')).toContainText('Billed as #9000006');
    const id = Number(/#(\d+)/.exec((await page.locator('#title').textContent()) ?? '')?.[1]);
    const t = (await (await context.request.get(`/api/tickets/${id}`)).json()) as { status: string };
    expect(t.status).toBe('filled');

    // Reprint: the same bill again
    const again = await printTab(context, () => page.getByRole('button', { name: 'Reprint' }).click(), '9000006');
    await expect(totalOf(again)).toContainText('163.95');
    await again.close();

    // 5. Fix bill: labor 60.00, Save & reprint -> the same number, the new total (100 + 60 + 8.00 + 6.48)
    await page.getByRole('button', { name: 'Fix bill' }).click();
    await expect(page.getByRole('button', { name: 'Save & reprint' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve & print' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fix bill' })).toHaveCount(0);
    await page.locator('#tLines tr').last().locator('.l').fill('60.00');
    const fixed = await printTab(context, () => page.getByRole('button', { name: 'Save & reprint' }).click(), '9000006');
    await expect(totalOf(fixed)).toContainText('174.48');
    await fixed.close();
    await expect(page.locator('#viewTicket')).toContainText('Billed as #9000006');
    await expect(page.getByRole('button', { name: 'Fix bill' })).toBeVisible();

    // Bill history's Fix bill link: /admin#fix=<no> opens it the same way
    await page.goto('/admin#fix=9000006');
    await expect(page.getByRole('button', { name: 'Save & reprint' })).toBeVisible();
    await expect(page.locator('#tLines tr').last().locator('.l')).toHaveValue('60.00');

    // 6. Bill history marks it Revised
    await page.goto('/bills?tag=XKS-4827');
    await page.getByRole('button', { name: 'Open bill 9000006' }).click();
    await expect(page.getByText(/Revised \d{4}-\d\d-\d\d/)).toBeVisible();
    await context.close();
  });

  test('a ticket already billed says so and offers Reprint; no tab is left open', async ({ browser }) => {
    const context = await ownContext(browser);
    const page = await context.newPage();
    const t = await createTicket(context.request, {
      ...car(),
      mechanic: 'Al Fixit',
      lines: [{ desc: 'TEST PART XKS', qty: 1, price: 10, labor: 0 }],
    });
    await page.route('**/api/tickets/*/bill', (route) =>
      route.fulfill({ status: 409, json: { error: 'already billed as #9000006', invoice_no: '9000006' } }),
    );
    await page.goto('/admin');
    await page.locator('#board .card', { hasText: t.last }).click();
    await expect(page.locator('#title')).toHaveText(`Ticket #${t.id}`);
    await page.getByRole('button', { name: 'Approve & print' }).click();
    await expect(page.locator('#tErr')).toContainText('Already billed as #9000006');
    await expect.poll(() => context.pages().filter((p) => !p.isClosed()).length).toBe(1);
    await printTab(context, () => page.getByRole('button', { name: 'Reprint' }).click(), '9000006');
    await context.close();
  });

  /** A waiting ticket that can be billed (mechanic, one line), made through the API. */
  const billable = (context: BrowserContext) =>
    createTicket(context.request, { ...car(), mechanic: 'Al Fixit', lines: [{ desc: 'TEST PART XKS', qty: 1, price: 10, labor: 5 }] });

  /** The number in "Billed as #N" on the open ticket. */
  async function billedAs(page: Page): Promise<string> {
    await expect(page.locator('#viewTicket')).toContainText(/Billed as #\d{7}/);
    return /Billed as #(\d{7})/.exec((await page.locator('#viewTicket').textContent()) ?? '')?.[1] ?? '';
  }

  test('an approved ticket (Ready for InvoMax) gets Approve & print beside Mark filled, and bills', async ({ browser }) => {
    const context = await ownContext(browser);
    const t = await moveTicket(context.request, await billable(context), 'approved');
    const page = await context.newPage();
    await page.goto('/admin');
    await page.locator('#board .col.approved .card', { hasText: t.last }).click();
    await expect(page.locator('#title')).toHaveText(`Ticket #${t.id}`);
    await expect(page.getByRole('button', { name: 'Mark filled' })).toBeVisible();
    const tab = await printTab(context, () => page.getByRole('button', { name: 'Approve & print' }).click(), ANY_NO);
    const no = await billedAs(page);
    await expect(tab.locator('.copy').first().getByText(`INVOICE : ${no}`)).toBeVisible();
    await expect(page.locator('#viewTicket .status')).toHaveText('filled');
    await context.close();
  });

  test('a ticket billed on another device shows Reprint and Fix bill here, from the server', async ({ browser }) => {
    const other = await ownContext(browser);
    const t = await billable(other);
    const context = await ownContext(browser); // a fresh browser: nothing about the bill in its memory
    const page = await context.newPage();
    await page.goto('/admin');
    await page.locator('#board .card', { hasText: t.last }).click();
    await expect(page.locator('#title')).toHaveText(`Ticket #${t.id}`);
    const r = await other.request.post(`/api/tickets/${t.id}/bill`, { data: { version: t.version } });
    expect(r.status(), await r.text()).toBe(201);
    const { invoice_no: no } = (await r.json()) as { invoice_no: string };
    // the page's poll sees it filled; the bill number comes from GET /api/own-bills/by-ticket/:id
    await expect(page.locator('#viewTicket .status')).toHaveText('filled', { timeout: 20_000 });
    await expect(page.locator('#viewTicket')).toContainText(`Billed as #${no}`);
    await expect(page.getByRole('button', { name: 'Fix bill' })).toBeVisible();
    await printTab(context, () => page.getByRole('button', { name: 'Reprint' }).click(), no);
    await other.close();
    await context.close();
  });

  test('the bill made but its reply lost: the page asks the server and shows the bill', async ({ browser }) => {
    const context = await ownContext(browser);
    const t = await billable(context);
    const page = await context.newPage();
    await page.route('**/api/tickets/*/bill', async (route) => {
      await route.fetch(); // the server bills it ...
      await route.abort('connectionreset'); // ... and the reply never arrives
    });
    await page.goto('/admin');
    await page.locator('#board .card', { hasText: t.last }).click();
    await expect(page.locator('#title')).toHaveText(`Ticket #${t.id}`);
    await printTab(context, () => page.getByRole('button', { name: 'Approve & print' }).click(), ANY_NO);
    await billedAs(page);
    await expect(page.locator('#tErr')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Reprint' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fix bill' })).toBeVisible();
    await context.close();
  });
});

test('own billing off: no Approve & print, Send to InvoMax stays, #fix= does nothing', async ({ page }) => {
  await signIn(page.context().request, 'admin', ADMIN);
  const t = await createTicket(page.context().request, { ...car() });
  await page.goto('/admin#fix=9000001');
  await expect(page.locator('#linkBills')).toBeVisible(); // the upkeep status has loaded
  await page.waitForTimeout(500);
  await expect(page.locator('#viewBoard')).toBeVisible();
  await expect(page.locator('#flash')).toBeHidden();
  await page.locator('#board .card', { hasText: t.last }).click();
  await expect(page.locator('#title')).toHaveText(`Ticket #${t.id}`);
  await expect(page.getByRole('button', { name: 'Send to InvoMax' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve & print' })).toHaveCount(0);
});
