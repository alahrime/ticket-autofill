import { BtrieveError, readBtrieve, real48, shortString } from './btrieve.js';
import { btrieveFile, real48Bytes } from './testing.js';

test('reads back every record, split ones included', () => {
  const recs = Array.from({ length: 250 }, (_, i) => Buffer.alloc(498, i % 256));
  const f = readBtrieve(btrieveFile({ pageSize: 1536, recordLength: 498, records: recs, splitEvery: 7 }));
  expect(f.pageSize).toBe(1536);
  expect(f.headerCount).toBe(250);
  expect(f.records).toEqual(recs);
});
test('count mismatch fails loudly', () => {
  const file = btrieveFile({ pageSize: 1024, recordLength: 64, records: [Buffer.alloc(64)], headerCount: 2 });
  expect(() => readBtrieve(file)).toThrow(/1 .*2|2 .*1/);
});
test('a truncated file is a BtrieveError, never a short list', () => {
  const file = btrieveFile({ pageSize: 1024, recordLength: 64, records: Array(40).fill(Buffer.alloc(64, 1)) });
  expect(() => readBtrieve(file.subarray(0, file.length - 700))).toThrow(BtrieveError);
});
test('real48', () => {
  expect(real48(real48Bytes(181.25), 0)).toBe(181.25);
  expect(real48(real48Bytes(-10), 0)).toBe(-10);
  expect(real48(Buffer.alloc(6), 0)).toBe(0);
});
test('shortString caps a bad length byte', () => {
  expect(shortString(Buffer.from([200, 65, 66]), 0, 2)).toBe('AB');
});
