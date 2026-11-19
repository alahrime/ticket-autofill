// The mechanic's phone page: deleting their own job, a job the desk removed (410), and checking a customer in.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { car, createTicket, moveTicket, scrollsSideways, signedInPage, signIn } from './shop';

test('tech delete and 410', async ({ browser, page }) => {
  // the desk checks a car in; Al accepts it
  await signIn(page.context().request, 'admin', 'Owner Test');
  const waiting = await createTicket(page.context().request, car());
  const phone1 = await signedInPage(() => browser.newContext(), 'mechanic', 'Al Fixit');
  const mine = await moveTicket(phone1.context.request, waiting, 'working');
  const phone2 = await signedInPage(() => browser.newContext(), 'mechanic', 'Al Fixit');
  for (const { page: p } of [phone1, phone2]) {
    await p.goto(`/tech#t${mine.id}`);
    await expect(p.locator('#jcust')).toBeVisible();
  }
  // a draft typed on the second phone that never reached the shop, and another job's draft that must stay
  const me = (await (await phone2.context.request.get('/api/me')).json()) as { id: number };
  const key = `tech.draft.${me.id}.`; // the page's draft key: tech.draft.<user id>.<ticket id>
  await phone2.page.evaluate(
    ([prefix, id]) => {
      localStorage.setItem(prefix + id, JSON.stringify({ notes: 'typed here', _base: { notes: '' } }));
      localStorage.setItem(prefix + '999999', JSON.stringify({ notes: 'another job', _base: { notes: '' } }));
    },
    [key, String(mine.id)],
  );

  const p1 = phone1.page;
  const del = p1.getByRole('button', { name: 'Delete job' });
  await del.click();
  const dlg = p1.getByRole('dialog');
  await expect(dlg).toContainText(`Delete ticket #${mine.id} — ${mine.first} ${mine.last}, ${mine.plate}, $0.00?`);
  await expect(dlg).toContainText('The desk can restore it.'); // no deposits on the phone, so no 14-day promise
  await expect(dlg).not.toContainText('deposits'); // a mechanic never sees them
  await expect(dlg.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect(p1.locator('#msg')).toContainText('Deleted. The desk can restore it.');
  await expect(p1.locator('#home')).toBeVisible();
  await expect(p1.locator('#home')).not.toContainText(mine.last);

  // the other phone still has the job open: its poll finds the job removed
  const p2 = phone2.page;
  await expect(p2.locator('#msg')).toContainText('This ticket was removed by the desk.');
  await expect(p2.locator('#home')).toBeVisible();
  await expect(p2.locator('#home')).not.toContainText(mine.last);
  const left = await p2.evaluate((prefix) => Object.keys(localStorage).filter((k) => k.startsWith(prefix)), key);
  expect(left).toEqual([key + '999999']); // that job's draft only
  await phone1.context.close();
  await phone2.context.close();
});

test('tech new customer', async ({ browser }) => {
  const { context, page } = await signedInPage(() => browser.newContext(), 'mechanic', 'Bo Wrench');
  await page.getByRole('button', { name: 'New customer' }).click();
  const c = car();
  const form = page.locator('#custform');
  await form.getByLabel('First name').fill(c['first'] as string);
  await form.getByLabel('Last name').fill(c['last'] as string);
  await form.getByLabel('Phone').fill(c['phone'] as string);
  await form.getByLabel('Year').fill(c['year'] as string);
  await form.getByLabel('Make').fill(c['make'] as string);
  await form.getByLabel('Model').fill(c['model'] as string);
  await form.getByLabel('Plate').fill(c['plate'] as string);
  await form.getByLabel('What the customer wants done').fill(c['request'] as string);
  await expect(form.getByLabel('Phone')).toHaveAttribute('inputmode', 'tel');
  await expect(page.locator('#make-list option[value="CADILLAC"]')).toHaveCount(1); // /api/vehicles, as the desk

  // A poll that started before the create answers after it, with the board from before (a fresh 200, not a
  // 304). While it is out, the page's own poll() after the create is skipped: the card must survive it.
  let created!: () => void;
  const afterCreate = new Promise<void>((ok) => (created = ok));
  let stale = false;
  let held = false;
  await page.route(/\/api\/tickets\?status=/, async (route) => {
    if (held) return route.continue();
    held = true;
    const headers = { ...route.request().headers() };
    delete headers['if-none-match'];
    const before = await route.fetch({ headers }); // the board as it was when this poll started
    await afterCreate;
    await route.fulfill({ response: before });
    stale = true;
  });
  await page.waitForRequest(/\/api\/tickets\?status=/); // that poll is out now
  await form.getByRole('button', { name: 'Check in' }).click();
  await expect(page.locator('#msg')).toContainText('Checked in');
  await expect(form).toBeHidden();
  const card = page.locator('#waiting .card', { hasText: c['request'] as string });
  await expect(card).toHaveCount(1, { timeout: 500 }); // right away, not on a later poll
  created();
  await expect.poll(() => stale).toBe(true);
  await page.waitForTimeout(100); // the stale reply has been rendered
  await expect(card).toHaveCount(1, { timeout: 500 }); // the old board didn't drop it
  await expect(card.getByRole('button', { name: 'Accept' })).toBeVisible();
  await page.unroute(/\/api\/tickets\?status=/);
  // the desk sees it waiting, unassigned
  const r = await context.request.get('/api/tickets?status=waiting');
  const t = ((await r.json()) as { tickets: Array<Record<string, string>> }).tickets.find(
    (x) => x['last'] === (c['last'] as string).toUpperCase(),
  );
  expect([t?.['status'], t?.['mechanic']]).toEqual(['waiting', '']);
  await context.close();
});

test('tech sign-out clears a half-typed customer', async ({ browser }) => {
  const { context, page } = await signedInPage(() => browser.newContext(), 'mechanic', 'Bo Wrench');
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.locator('#custform').getByLabel('Last name').fill('Typedhalfway');
  // what is still on the page as it leaves, kept in this tab's sessionStorage across the navigation
  await page.evaluate(() =>
    window.addEventListener('pagehide', () => {
      const f = document.getElementById('custform') as HTMLFormElement;
      const last = (f.elements.namedItem('last') as HTMLInputElement).value;
      sessionStorage.setItem('left', JSON.stringify({ last, hidden: f.hidden }));
    }),
  );
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('input[name="secret"]')).toBeVisible(); // signed out: the sign-in page
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem('left'))) ?? 'null')).toEqual({
    last: '',
    hidden: true,
  });
  await context.close();
});

