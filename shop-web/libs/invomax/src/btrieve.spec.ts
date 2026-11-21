import { BtrieveError, readBtrieve, real48, shortString } from './btrieve.js';
import { btrieveFile, pointerBytes, real48Bytes } from './testing.js';

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

// ---- helpers for hand-built pages ----

/** Bytes with no run of 4 equal bytes, so they pack as literals only. */
const noisy = (n: number, seed: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed * 13 + (i >> 3)) & 0xff));
const mixed = (seed: number): Buffer => Buffer.concat([noisy(30, seed), Buffer.alloc(40, seed | 1), noisy(30, seed + 1)]);
const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
/** Packed form of the given literal bytes. */
const lit = (data: Buffer): Buffer => Buffer.concat([u16(data.length), data]);

type RawSlot = { data: Buffer; to?: [number, number] } | null;
/** A fragment page with the given slots, laid out as in LAYOUT.md. Tweaks let a test break one rule. */
function fragPage(
  pageSize: number,
  number: number,
  slots: RawSlot[],
  tweak: { cnt?: number; offsets?: Record<number, number>; free?: number } = {},
): Buffer {
  const page = Buffer.alloc(pageSize);
  page.writeUInt16LE(Math.floor(number / 65536), 0);
  page.writeUInt16LE(number % 65536, 2);
  page.writeUInt16LE(tweak.cnt ?? slots.length, 10);
  let at = 12;
  slots.forEach((s, i) => {
    let v = 0xffff;
    if (s) {
      v = tweak.offsets?.[i] ?? at | (s.to ? 0x8000 : 0);
      if (s.to) {
        pointerBytes(s.to[0], s.to[1]).copy(page, at);
        at += 4;
      }
      s.data.copy(page, at);
      at += s.data.length;
    }
    page.writeUInt16LE(v, pageSize - 2 - 2 * i);
  });
  page.writeUInt16LE(tweak.free ?? at, pageSize - 2 - 2 * slots.length);
  return page;
}
function rawFile(pageSize: number, recordLength: number, count: number, pages: Buffer[]): Buffer {
  const header = Buffer.alloc(pageSize);
  header.writeUInt16LE(pageSize, 0x08);
  header.writeUInt16LE(Math.floor(count / 65536), 0x1a);
  header.writeUInt16LE(count % 65536, 0x1c);
  header.writeUInt16LE(recordLength, 0x10e);
  return Buffer.concat([header, ...pages]);
}

const PS = 1024;
const REC = noisy(8, 3);
const good = (number: number): Buffer => fragPage(PS, number, [{ data: lit(REC) }]);

test('literal-only and literal+run+literal records round-trip, in long chains', () => {
  const recs = Array.from({ length: 900 }, (_, i) => (i % 2 ? mixed(i) : noisy(100, i)));
  const file = btrieveFile({ pageSize: PS, recordLength: 100, records: recs, splitEvery: 3, fragments: 3 });
  expect(file.length / PS).toBeGreaterThan(256); // pointer bytes b1/b2 are non-trivial
  expect(readBtrieve(file).records).toEqual(recs);
});

test('a chain of two, three and five fragments reads back', () => {
  const recs = Array.from({ length: 40 }, (_, i) => mixed(i));
  for (const fragments of [2, 3, 5]) {
    const file = btrieveFile({ pageSize: PS, recordLength: 100, records: recs, splitEvery: 2, fragments });
    expect(readBtrieve(file).records).toEqual(recs);
  }
});

test('pointer encoding follows LAYOUT.md: page = (b0 << 16) | b1 | (b2 << 8)', () => {
  expect([...pointerBytes(0x012345, 7)]).toEqual([0x01, 0x45, 0x23, 7]);
  expect([...pointerBytes(0x0100, 0)]).toEqual([0, 0x00, 0x01, 0]);
});

test('page numbers are two words, high word first', () => {
  // 70000 non-fragment pages, then page 70001 = 0x11171 (high word 1, low word 0x1171).
  const fillers = Buffer.alloc(512 * 70000, 0xab);
  const last = fragPage(512, 70001, [{ data: lit(noisy(8, 1)) }]);
  expect(last.readUInt16LE(0)).toBe(1);
  expect(last.readUInt16LE(2)).toBe(0x1171);
  const file = rawFile(512, 8, 1, [fillers, last]);
  expect(readBtrieve(file).records).toEqual([noisy(8, 1)]);
});

