import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bill } from '@shop/api-client';
import { BILL, type Call, callsTo, mockFetch, renderWithClient } from '../test-utils';
import { BillDetail } from './BillDetail';

afterEach(() => vi.unstubAllGlobals());

/** The API holding `bill` at its key (and at t<ticket>); POSTs answer with `after` (else 409 when it says so). */
function api(bill: Bill, post: (url: string, body: unknown) => [number, unknown] = () => [200, bill]): Call[] {
  return mockFetch((method, url, body) => {
    if (method === 'GET' && (url === `/api/invoices/${bill.key}` || url === `/api/invoices/t${bill.before?.ticket_id}`))
      return [200, bill];
    if (method === 'POST') return post(url, body);
    return undefined;
  });
}

const show = (bill: Bill, onKeyChange = vi.fn()) => renderWithClient(<BillDetail billKey={bill.key} onKeyChange={onKeyChange} />);

const TICKET_ONLY: Bill = {
  ...BILL,
  key: 't14',
  before: { ...(BILL.before as NonNullable<Bill['before']>), ticket_id: 14 },
  after: null,
  link: null,
  difference: null,
};

describe('BillDetail', () => {
  it('shows both sides, each with its lines and totals', async () => {
    api(BILL);
    show(BILL);
    const ours = await screen.findByRole('region', { name: 'Our ticket' });
    expect(ours).toHaveTextContent('Ticket #12');
    expect(ours).toHaveTextContent('BRAKE PADS');
    expect(within(ours).getByText('Subtotal').nextElementSibling).toHaveTextContent('$150.00');
    const theirs = screen.getByRole('region', { name: 'InvoMax bill' });
    expect(theirs).toHaveTextContent('REPLACE FRONT PADS');
    expect(theirs).toHaveTextContent('Bill #9000001');
    expect(within(theirs).getByText('Supplies').nextElementSibling).toHaveTextContent('$10.50');
    expect(within(theirs).getByText('Tax').nextElementSibling).toHaveTextContent('$7.83');
    expect(within(theirs).getByText('Total').nextElementSibling).toHaveTextContent('$228.33');
    expect(screen.getByText(/Jane Testcase/)).toBeInTheDocument();
    expect(screen.getByText(/Linked automatically/)).toBeInTheDocument();
  });

  it('says how far our subtotal is off, and nothing when it matches', async () => {
    api(BILL);
    const { unmount } = show(BILL);
    expect(await screen.findByText(/Our subtotal differs by \$60\.00/)).toBeInTheDocument();
    unmount();
    const same = { ...BILL, difference: 0 };
    api(same);
    show(same);
    await screen.findByRole('region', { name: 'Our ticket' });
    expect(screen.queryByText(/differs by/)).not.toBeInTheDocument();
  });

  it('"No InvoMax bill yet" without a bill, "No ticket" without a ticket', async () => {
    api(TICKET_ONLY);
    const { unmount } = show(TICKET_ONLY);
    expect(await screen.findByText('No InvoMax bill yet')).toBeInTheDocument();
    unmount();
    const billOnly: Bill = { ...BILL, before: null, link: null, difference: null };
    api(billOnly);
    show(billOnly);
    expect(await screen.findByText('No ticket')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument(); // nothing of ours to change
  });

  it('marks a bill InvoMax no longer has', async () => {
    const gone: Bill = { ...BILL, after: { ...(BILL.after as NonNullable<Bill['after']>), gone: true } };
    api(gone);
    show(gone);
    expect(await screen.findByText('Removed from InvoMax')).toBeInTheDocument();
  });

  it('Unlink sends the link version and shows the bill that comes back', async () => {
    const user = userEvent.setup();
    const onKeyChange = vi.fn();
    const calls = api(BILL, () => [200, TICKET_ONLY]);
    show(BILL, onKeyChange);
    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/invoices/t12/unlink')).toHaveLength(1));
    expect(callsTo(calls, 'POST', '/api/invoices/t12/unlink')[0]?.body).toEqual({ version: 3 });
    await waitFor(() => expect(onKeyChange).toHaveBeenCalledWith('t14'));
  });

  it('a 409 shows "changed on another device" and fetches the bill again', async () => {
    const user = userEvent.setup();
    const calls = api(BILL, () => [409, { error: 'changed on another device' }]);
    show(BILL);
    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed on another device');
    await waitFor(() => expect(callsTo(calls, 'GET', '/api/invoices/im9000001').length).toBeGreaterThan(1));
  });

  it('links a ticket by bill number, with null for no link yet', async () => {
    const user = userEvent.setup();
    const calls = api(TICKET_ONLY);
    show(TICKET_ONLY);
    const box = await screen.findByLabelText('Link by bill number');
    await user.type(box, '9000009');
    await user.click(screen.getByRole('button', { name: 'Link bill' }));
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/invoices/t14/link')).toHaveLength(1));
    expect(callsTo(calls, 'POST', '/api/invoices/t14/link')[0]?.body).toEqual({ invoice_no: '9000009', version: null });
  });

  it('refuses a bill number that is not 1 to 7 digits, without asking the server', async () => {
    const user = userEvent.setup();
    const calls = api(TICKET_ONLY);
    show(TICKET_ONLY);
    await user.type(await screen.findByLabelText('Link by bill number'), '12a');
    await user.click(screen.getByRole('button', { name: 'Link bill' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 to 7 digits');
    expect(callsTo(calls, 'POST', '/api/invoices/t14/link')).toHaveLength(0);
  });

  it('types the final bill and posts it to /final', async () => {
    const user = userEvent.setup();
    const calls = api(TICKET_ONLY);
    show(TICKET_ONLY);
    await user.click(await screen.findByRole('button', { name: 'Type the final bill' }));
    const form = screen.getByRole('form', { name: 'Type the final bill' });
    await user.type(within(form).getByLabelText(/Bill number/), '9000010');
    await user.type(within(form).getByLabelText('Parts'), '120');
    await user.type(within(form).getByLabelText('Labor'), '90');
    await user.type(within(form).getByLabelText('Supplies'), '10.50');
    await user.type(within(form).getByLabelText('Tax'), '7.83');
    await user.type(within(form).getByLabelText('Total'), '228.33');
    await user.click(within(form).getByRole('button', { name: 'Save final bill' }));
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/invoices/t14/final')).toHaveLength(1));
    expect(callsTo(calls, 'POST', '/api/invoices/t14/final')[0]?.body).toEqual({
      invoice_no: '9000010',
      parts: 120,
      labor: 90,
      supplies: 10.5,
      tax: 7.83,
      total: 228.33,
      version: null,
    });
  });

  it('a typed total that is not the sum is refused before posting', async () => {
    const user = userEvent.setup();
    const calls = api(TICKET_ONLY);
    show(TICKET_ONLY);
    await user.click(await screen.findByRole('button', { name: 'Type the final bill' }));
    const form = screen.getByRole('form', { name: 'Type the final bill' });
    for (const [label, v] of [['Parts', '1'], ['Labor', '2'], ['Supplies', '0'], ['Tax', '0'], ['Total', '4']])
      await user.type(within(form).getByLabelText(label as string), v as string);
    await user.click(within(form).getByRole('button', { name: 'Save final bill' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Total must be parts + labor + supplies + tax ($3.00)');
    expect(callsTo(calls, 'POST', '/api/invoices/t14/final')).toHaveLength(0);
  });
});