test('tech new customer: a 400 with keys the form has not', async ({ browser }) => {
  const { context, page } = await signedInPage(() => browser.newContext(), 'mechanic', 'Bo Wrench');
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.locator('#custform').getByLabel('First name').fill('Jane');
  const errors = { first: 'first is required', 'x"] .y': 'odd key', lines: 'not yours' };
  await page.route('**/api/tickets', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad', errors }) })
      : route.fallback(),
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.getByRole('button', { name: 'Check in' }).click();
  await expect(page.locator('#custform .ferr[data-for="first"]')).toHaveText('First is required');
  await expect(page.locator('#cerr')).toHaveText('Odd key\nNot yours');
  expect(pageErrors).toEqual([]);
  await context.close();
});

test('tech new customer: a retry is the same check-in', async ({ browser }) => {
  const { context, page } = await signedInPage(() => browser.newContext(), 'mechanic', 'Bo Wrench');
  await page.getByRole('button', { name: 'New customer' }).click();
  const c = car();
  for (const [label, k] of [
    ['First name', 'first'],
    ['Last name', 'last'],
    ['Phone', 'phone'],
    ['Year', 'year'],
    ['Make', 'make'],
    ['Model', 'model'],
  ])
    await page.locator('#custform').getByLabel(label as string).fill(c[k as string] as string);
  // the first reply is lost on the way back: the ticket is made, the phone sees a dropped connection
  const tokens: string[] = [];
  let first = true;
  await page.route('**/api/tickets', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    tokens.push((route.request().postDataJSON() as { token: string }).token);
    if (!first) return route.continue();
    first = false;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: 'Check in' }).click();
  await expect(page.locator('#cerr')).toContainText("Can't reach the shop");
  await page.getByRole('button', { name: 'Check in' }).click();
  await expect(page.locator('#msg')).toContainText('Checked in');
  expect(tokens).toHaveLength(2);
  expect(tokens[0]).toMatch(/^[0-9a-f]{32}$/);
  expect(tokens[1]).toBe(tokens[0]);
  const r = await context.request.get('/api/tickets?status=waiting');
  const all = ((await r.json()) as { tickets: Array<Record<string, string>> }).tickets;
  expect(all.filter((x) => x['last'] === (c['last'] as string).toUpperCase())).toHaveLength(1);
  await context.close();
});

