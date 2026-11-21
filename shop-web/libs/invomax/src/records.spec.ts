import { BtrieveError } from './btrieve.js';
import { decodeDetail, decodeInvoice, readInvoiceFiles } from './records.js';
import { btrieveFile, detailBytes, invoiceBytes } from './testing.js';

const invFile = (records: Buffer[]): Buffer => btrieveFile({ pageSize: 1536, recordLength: 498, records });
const detFile = (records: Buffer[]): Buffer => btrieveFile({ pageSize: 1024, recordLength: 265, records });

test('an invoice round-trips', () => {
  const inv = decodeInvoice(
    invoiceBytes({
      invoice_no: '9000001',
      date: '2026-11-20',
      last: 'DOE',
      first: 'JANE',
      phone: '(555)010-0000',
      plate: 'XKS-4827',
      parts: 12000,
      labor: 9000,
      supplies: 1050,
      discount: 0,
      deposit: 25000,
      tax: 783,
      total: 22833,
      balance: -2167,
      tax_rate: 0.06,
      key: 'DOE_2',
      address: '1 MAIN ST',
    }),
  );
  expect(inv).toMatchObject({
    invoice_no: '9000001',
    date: '2026-11-20',
    parts: 12000,
    labor: 9000,
    supplies: 1050,
    deposit: 25000,
    tax: 783,
    total: 22833,
    balance: -2167,
    tax_rate: 0.06,
    name: 'JANE DOE',
    first: 'JANE',
    last: 'DOE',
    phone: '5550100000',
    plate: 'XKS4827',
    key: 'DOE_2',
    address: '1 MAIN ST',
  });
  expect(inv.hash).toMatch(/^[0-9a-f]{64}$/);
});

test('bad date -> empty, not a throw', () => {
  expect(decodeInvoice(invoiceBytes({ invoice_no: '9000002', date: '13452026' })).date).toBe('');
  expect(decodeInvoice(invoiceBytes({ invoice_no: '9000002', date: '05/204' })).date).toBe('');
});

test('names split on the last word', () => {
  expect(decodeInvoice(invoiceBytes({ name: 'CASH' }))).toMatchObject({ first: '', last: 'CASH' });
  expect(decodeInvoice(invoiceBytes({ name: 'MARY ANN DOE' }))).toMatchObject({ first: 'MARY ANN', last: 'DOE' });
});

test('a line round-trips', () => {
  expect(
    decodeDetail(
      detailBytes({
        invoice_no: '9000001',
        code: 'LABOR',
        description: 'REPLACE FRONT PADS',
        kind: 'labor',
        qty: 1,
        unit: 9000,
        amount: 9000,
        vehicle: '2019 Honda HR-V EX',
        date: '2026-11-20',
      }),
    ),
  ).toMatchObject({ kind: 'labor', unit: 9000, qty: 1, amount: 9000, date: '2026-11-20', description: 'REPLACE FRONT PADS' });
});

test('amount is qty x unit in cents, rounded half up; blank qty is 0', () => {
  expect(decodeDetail(detailBytes({ kind: 'part', qty: 1.5, unit: 333 })).amount).toBe(500);
  expect(decodeDetail(detailBytes({ kind: 'part', unit: 500 }))).toMatchObject({ qty: 0, amount: 0 });
});

test('payment lines are other', () => {
  expect(decodeDetail(detailBytes({ kind: 'part', ref: 'VISA_1', unit: 100, qty: 1 })).kind).toBe('other');
  expect(decodeDetail(detailBytes({ kind: 'labor', code: 'deposit' })).kind).toBe('other');
  expect(decodeDetail(detailBytes({ kind: 'part', ref: '  12.50' })).kind).toBe('part');
});

test('readInvoiceFiles orders lines, numbers them, and takes a bad date from the first line', () => {
  const { invoices, lines, headerCounts } = readInvoiceFiles(
    invFile([invoiceBytes({ invoice_no: '9000001', date: 'xx' }), invoiceBytes({ invoice_no: '9000002', date: '2026-01-02' })]),
    detFile([
      detailBytes({ invoice_no: '9000001', code: 'B', order: 1, date: '2026-03-04' }),
      detailBytes({ invoice_no: '9000002', code: 'X', order: 0 }),
      detailBytes({ invoice_no: '9000001', code: 'A', order: 0, date: '2026-03-03' }),
      detailBytes({ invoice_no: '9000001', code: 'C', order: 1, date: '2026-03-05' }),
      detailBytes({ invoice_no: '9000099', code: 'ORPHAN' }),
    ]),
  );
  expect(headerCounts).toEqual({ invoice: 2, detail: 5 });
  expect(invoices.map((i) => i.date)).toEqual(['2026-03-03', '2026-01-02']);
  expect(lines.filter((l) => l.invoice_no === '9000001').map((l) => [l.code, l.line_no])).toEqual([
    ['A', 1],
    ['B', 2],
    ['C', 3],
  ]);
  expect(lines).toHaveLength(5);
});

test('mostly-bad invoice numbers mean the walk is wrong: throws', () => {
  expect(() => readInvoiceFiles(invFile([invoiceBytes({ invoice_no: '12345678' })]), detFile([detailBytes({ invoice_no: '1' })]))).toThrow(BtrieveError);
  expect(() => readInvoiceFiles(invFile([invoiceBytes({ invoice_no: '1' })]), detFile([detailBytes({ invoice_no: 'AB' })]))).toThrow(BtrieveError);
});

test('a few odd invoice numbers are kept as typed and counted', () => {
  const inv = Array.from({ length: 200 }, (_, i) => invoiceBytes({ invoice_no: String(9000001 + i) }));
  inv.push(invoiceBytes({ invoice_no: '123456A' }));
  const r = readInvoiceFiles(invFile(inv), detFile([detailBytes({ invoice_no: '123456A' })]));
  expect(r.oddNumbers).toBe(2);
  expect(r.invoices[200].invoice_no).toBe('123456A');
});
