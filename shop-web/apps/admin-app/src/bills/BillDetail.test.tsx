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

const OURS: Bill = {
  ...BILL,
  key: 't12',
  after: { ...(BILL.after as NonNullable<Bill['after']>), invoice_no: '9000010', source: 'ours' },
  link: { source: 'ours', linked_by: 'admin#1', linked_at: '2026-11-23T14:22:05', version: 2 },
  difference: 0,
  own: { invoice_no: '9000010', revisions: 1, revised_at: null, revised_by: null },
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

  it('our bill: Reprint and Fix bill links, no link changes, no revised note with one revision', async () => {
    api(OURS);
    show(OURS);
    const reprint = await screen.findByRole('link', { name: 'Reprint' });
    expect(reprint).toHaveAttribute('href', '/bills/9000010/print');
    expect(screen.getByRole('link', { name: 'Fix bill' })).toHaveAttribute('href', '/admin#fix=9000010');
    expect(screen.getByRole('region', { name: 'Our bill' })).toHaveTextContent('Bill #9000010');
    expect(screen.queryByText(/Revised/)).not.toBeInTheDocument();
    for (const name of ['Unlink', 'Type the final bill']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Link by bill number')).not.toBeInTheDocument();
  });

  it('our bill with no saved copy says so: no Reprint, no link controls', async () => {
    const lost: Bill = { ...OURS, own: { invoice_no: '9000010', revisions: 0, revised_at: null, revised_by: null } };
    api(lost);
    show(lost);
    expect(await screen.findByText("This bill's saved copy is missing; it can't be reprinted.")).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reprint' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Link by bill number')).not.toBeInTheDocument();
    // even if own were missing, an ours final never offers the link controls
    const bare: Bill = { ...lost, own: null };
    api(bare);
    show(bare);
    await screen.findAllByRole('region', { name: 'Our bill' });
    expect(screen.queryByRole('button', { name: 'Type the final bill' })).not.toBeInTheDocument();
  });

  it('our bill fixed: says when and by whom', async () => {
    const fixed: Bill = { ...OURS, own: { invoice_no: '9000010', revisions: 2, revised_at: '2026-11-24T09:05:00', revised_by: 'admin#2' } };
    api(fixed);
    show(fixed);
    expect(await screen.findByText('Revised 2026-11-24 by admin#2')).toBeInTheDocument();
  });

  it('an InvoMax bill has no Reprint or Fix bill', async () => {
    api(BILL);
    show(BILL);
    await screen.findByRole('region', { name: 'Our ticket' });
    expect(screen.queryByRole('link', { name: 'Reprint' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Fix bill' })).not.toBeInTheDocument();
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
