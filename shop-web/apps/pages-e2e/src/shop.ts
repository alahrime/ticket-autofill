// The test shop: where it listens, its made-up accounts, and seeding tickets through the API.
import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

export const PORT = 18081;
export const BASE = `http://127.0.0.1:${PORT}`;
export const ADMIN = 'Owner Test';
export const PASSWORD = 'made-up-pass-1';
export const PINS: Record<string, string> = { 'Al Fixit': '246810', 'Bo Wrench': '135790' };

export type Ticket = {
  id: number;
  version: number;
  status: string;
  first: string;
  last: string;
  plate: string;
  mechanic: string;
  [k: string]: unknown;
};

let seq = 0;
/** A made-up customer, unique in this run, so each test finds its own card. */
export function car(): Record<string, string> {
  seq += 1;
  const n = String(Date.now() % 100000).padStart(5, '0') + seq;
  return {
    first: 'Jane',
    last: `Testcase${n}`,
    phone: '555-010-0100',
    year: '2019',
    make: 'Cadillac',
    model: 'XT5',
    plate: `TST-${n.slice(-4)}`,
    request: `brakes squeak ${n}`, // the phone's waiting card shows this, not the last name
  };
}

/** Signs `request` (a browser context's, so the page shares the cookie) in. */
export async function signIn(request: APIRequestContext, role: 'admin' | 'mechanic', name: string): Promise<void> {
  const admin = role === 'admin';
  const r = await request.post(admin ? '/login/admin' : '/login/tech', {
    form: { name, secret: admin ? PASSWORD : (PINS[name] as string) },
    maxRedirects: 0,
  });
  expect(r.status(), `sign-in as ${name}`).toBe(303);
}

async function json<T>(r: Awaited<ReturnType<APIRequestContext['post']>>): Promise<T> {
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as T;
}

export async function createTicket(request: APIRequestContext, body: Record<string, unknown>): Promise<Ticket> {
  return json<Ticket>(await request.post('/api/tickets', { data: body }));
}

export async function moveTicket(request: APIRequestContext, t: Ticket, to: string): Promise<Ticket> {
  return json<Ticket>(await request.post(`/api/tickets/${t.id}/move`, { data: { version: t.version, to } }));
}

/** A new browser context signed in as `name`, on its page. */
export async function signedInPage(
  newContext: () => Promise<BrowserContext>,
  role: 'admin' | 'mechanic',
  name: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newContext();
  await signIn(context.request, role, name);
  const page = await context.newPage();
  await page.goto(role === 'admin' ? '/admin' : '/tech');
  return { context, page };
}

/** True when the page is wider than its window (a sideways scroll at phone width). */
export function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}
