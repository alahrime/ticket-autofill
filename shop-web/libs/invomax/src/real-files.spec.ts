import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBtrieve } from './btrieve.js';
import { readInvoiceFiles } from './records.js';

// Opt-in: runs only when INVOMAX_REAL_DIR points at copies of the shop's tables.
// Prints counts only; nothing from the files is kept or echoed.
const dir = process.env['INVOMAX_REAL_DIR'];
const real = dir ? describe : describe.skip;

real('real InvoMax tables', () => {
  test.each(['INVOICE.btv', 'DETAIL.btv'])('%s decodes to the header count', (name) => {
    const f = readBtrieve(readFileSync(join(dir as string, name)));
    console.log(`${name}: header ${f.headerCount}, decoded ${f.records.length}`);
    expect(f.records.length).toBe(f.headerCount);
  });
});

real('real InvoMax bills', () => {
  test('lines join to invoices and add up to the bill', () => {
    const d = dir as string;
    const r = readInvoiceFiles(readFileSync(join(d, 'INVOICE.btv')), readFileSync(join(d, 'DETAIL.btv')));
    const known = new Set(r.invoices.map((i) => i.invoice_no));
    const orphans = r.lines.filter((l) => !known.has(l.invoice_no)).length;
    const sums = new Map<string, { part: number; labor: number }>();
    for (const l of r.lines) {
      const s = sums.get(l.invoice_no) ?? { part: 0, labor: 0 };
      if (l.kind === 'part') s.part += l.amount;
      if (l.kind === 'labor') s.labor += l.amount;
      sums.set(l.invoice_no, s);
    }
    const recent = r.invoices.filter((i) => i.date >= '2020-01-01');
    const ok = recent.filter((i) => {
      const s = sums.get(i.invoice_no) ?? { part: 0, labor: 0 };
      return s.part === i.parts && s.labor === i.labor;
    }).length;
    const undated = r.invoices.filter((i) => !i.date).length;
    console.log(
      `invoices ${r.invoices.length}, lines ${r.lines.length}, orphans ${orphans}, undated ${undated}, bad numbers ${r.badNumbers}, odd invoice numbers ${r.oddNumbers}, duplicates ${r.duplicates}, ` +
        `2020+ ${recent.length}, sums match ${ok} (${((100 * ok) / recent.length).toFixed(1)}%)`,
    );
    expect(r.headerCounts).toEqual({ invoice: r.invoices.length + r.duplicates, detail: r.lines.length });
    expect(orphans / r.lines.length).toBeLessThanOrEqual(0.005);
    expect(ok / recent.length).toBeGreaterThanOrEqual(0.98);
  });
});