describe('pages that fail one fragment-page rule are skipped', () => {
  const bad: Record<string, Buffer> = {
    'cnt zero': fragPage(PS, 3, [{ data: lit(REC) }], { cnt: 0 }),
    'cnt too large': fragPage(PS, 3, [{ data: lit(REC) }], { cnt: 600 }),
    'smallest offset is not 12': fragPage(PS, 3, [{ data: lit(REC) }], { offsets: { 0: 14 } }),
    'duplicate offsets': fragPage(PS, 3, [{ data: lit(REC) }, { data: lit(REC) }], { offsets: { 1: 12 } }),
    'free offset too large': fragPage(PS, 3, [{ data: lit(REC) }], { free: PS - 2 }),
    'offset not below free': fragPage(PS, 3, [{ data: lit(REC) }, { data: lit(REC) }], { offsets: { 1: 900 } }),
    'wrong own page number': fragPage(PS, 9, [{ data: lit(REC) }]),
    'no live slot': fragPage(PS, 3, [null]),
  };
  test.each(Object.keys(bad))('%s', (name) => {
    const file = rawFile(PS, 8, 2, [good(1), good(2), bad[name]]);
    expect(readBtrieve(file).records).toEqual([REC, REC]);
  });
  test('empty slots and filler pages are fine', () => {
    const file = rawFile(PS, 8, 1, [Buffer.alloc(PS, 0xab), fragPage(PS, 2, [null, { data: lit(REC) }, null])]);
    expect(readBtrieve(file).records).toEqual([REC]);
  });
});

describe('hostile files fail with BtrieveError', () => {
  const head = (to: [number, number]): RawSlot => ({ data: lit(noisy(4, 1)), to });
  const tail: RawSlot = { data: lit(noisy(4, 2)) };
  const chainFile = (slots: RawSlot[], count = 1): Buffer => rawFile(PS, 8, count, [fragPage(PS, 1, slots)]);

  test('chain to an empty slot', () => expect(() => readBtrieve(chainFile([head([1, 1]), null]))).toThrow(BtrieveError));
  test('chain to a slot past cnt', () => expect(() => readBtrieve(chainFile([head([1, 5]), tail]))).toThrow(BtrieveError));
  test('chain to a page past EOF', () => expect(() => readBtrieve(chainFile([head([9, 0]), tail]))).toThrow(BtrieveError));
  test('chain to a page that is not a fragment page', () => {
    const file = rawFile(PS, 8, 1, [fragPage(PS, 1, [head([2, 0]), tail]), Buffer.alloc(PS, 0xab)]);
    expect(() => readBtrieve(file)).toThrow(BtrieveError);
  });
  test('self-pointer reachable from a head', () => {
    const file = chainFile([head([1, 1]), head([1, 1])]);
    expect(() => readBtrieve(file)).toThrow(BtrieveError);
  });
  test('two-node cycle reachable from a head', () => {
    const file = chainFile([head([1, 1]), head([1, 2]), head([1, 1])]);
    expect(() => readBtrieve(file)).toThrow(BtrieveError);
  });
  test('truncation at a page boundary', () => {
    const recs = Array.from({ length: 40 }, (_, i) => noisy(64, i));
    const file = btrieveFile({ pageSize: PS, recordLength: 64, records: recs });
    expect(() => readBtrieve(file.subarray(0, file.length - 2 * PS))).toThrow(BtrieveError);
  });
  test('oversized literal count', () => {
    const file = rawFile(PS, 8, 1, [fragPage(PS, 1, [{ data: lit(noisy(20, 1)) }])]);
    expect(() => readBtrieve(file)).toThrow(BtrieveError);
  });
  test('literal count beyond the packed bytes', () => {
    const file = rawFile(PS, 8, 1, [fragPage(PS, 1, [{ data: Buffer.concat([u16(60000), noisy(4, 1)]) }])]);
    expect(() => readBtrieve(file)).toThrow(BtrieveError);
  });
  test('oversized repeat count', () => {
    const packed = Buffer.concat([u16(0), u16(100), Buffer.from([7])]);
    const file = rawFile(PS, 8, 1, [fragPage(PS, 1, [{ data: packed }])]);
    expect(() => readBtrieve(file)).toThrow(BtrieveError);
  });
  test('packed record that ends short of the record length', () => {
    const file = rawFile(PS, 8, 1, [fragPage(PS, 1, [{ data: lit(noisy(4, 1)) }])]);
    expect(() => readBtrieve(file)).toThrow(BtrieveError);
  });
  test.each([0, 511])('page size %i in the header', (size) => {
    const file = btrieveFile({ pageSize: PS, recordLength: 64, records: [noisy(64, 1)] });
    file.writeUInt16LE(size, 0x08);
    expect(() => readBtrieve(file)).toThrow(BtrieveError);
  });
  test('a zeroed fragment page is skipped, then the count mismatches', () => {
    const recs = Array.from({ length: 40 }, (_, i) => noisy(64, i));
    const file = btrieveFile({ pageSize: PS, recordLength: 64, records: recs });
    file.fill(0, 2 * PS, 3 * PS); // page 1 is a filler, page 2 is the first fragment page
    expect(() => readBtrieve(file)).toThrow(BtrieveError);
  });
});
