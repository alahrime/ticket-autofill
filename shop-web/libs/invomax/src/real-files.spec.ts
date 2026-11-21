import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBtrieve } from './btrieve.js';

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
