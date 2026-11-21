// Synthetic InvoMax files for specs. Writes the format described in ../LAYOUT.md.
// Fixtures are generated here; nothing is ever copied from the shop's real files.

export function real48Bytes(n: number): Buffer {
  const out = Buffer.alloc(6);
  if (n === 0) return out;
  const a = Math.abs(n);
  let e = Math.floor(Math.log2(a));
  let m = Math.round((a / 2 ** e - 1) * 2 ** 39);
  if (m >= 2 ** 39) {
    e += 1;
    m = 0;
  }
  out[0] = e + 129;
  out.writeUInt32LE(m % 2 ** 32, 1);
  out[5] = Math.floor(m / 2 ** 32) | (n < 0 ? 0x80 : 0);
  return out;
}

export function shortStringBytes(s: string, max: number): Buffer {
  const out = Buffer.alloc(1 + max);
  const text = Buffer.from(s, 'latin1').subarray(0, max);
  out[0] = text.length;
  text.copy(out, 1);
  return out;
}

/** Run-length pack: u16 literal count + literals, then u16 run count + byte, repeated. */
function pack(rec: Buffer): Buffer {
  const parts: Buffer[] = [];
  const repeats = (j: number): boolean =>
    j + 3 < rec.length && rec[j] === rec[j + 1] && rec[j] === rec[j + 2] && rec[j] === rec[j + 3];
  let i = 0;
  while (i < rec.length) {
    let j = i;
    while (j < rec.length && !repeats(j)) j++;
    const lit = Buffer.alloc(2);
    lit.writeUInt16LE(j - i);
    parts.push(lit, rec.subarray(i, j));
    i = j;
    if (i >= rec.length) break;
    let k = i;
    while (k < rec.length && rec[k] === rec[i]) k++;
    const run = Buffer.alloc(3);
    run.writeUInt16LE(k - i);
    run[2] = rec[i];
    parts.push(run);
    i = k;
  }
  return Buffer.concat(parts);
}

/** A chain pointer: `b0 b1 b2 slot`, page = (b0 << 16) | b1 | (b2 << 8). */
export function pointerBytes(page: number, slot: number): Buffer {
  return Buffer.from([page >> 16, page & 0xff, (page >> 8) & 0xff, slot]);
}

type Frag = { data: Buffer; page: number; slot: number; next?: Frag };
type Slot = Frag | null; // null is an empty (deleted) slot
type Page = { number: number; slots: Slot[]; used: number };

export function btrieveFile(opts: {
  pageSize: number;
  recordLength: number;
  records: Buffer[];
  headerCount?: number;
  splitEvery?: number;
  /** Fragments in a split record (default 2): head, middle ones, tail. */
  fragments?: number;
}): Buffer {
  const { pageSize, recordLength, records, splitEvery } = opts;
  const parts = opts.fragments ?? 2;
  const header = Buffer.alloc(pageSize);
  header.writeUInt16LE(pageSize, 0x08);
  header.writeUInt16LE(10, 0x14);
  const count = opts.headerCount ?? records.length;
  header.writeUInt16LE(Math.floor(count / 65536), 0x1a);
  header.writeUInt16LE(count % 65536, 0x1c);
  header.writeUInt16LE(recordLength, 0x10e);

  // Layout first (a chained fragment needs its next fragment's address), bytes after.
  const layout: (Page | 'filler')[] = [];
  let pageNo = 1;
  let current = null as Page | null;
  let opened = 0;
  const open = (): Page => {
    // A non-fragment page now and then, so the reader's skip is exercised.
    if (opened++ % 4 === 0) {
      layout.push('filler');
      pageNo++;
    }
    current = { number: pageNo++, slots: [], used: 12 };
    layout.push(current);
    return current;
  };
  const place = (data: Buffer, chained: boolean): Frag => {
    const size = data.length + (chained ? 4 : 0);
    const fits = (p: Page, extra: number): boolean => p.used + size + 2 * (p.slots.length + extra + 1) <= pageSize;
    const p: Page = current && fits(current, 1) ? current : open();
    // Leave an empty (deleted) slot before every fifth fragment.
    if (p.slots.length % 5 === 2 && fits(p, 2)) p.slots.push(null);
    const f: Frag = { data, page: p.number, slot: p.slots.length };
    p.slots.push(f);
    p.used += size;
    return f;
  };

  records.forEach((rec, i) => {
    const packed = pack(rec);
    if (splitEvery && (i + 1) % splitEvery === 0 && packed.length >= parts) {
      let prev: Frag | null = null;
      for (let k = 0; k < parts; k++) {
        const from = Math.floor((packed.length * k) / parts);
        const to = Math.floor((packed.length * (k + 1)) / parts);
        if (k > 0) open(); // each later fragment lands on a later page
        const f = place(packed.subarray(from, to), k < parts - 1);
        if (prev) prev.next = f;
        prev = f;
      }
    } else {
      place(packed, false);
    }
  });

  const out: Buffer[] = [header];
  for (const p of layout) {
    const page = Buffer.alloc(pageSize, p === 'filler' ? 0xab : 0); // 0xab fails the own-page-number check
    if (p !== 'filler') {
      page.writeUInt16LE(Math.floor(p.number / 65536), 0);
      page.writeUInt16LE(p.number % 65536, 2);
      page.writeUInt16LE(p.slots.length, 10);
      let at = 12;
      p.slots.forEach((f, i) => {
        let v = 0xffff;
        if (f) {
          v = at | (f.next ? 0x8000 : 0);
          if (f.next) {
            const n = f.next.page;
            pointerBytes(n, f.next.slot).copy(page, at);
            at += 4;
          }
          f.data.copy(page, at);
          at += f.data.length;
        }
        page.writeUInt16LE(v, pageSize - 2 - 2 * i);
      });
      page.writeUInt16LE(at, pageSize - 2 - 2 * p.slots.length);
    }
    out.push(page);
  }
  return Buffer.concat(out);
}
