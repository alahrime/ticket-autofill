// Test helpers: a fetch that answers like the shop API (and records each call), and render() inside a fresh
// QueryClient. Every name, phone, plate and bill number here is made up.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { Bill, BillRow, NeedsBill } from '@shop/api-client';

export type Call = { method: string; url: string; body: unknown };
export type Answer = [number, unknown] | undefined;
export type Handler = (method: string, url: string, body: unknown) => Answer;

/** Replaces fetch: each call goes to `handler` (no answer: 404) and is recorded in the returned list. */
export function mockFetch(handler: Handler): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, body });
      const [status, json] = handler(method, url, body) ?? [404, { error: 'not found' }];
      return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

export function renderWithClient(ui: ReactElement): RenderResult & { client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>), client };
}

export const ROW: BillRow = {
  key: 'im9000001',
  date: '2026-11-20',
  invoice_no: '9000001',
  ticket_id: 12,
  name: 'JANE TESTCASE',
  phone: '5550100000',
  vehicle: '2019 CADILLAC XT5',
  plate: 'XKS-4827',
  total: 228.33,
};

export const BILL: Bill = {
  key: 'im9000001',
  customer: { name: 'Jane Testcase', phone: '5550100000', vehicle: '2019 Cadillac XT5', plate: 'XKS-4827' },
  before: {
    ticket_id: 12,
    lines: [{ desc: 'BRAKE PADS', qty: 1, price: 100, labor: 50, code: '', id: 1 }],
    parts: 100,
    labor: 50,
    subtotal: 150,
  },
  after: {
    invoice_no: '9000001',
    date: '2026-11-20',
    parts: 120,
    labor: 90,
    supplies: 10.5,
    discount: 0,
    deposit: 0,
    tax: 7.83,
    total: 228.33,
    balance: 228.33,
    lines: [{ code: 'LABOR', description: 'REPLACE FRONT PADS', kind: 'labor', qty: 1, unit: 90, amount: 90 }],
    source: 'invomax',
    gone: false,
  },
  link: { source: 'invomax', linked_by: 'auto', linked_at: '2026-11-21T09:00:00', version: 3 },
  difference: -60,
};

export const NEEDS: NeedsBill = {
  ticket_id: 14,
  name: 'Jane Testcase',
  vehicle: '2019 Cadillac XT5',
  plate: 'XKS-4827',
  filled: '2026-11-21',
  subtotal: 150,
  candidates: [
    { invoice_no: '9000002', date: '2026-11-19', name: 'JANE DOE', plate: 'XKS-4827', total: 160.5, why: 'plate' },
    { invoice_no: '9000005', date: '2026-11-10', name: 'JANE DOE', plate: 'XKS-4800', total: 99, why: 'phone' },
  ],
};

/** The path and query of a recorded call (fetch gets them relative, as same-origin URLs). */
export const callsTo = (calls: Call[], method: string, path: string): Call[] =>
  calls.filter((c) => c.method === method && c.url.split('?')[0] === path);
