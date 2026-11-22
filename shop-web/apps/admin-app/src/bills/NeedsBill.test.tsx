import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILL, type Call, callsTo, mockFetch, NEEDS, renderWithClient } from '../test-utils';
import { NeedsBill } from './NeedsBill';

let calls: Call[];
let tickets = [NEEDS];
let answer: [number, unknown] = [200, { ...BILL, key: 'im9000002' }];

beforeEach(() => {
  tickets = [NEEDS];
  answer = [200, { ...BILL, key: 'im9000002' }];
  calls = mockFetch((method, url) => {
    if (method === 'GET' && url === '/api/needs-bill') return [200, { tickets }];
    if (method === 'GET' && url.startsWith('/api/invoices')) return [200, { rows: [], total: 0, page: 1, per_page: 50 }];
    if (method === 'POST') {
      if (answer[0] === 200) tickets = [];
      return answer;
    }
    return undefined;
  });
});
afterEach(() => vi.unstubAllGlobals());

const card = () => screen.findByRole('group', { name: /Ticket #14/ });

describe('NeedsBill', () => {
  it('lists each ticket with its candidate bills', async () => {
    renderWithClient(<NeedsBill />);
    const c = await card();
    expect(c).toHaveTextContent('Jane Testcase');
    expect(c).toHaveTextContent('XKS-4827');
    expect(c).toHaveTextContent('$150.00');
    expect(c).toHaveTextContent('9000002');
    expect(c).toHaveTextContent('$160.50');
    expect(c).toHaveTextContent('same plate');
    expect(c).toHaveTextContent('same phone');
  });

  it('Link calls the mutation and refreshes the list', async () => {
    const user = userEvent.setup();
    renderWithClient(<NeedsBill />);
    const c = await card();
    await user.click(within(c).getByRole('button', { name: 'Link bill 9000002 to ticket #14' }));
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/invoices/t14/link')).toHaveLength(1));
    expect(callsTo(calls, 'POST', '/api/invoices/t14/link')[0]?.body).toEqual({ invoice_no: '9000002', version: null });
    await waitFor(() => expect(callsTo(calls, 'GET', '/api/needs-bill').length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByRole('group', { name: /Ticket #14/ })).not.toBeInTheDocument());
    expect(await screen.findByRole('status')).toHaveTextContent('Linked ticket #14 to bill 9000002');
  });

  it('None of these marks the ticket as having no InvoMax bill', async () => {
    const user = userEvent.setup();
    renderWithClient(<NeedsBill />);
    await user.click(within(await card()).getByRole('button', { name: 'None of these' }));
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/invoices/t14/none')).toHaveLength(1));
    expect(callsTo(calls, 'POST', '/api/invoices/t14/none')[0]?.body).toEqual({ version: null });
  });

  it('links by a typed bill number, for a bill the list does not offer', async () => {
    const user = userEvent.setup();
    renderWithClient(<NeedsBill />);
    const c = await card();
    await user.type(within(c).getByLabelText('Link by bill number'), '9000007');
    await user.click(within(c).getByRole('button', { name: 'Link bill' }));
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/invoices/t14/link')).toHaveLength(1));
    expect(callsTo(calls, 'POST', '/api/invoices/t14/link')[0]?.body).toEqual({ invoice_no: '9000007', version: null });
  });

  it('shows a refusal and fetches the list again', async () => {
    const user = userEvent.setup();
    answer = [409, { error: 'that bill is linked to ticket 9' }];
    renderWithClient(<NeedsBill />);
    await user.click(within(await card()).getByRole('button', { name: 'Link bill 9000002 to ticket #14' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('that bill is linked to ticket 9');
    await waitFor(() => expect(callsTo(calls, 'GET', '/api/needs-bill').length).toBeGreaterThan(1));
  });

  it('a ticket with no candidates can still be linked by number', async () => {
    tickets = [{ ...NEEDS, candidates: [] }];
    renderWithClient(<NeedsBill />);
    const c = await card();
    expect(c).toHaveTextContent('No likely bills');
    expect(within(c).getByLabelText('Link by bill number')).toBeInTheDocument();
  });

  it('says so when every ticket has its bill', async () => {
    tickets = [];
    renderWithClient(<NeedsBill />);
    expect(await screen.findByText(/Every filled ticket has its bill/)).toBeInTheDocument();
  });
});