test('tech page at 375 px: no sideways scroll, form and modal open', async ({ browser }) => {
  const { context, page } = await signedInPage(
    () => browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true }),
    'mechanic',
    'Al Fixit',
  );
  await page.getByRole('button', { name: 'New customer' }).click();
  await expect(page.locator('#custform')).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
  await page.getByRole('button', { name: 'Cancel' }).click();

  const desk = await browser.newContext();
  await signIn(desk.request, 'admin', 'Owner Test');
  const t = await moveTicket(context.request, await createTicket(desk.request, car()), 'working');
  await page.goto(`/tech#t${t.id}`);
  await page.getByRole('button', { name: 'Delete job' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
  const result = await new AxeBuilder({ page }).include('#deldlg').analyze();
  expect(result.violations).toEqual([]);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Delete job' })).toBeFocused();
  await desk.close();
  await context.close();
});

test('tech asks about an open job that left the list once, not on every poll', async ({ browser, page }) => {
  await signIn(page.context().request, 'admin', 'Owner Test');
  const desk = page.context().request;
  const waiting = await createTicket(desk, { ...car(), lines: [{ desc: 'diag', labor: 60 }] }); // finishing needs a line
  const phone = await signedInPage(() => browser.newContext(), 'mechanic', 'Al Fixit');
  let mine = await moveTicket(phone.context.request, waiting, 'working');
  const p = phone.page;
  await p.goto(`/tech#t${mine.id}`);
  await expect(p.locator('#jcust')).toBeVisible();

  let asked = 0; // GET /api/tickets/<id>: the probe of the open job
  let polls = 0; // GET /api/tickets?status=...: the 4 s list poll
  p.on('request', (r) => {
    if (r.method() !== 'GET') return;
    if (new RegExp(`/api/tickets/${mine.id}$`).test(r.url())) asked += 1;
    else if (/\/api\/tickets\?status=/.test(r.url())) polls += 1;
  });
  const pollsFrom = async (n: number): Promise<void> => {
    const from = polls;
    await expect.poll(() => polls - from, { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
  };

  mine = await moveTicket(phone.context.request, mine, 'review'); // Finish job elsewhere: off this phone's list
  await pollsFrom(3);
  expect(asked).toBe(1); // asked once, then left alone
  await expect(p.locator('#banner')).toBeVisible();

  const back = await desk.post(`/api/tickets/${mine.id}/move`, { data: { version: mine.version, to: 'working', note: 'check the pads' } });
  expect(back.status(), await back.text()).toBe(200);
  mine = (await back.json()) as typeof mine; // sent back: on the list again
  await pollsFrom(1);
  mine = await moveTicket(phone.context.request, mine, 'review'); // and off again: one more question
  await pollsFrom(3);
  expect(asked).toBe(2);
  await phone.context.close();
});