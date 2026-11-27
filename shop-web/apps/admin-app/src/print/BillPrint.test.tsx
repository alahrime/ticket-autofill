import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillSnapshot, OwnBill } from '@shop/api-client';
import { mockFetch, renderWithClient } from '../test-utils';
import { BillPrint } from './BillPrint';
import * as text from './billText';
import { ROWS_PER_PAGE } from './paginate';

const SNAPSHOT: BillSnapshot = {
  invoice_no: '9000010',
  revision: 1,
  date: '2026-11-23',
  time: '14:22',
  customer: { first: 'Jane', last: 'Doe', phone: '(555)010-0000' },
  vehicle: { year: '2015', make: 'Make', model: 'Model', plate: 'XKS-4827', vin: 'TESTVIN0000000001', odometer: '123456' },
  mechanic: 'Al Fixit',
  labor: [
    { desc: 'DIAGNOSTIC', amount: 55 },
    { desc: 'Remove & Install: BRAKE PADS', amount: 50 },
  ],
  parts: [{ desc: 'BRAKE PADS', qty: 1, price: 100, total: 100 }],
  amounts: { parts: 100, labor: 105, supplies: 20, tax: 13.2, total: 238.2, deposit: 38.2, balance: 200 },
  shop: { name: 'TEST SHOP', address: ['1 TEST ST', 'TESTVILLE, VA 22000'], phone: '(555)010-0001', hours: 'M-F 8.00 AM TO 5.00 PM' },
};

const own = (bill: BillSnapshot): OwnBill => ({ bill, revisions: [], ticket_id: 7 });

function api(bill: BillSnapshot | number): string[] {
  const urls: string[] = [];
  mockFetch((_m, url) => {
    urls.push(url);
    if (url !== '/api/own-bills/9000010') return undefined;
    return typeof bill === 'number' ? [bill, { error: 'nope' }] : [200, own(bill)];
  });
  return urls;
}

const print = vi.fn();
beforeEach(() => {
  print.mockReset();
  vi.stubGlobal('print', print);
  window.history.replaceState(null, '', '/bills/9000010/print');
});
afterEach(() => vi.unstubAllGlobals());

