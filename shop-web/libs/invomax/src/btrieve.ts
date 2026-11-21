// Reader for InvoMax's Btrieve 5.x tables. The format is described in ../LAYOUT.md.

export type BtrieveFile = {
  pageSize: number;
  recordLength: number;
  headerCount: number;
  /** Unpacked records in file order, each exactly `recordLength` long. */
  records: Buffer[];
};

export class BtrieveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BtrieveError';
  }
}

type Fragment = { data: Buffer; next: { page: number; slot: number } | null };

const EMPTY = 0xffff;
const CHAINED = 0x8000;

/** Page number: two u16 words, high word first. */
const pageNumber = (b: Buffer, at: number): number => b.readUInt16LE(at) * 65536 + b.readUInt16LE(at + 2);

/** The fragments of one page, or null when the page is not a fragment page. */
function fragmentsOf(file: Buffer, pageSize: number, index: number): (Fragment | null)[] | null {
  const base = index * pageSize;
  if (pageNumber(file, base) !== index) return null;
  const cnt = file.readUInt16LE(base + 10);
  if (cnt <= 0 || cnt >= (pageSize - 12) / 2) return null;

  const slot = (i: number): number => file.readUInt16LE(base + pageSize - 2 - 2 * i);
  const free = slot(cnt);
  if (free > pageSize - 2 * (cnt + 1)) return null;

  const offsets = new Set<number>([free]);
  const slots: { offset: number; chained: boolean }[] = [];
  let smallest = Infinity;
  for (let i = 0; i < cnt; i++) {
    const v = slot(i);
    if (v === EMPTY) {
      slots.push({ offset: -1, chained: false });
      continue;
    }
    const offset = v & 0x7fff;
    if (offsets.has(offset)) return null;
    offsets.add(offset);
    smallest = Math.min(smallest, offset);
    slots.push({ offset, chained: (v & CHAINED) !== 0 });
  }
  if (smallest !== 12) return null;
  // Every live fragment must start in the data area, before the free space.
  for (const s of slots) if (s.offset >= free) return null;

  const sorted = [...offsets].sort((a, b) => a - b);
  return slots.map((s) => {
    if (s.offset < 0) return null;
    const end = sorted[sorted.indexOf(s.offset) + 1];
    let from = base + s.offset;
    let next: Fragment['next'] = null;
    if (s.chained) {
      const p = file.subarray(from, from + 4);
      next = { page: (p[0] << 16) | p[1] | (p[2] << 8), slot: p[3] };
      from += 4;
    }
    return { data: file.subarray(from, base + end), next };
  });
}

function unpack(packed: Buffer, recordLength: number): Buffer {
  const out = Buffer.alloc(recordLength);
  let at = 0;
  let to = 0;
  const need = (n: number): void => {
    if (at + n > packed.length) throw new BtrieveError('packed record is cut short');
  };
  const room = (n: number): void => {
    if (to + n > recordLength) throw new BtrieveError(`unpacked record is longer than ${recordLength}`);
  };
  while (to < recordLength) {
    need(2);
    const n = packed.readUInt16LE(at);
    at += 2;
    need(n);
    room(n);
    packed.copy(out, to, at, at + n);
    at += n;
    to += n;
    if (to >= recordLength) break;
    need(3);
    const r = packed.readUInt16LE(at);
    const byte = packed[at + 2];
    at += 3;
    room(r);
    out.fill(byte, to, to + r);
    to += r;
  }
  return out;
}

export function readBtrieve(file: Buffer): BtrieveFile {
  if (file.length < 0x110) throw new BtrieveError('file is too short for a Btrieve header');
  const pageSize = file.readUInt16LE(0x08);
  const recordLength = file.readUInt16LE(0x10e);
  const headerCount = file.readUInt16LE(0x1a) * 65536 + file.readUInt16LE(0x1c);
  if (pageSize < 512 || pageSize % 2 !== 0 || recordLength === 0) {
    throw new BtrieveError(`bad header: page size ${pageSize}, record length ${recordLength}`);
  }
  if (file.length % pageSize !== 0) {
    throw new BtrieveError(`file length ${file.length} is not a whole number of ${pageSize}-byte pages`);
  }

  const pages = file.length / pageSize;
  const frags = new Map<number, (Fragment | null)[]>();
  const targeted = new Set<string>();
  for (let p = 1; p < pages; p++) {
    const list = fragmentsOf(file, pageSize, p);
    if (!list) continue;
    frags.set(p, list);
    for (const f of list) if (f?.next) targeted.add(`${f.next.page}:${f.next.slot}`);
  }

  const records: Buffer[] = [];
  for (const [page, list] of frags) {
    for (let s = 0; s < list.length; s++) {
      const head = list[s];
      if (!head || targeted.has(`${page}:${s}`)) continue;
      const parts = [head.data];
      let f: Fragment = head;
      for (let hops = 0; f.next; hops++) {
        const target: Fragment | null | undefined = frags.get(f.next.page)?.[f.next.slot];
        if (!target || hops > pages) throw new BtrieveError(`broken chain at page ${page}, slot ${s}`);
        parts.push(target.data);
        f = target;
      }
      records.push(unpack(parts.length === 1 ? head.data : Buffer.concat(parts), recordLength));
    }
  }

  if (records.length !== headerCount) {
    throw new BtrieveError(`header says ${headerCount} records but the pages hold ${records.length}`);
  }
  return { pageSize, recordLength, headerCount, records };
}

/** Turbo Pascal 6-byte Real. Exponent byte 0 means 0. */
export function real48(b: Buffer, at: number): number {
  const exp = b[at];
  if (exp === 0) return 0;
  const hi = b[at + 5];
  const m = b.readUInt32LE(at + 1) + (hi & 0x7f) * 2 ** 32;
  const value = (1 + m / 2 ** 39) * 2 ** (exp - 129);
  return hi & 0x80 ? -value : value;
}

/** Pascal short string (latin1); a length byte above `max` is capped at `max`. */
export function shortString(b: Buffer, at: number, max: number): string {
  const len = Math.min(b[at], max);
  return b.toString('latin1', at + 1, at + 1 + len);
}
