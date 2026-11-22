import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILL, type Call, callsTo, mockFetch, renderWithClient, ROW } from '../test-utils';
import { BillHistory } from './BillHistory';

const list = (rows = [ROW], total = rows.length, page = 1) => ({ rows, total, page, per_page: 50 });

let calls: Call[];
let rows = [ROW];
let total = 1;

beforeEach(() => {
  window.history.replaceState(null, '', '/bills');
  rows = [ROW];
  total = 1;
  calls = mockFetch((method, url) => {
    if (method !== 'GET') return undefined;
    if (url.startsWith('/api/invoices?') || url === '/api/invoices') {
      const page = Number(new URLSearchParams(url.split('?')[1] ?? '').get('page') ?? '1');
      return [200, list(rows, total, page)];
    }
    if (url === '/api/invoices/im9000001') return [200, BILL];
    if (url === '/api/needs-bill') return [200, { tickets: [] }];
    return undefined;
  });
});
afterEach(() => vi.unstubAllGlobals());

const invoiceCalls = (): string[] => callsTo(calls, 'GET', '/api/invoices').map((c) => c.url);

describe('BillHistory', () => {
  it('shows the results table with real headers', async () => {
    renderWithClient(<BillHistory />);
    const table = await screen.findByRole('table', { name: /bills/i });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Date', 'Invoice', 'Name', 'Vehicle', 'Plate', 'Total']);
    const row = await within(table).findByRole('row', { name: /9000001/ });
    expect(row).toHaveTextContent('2026-11-20');
    expect(row).toHaveTextContent('JANE TESTCASE');
    expect(row).toHaveTextContent('2019 CADILLAC XT5');
    expect(row).toHaveTextContent('XKS-4827');
    expect(row).toHaveTextContent('$228.33');
  });

  it('puts the filters in the URL and in the request', async () => {
    const user = userEvent.setup();
    renderWithClient(<BillHistory />);
    await screen.findByRole('row', { name: /9000001/ });
    await user.type(screen.getByLabelText('Tag'), 'XKS-4827');
    await user.type(screen.getByLabelText('Name'), 'jane');
    await user.type(screen.getByLabelText('Phone'), '555');
    await user.type(screen.getByLabelText('VIN'), '1TEST');
    await user.type(screen.getByLabelText('From'), '2026-11-01');
    await user.type(screen.getByLabelText('To'), '2026-11-30');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const want = 'tag=XKS-4827&name=jane&phone=555&vin=1TEST&from=2026-11-01&to=2026-11-30';
    await waitFor(() => expect(window.location.search).toBe(`?${want}`));
    await waitFor(() => expect(invoiceCalls()).toContain(`/api/invoices?${want}`));
  });

  it('starts from the filters in the URL', async () => {
    window.history.replaceState(null, '', '/bills?tag=xks&page=2');
    renderWithClient(<BillHistory />);
    expect(screen.getByLabelText('Tag')).toHaveValue('xks');
    await waitFor(() => expect(invoiceCalls()).toContain('/api/invoices?tag=xks&page=2'));
  });

  it('says the VIN filter searches our tickets only', () => {
    renderWithClient(<BillHistory />);
    expect(screen.getByLabelText('VIN')).toHaveAccessibleDescription(/our tickets only/i);
  });

  it('clears the filters', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/bills?tag=xks&name=jane');
    renderWithClient(<BillHistory />);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.getByLabelText('Tag')).toHaveValue('');
  });

  it('shows "No bills match" for an empty result', async () => {
    rows = [];
    total = 0;
    renderWithClient(<BillHistory />);
    expect(await screen.findByText(/No bills match/)).toBeInTheDocument();
  });

  it('pages with Previous and Next, keeping the filters', async () => {
    const user = userEvent.setup();
    total = 120;
    window.history.replaceState(null, '', '/bills?tag=xks');
    renderWithClient(<BillHistory />);
    await screen.findByText(/Page 1 of 3/);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(window.location.search).toBe('?tag=xks&page=2'));
    await screen.findByText(/Page 2 of 3/);
    expect(invoiceCalls()).toContain('/api/invoices?tag=xks&page=2');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(window.location.search).toBe('?tag=xks'));
  });

  it('a new search goes back to page 1', async () => {
    const user = userEvent.setup();
    total = 120;
    window.history.replaceState(null, '', '/bills?page=3');
    renderWithClient(<BillHistory />);
    await user.type(screen.getByLabelText('Name'), 'jane');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(window.location.search).toBe('?name=jane'));
  });

  it('opens a row in the detail, by click or keyboard, and keeps it in the URL', async () => {
    const user = userEvent.setup();
    renderWithClient(<BillHistory />);
    const open = await screen.findByRole('button', { name: 'Open bill 9000001' });
    open.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.location.search).toBe('?open=im9000001'));
    const detail = await screen.findByRole('region', { name: /InvoMax bill #9000001/ });
    expect(within(detail).getByRole('heading', { name: 'Our ticket' })).toBeInTheDocument();
    expect(callsTo(calls, 'GET', '/api/invoices/im9000001')).toHaveLength(1);
  });

  it('a whole row opens on click too', async () => {
    const user = userEvent.setup();
    renderWithClient(<BillHistory />);
    await user.click(await screen.findByText('JANE TESTCASE'));
    await screen.findByRole('region', { name: /InvoMax bill #9000001/ });
  });

  it('shows the needs-bill section at the top', async () => {
    renderWithClient(<BillHistory />);
    expect(await screen.findByRole('region', { name: /need their bill/i })).toHaveAttribute('id', 'needs');
  });

  it('shows the server refusing a filter', async () => {
    calls = mockFetch((method, url) => {
      if (url.startsWith('/api/invoices?')) return [400, { error: 'phone must have a digit' }];
      if (url === '/api/needs-bill') return [200, { tickets: [] }];
      if (url === '/api/invoices') return [200, list()];
      return undefined;
    });
    window.history.replaceState(null, '', '/bills?phone=x');
    renderWithClient(<BillHistory />);
    expect(await screen.findByRole('alert')).toHaveTextContent('phone must have a digit');
  });
});