const show = () => renderWithClient(<BillPrint no="9000010" />);
const copies = () => screen.getAllByRole('region', { name: /^Bill copy/ });
const manyLabor = (n: number) => Array.from({ length: n }, (_, i) => ({ desc: `LABOR LINE ${i + 1}`, amount: 10 }));
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('BillPrint', () => {
  it('prints the header, lines and totals of the snapshot, twice', async () => {
    api(SNAPSHOT);
    show();
    await screen.findAllByText('INVOICE : 9000010');
    expect(copies()).toHaveLength(2);
    for (const copy of copies()) {
      const c = within(copy);
      const value = (label: string) => c.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
      expect(c.getByText('TEST SHOP')).toBeInTheDocument();
      expect(c.getByText('1 TEST ST | TESTVILLE, VA 22000')).toBeInTheDocument();
      expect(c.getByText('(555) 010-0001')).toBeInTheDocument(); // the shop's phone, spaced
      expect(c.getByText('M-F 8.00 AM TO 5.00 PM')).toBeInTheDocument();
      expect(value('Name')).toBe('JANE DOE');
      expect(value('Phone')).toBe('(555) 010-0000');
      expect(value('Year / Make / Model')).toBe('2015 Make Model');
      expect(value('License')).toBe('XKS-4827');
      expect(value('Mechanic')).toBe('Al Fixit');
      expect(value('Odometer')).toBe('123456');
      expect(value('VIN')).toBe('TESTVIN0000000001');
      expect(c.getByText('Date 11/23/26')).toBeInTheDocument();
      expect(c.getByText('Schedule 11/23/26')).toBeInTheDocument();
      expect(c.getByText('INVOICE : 9000010')).toBeInTheDocument();
      expect(c.getByText('Page 1 of 1')).toBeInTheDocument();
      expect(c.queryByText(/02:22|14:22/)).not.toBeInTheDocument(); // the time is kept, never printed
      // labor line N and parts line N share a row
      expect(c.getByRole('row', { name: 'DIAGNOSTIC 55.00 BRAKE PADS 1.00 100.00 100.00' })).toBeInTheDocument();
      expect(c.getByRole('row', { name: 'Remove & Install: BRAKE PADS 50.00' })).toBeInTheDocument();
    }
  });

  it('a description wrapped on one side keeps the next lines level on both sides', async () => {
    const wrapped = 'REPLACE FRONT BRAKE PADS AND ROTORS, CLEAN AND LUBE SLIDES, BLEED THE BRAKES, ROAD TEST AFTERWARD';
    api({
      ...SNAPSHOT,
      labor: [{ desc: wrapped, amount: 300 }, { desc: 'TIRE ROTATION', amount: 25 }],
      parts: [
        { desc: 'PADS', qty: 1, price: 100, total: 100 },
        { desc: 'ROTORS', qty: 2, price: 70, total: 140 },
      ],
    });
    show();
    await screen.findAllByText('INVOICE : 9000010');
    const c = within(copies()[0]);
    const row = c.getByText('TIRE ROTATION').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('ROTORS')).toBeInTheDocument();
  });

  it('the signature box has an X and no date line; the date is in the bar', async () => {
    api(SNAPSHOT);
    const { container } = show();
    await screen.findAllByText('INVOICE : 9000010');
    const sig = container.querySelector('.sig') as HTMLElement;
    expect(within(sig).getByText('X')).toBeInTheDocument();
    expect(sig.textContent).not.toMatch(/DATE/);
  });

  it('the logo spot: /shop-logo, hidden until it loads, gone when there is none; printing never waits for it', async () => {
    api(SNAPSHOT);
    const { container } = show();
    await screen.findAllByText('INVOICE : 9000010');
    const imgs = container.querySelectorAll<HTMLImageElement>('.logo img');
    expect(imgs).toHaveLength(2); // one per copy
    expect(imgs[0].getAttribute('src')).toBe('/shop-logo');
    expect(imgs[0].getAttribute('alt')).toBe('');
    expect(imgs[0].style.visibility).toBe('hidden');
    imgs[0].dispatchEvent(new Event('load'));
    await waitFor(() => expect(container.querySelectorAll<HTMLImageElement>('.logo img')[0].style.visibility).toBe(''));
    container.querySelectorAll<HTMLImageElement>('.logo img').forEach((i) => i.dispatchEvent(new Event('error')));
    await waitFor(() => expect(container.querySelectorAll('.logo img')).toHaveLength(0));
    expect(container.querySelectorAll('.logo')).toHaveLength(2); // the space stays
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  });

  it('a typical header prints at full size; one too tall for a page prints smaller (never clipped)', async () => {
    const W = 'W'.repeat(80);
    api({ ...SNAPSHOT, shop: { name: W, address: [W, W, W, W, W], phone: W, hours: W } });
    show();
    await screen.findAllByText(/^Page 1 of/);
    const zooms = [...document.querySelectorAll<HTMLElement>('.head')].map((h) => h.style.zoom);
    expect(zooms.length).toBeGreaterThan(0);
    for (const z of zooms) expect(Number(z || 1)).toBeLessThan(1);
    expect(screen.getAllByText(W).length).toBeGreaterThan(0); // the text itself is all there
  });

  it('a typical header prints at full size', async () => {
    api(SNAPSHOT);
    show();
    await screen.findAllByText(/^Page 1 of/);
    for (const h of document.querySelectorAll<HTMLElement>('.head')) expect(h.style.zoom).toBe('');
  });

  it('prints every total, the zero rows too, with 2 decimals', async () => {
    api(SNAPSHOT);
    show();
    const copy = (await screen.findAllByRole('region', { name: /^Bill copy/ }))[0];
    const rows: Array<[string, string]> = [
      ['Parts & Lubricants', '100.00'],
      ['Labor', '105.00'],
      ['Sublet', '0.00'],
      ['HAZ. DISPOSAL', '0.00'],
      ['SHOP SUPPLY', '20.00'],
      ['Gasoline', '0.00'],
      ['Sub Total', '225.00'],
      ['Sales Tax', '13.20'],
      ['Deposit', '38.20'],
      ['Disc. Applied', '0.00'],
      ['TOTAL', '238.20'],
      ['BALANCE DUE', '200.00'],
    ];
    for (const [label, amount] of rows) expect(within(copy).getByRole('row', { name: `${label} ${amount}` })).toBeInTheDocument();
  });

  it('prints each fixed paragraph of billText', async () => {
    api(SNAPSHOT);
    show();
    const copy = (await screen.findAllByRole('region', { name: /^Bill copy/ }))[0];
    const paragraphs = [
      text.APPROVAL_NOTICE,
      text.CHARGE,
      text.PARTS_NEW,
      text.STORAGE_NOTICE,
      text.ACCEPTANCE_SIGNATURE,
      text.ACCEPTANCE_TERMS,
      text.LIABILITY,
      text.AUTHORIZATION,
    ];
    expect(paragraphs.every((p) => p.length > 0)).toBe(true);
    for (const p of paragraphs) expect(within(copy).getByText(p)).toBeInTheDocument();
    for (const h of text.APPROVAL_COLUMNS) expect(within(copy).getByText(h)).toBeInTheDocument();
    expect(text.STORAGE_NOTICE).toBe('DAILY STORAGE 24HRS AFTER JOB DONE $65.00. BY SIGNING I WILL NOT DISPUTE THE CHARGES.');
    expect(text.AUTHORIZATION).toContain('labor is warranted for 90 days or 4000 miles');
  });

  it('calls print once after the data has loaded', async () => {
    api(SNAPSHOT);
    const { client } = show();
    expect(print).not.toHaveBeenCalled();
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    await client.invalidateQueries(); // a refetch is not a reason to print again
    await wait();
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('?noprint=1 shows the bill without printing', async () => {
    window.history.replaceState(null, '', '/bills/9000010/print?noprint=1');
    api(SNAPSHOT);
    show();
    await screen.findAllByText('INVOICE : 9000010');
    await wait();
    expect(print).not.toHaveBeenCalled();
  });

  it('?rev=1 prints that earlier revision as stored, asking the server for it', async () => {
    window.history.replaceState(null, '', '/bills/9000010/print?rev=1');
    const urls: string[] = [];
    mockFetch((_m, url) => {
      urls.push(url);
      if (url === '/api/own-bills/9000010?rev=1') return [200, own({ ...SNAPSHOT, amounts: { ...SNAPSHOT.amounts, total: 111 } })];
      if (url === '/api/own-bills/9000010') return [200, own({ ...SNAPSHOT, revision: 2 })];
      return undefined;
    });
    show();
    const copy = (await screen.findAllByRole('region', { name: /^Bill copy/ }))[0];
    expect(within(copy).getByRole('row', { name: 'TOTAL 111.00' })).toBeInTheDocument();
    expect(urls).toEqual(['/api/own-bills/9000010?rev=1']);
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  });

  it('never shows the revision, even for revision 2', async () => {
    api({ ...SNAPSHOT, revision: 2 });
    const { container } = show();
    await screen.findAllByText('INVOICE : 9000010');
    expect(container.textContent).not.toMatch(/revis/i);
    expect(container.textContent).not.toMatch(/\brev\b/i);
  });

  it('a long bill continues on more pages: header repeated, Page N, totals on the last page only', async () => {
    api({ ...SNAPSHOT, labor: manyLabor(40) });
    show();
    await screen.findAllByText('INVOICE : 9000010');
    const pages = Math.ceil(40 / ROWS_PER_PAGE);
    expect(pages).toBeGreaterThan(1);
    for (const copy of copies()) {
      const c = within(copy);
      for (let n = 1; n <= pages; n++) expect(c.getByText(`Page ${n} of ${pages}`)).toBeInTheDocument();
      expect(c.queryByText(`Page ${pages + 1} of ${pages}`)).not.toBeInTheDocument();
      expect(c.getAllByText('INVOICE : 9000010')).toHaveLength(pages);
      expect(c.getAllByText('JANE DOE')).toHaveLength(pages);
      expect(c.getAllByText('TEST SHOP')).toHaveLength(pages);
      expect(c.getAllByRole('row', { name: /^BALANCE DUE/ })).toHaveLength(1);
      expect(c.getAllByRole('row', { name: /^TOTAL/ })).toHaveLength(1);
      expect(c.getAllByText(text.AUTHORIZATION)).toHaveLength(1);
      expect(c.getByText('LABOR LINE 1')).toBeInTheDocument();
      expect(c.getByText('LABOR LINE 40')).toBeInTheDocument();
    }
    expect(screen.getAllByText(`Page 2 of ${pages}`)).toHaveLength(2);
  });

  it('long descriptions are never cut: 20 rows of 120 characters take more pages, with every character shown', async () => {
    const desc = (i: number) => `ROW ${i} ` + 'REPLACE FRONT BRAKE PADS AND ROTORS '.repeat(4).trim();
    const labor = Array.from({ length: 20 }, (_, i) => ({ desc: desc(i), amount: 10 }));
    api({ ...SNAPSHOT, labor, parts: Array.from({ length: 20 }, (_, i) => ({ desc: desc(i), qty: 1, price: 5, total: 5 })) });
    show();
    await screen.findAllByText('INVOICE : 9000010');
    const c = within(copies()[0]);
    expect(c.getByText(/^Page 2 of \d+$/)).toBeInTheDocument();
    for (const l of labor) expect(c.getAllByText(l.desc)).toHaveLength(2); // labor and parts
    expect(c.getAllByRole('row', { name: /^BALANCE DUE/ })).toHaveLength(1);
  });

  it('one description too long for a page goes over several rows, none of it lost, the price on the first', async () => {
    const words = Array.from({ length: 300 }, (_, i) => `PART${i}`);
    api({ ...SNAPSHOT, labor: [{ desc: words.join(' '), amount: 12.5 }] });
    show();
    await screen.findAllByText('INVOICE : 9000010');
    const c = within(copies()[0]);
    const cells = Array.from(copies()[0].querySelectorAll('td.ld')).map((td) => td.textContent);
    expect(cells.length).toBeGreaterThan(1);
    expect(cells.join(' ')).toBe(words.join(' '));
    expect(c.getAllByText('12.50')).toHaveLength(1);
    expect(c.getAllByRole('row', { name: /^BALANCE DUE/ })).toHaveLength(1);
  });

  it('a failed refetch keeps showing the bill', async () => {
    api(SNAPSHOT);
    const { client } = show();
    await screen.findAllByText('INVOICE : 9000010');
    mockFetch(() => [500, { error: 'down' }]);
    await client.invalidateQueries();
    await wait();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByText('INVOICE : 9000010')).toHaveLength(2);
  });

  it('a bill that does not load says so plainly and never prints', async () => {
    const urls = api(404);
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    await wait();
    expect(urls).toContain('/api/own-bills/9000010');
    expect(print).not.toHaveBeenCalled();
    expect(screen.queryByText(/INVOICE/)).not.toBeInTheDocument();
  });

  it('signed out: tells the admin to sign in, never prints', async () => {
    api(401);
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent(/sign in/i);
    await wait();
    expect(print).not.toHaveBeenCalled();
  });
});
