// JSON text exactly as Python's json.dumps writes it (default arguments): ", " and ": " separators,
// non-ASCII escaped as \uXXXX (ensure_ascii). tickets.db rows stay byte for byte what tickets.Store writes.

const asciiOnly = (s: string): string =>
  s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Python's json.dumps(v). Keys whose value is undefined are left out, as JSON.stringify does. */
export function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return asciiOnly(JSON.stringify(v));
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`can't store ${v} as JSON`);
    return JSON.stringify(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`;
  if (typeof v === 'object') {
    const items = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${asciiOnly(JSON.stringify(k))}: ${pyDumps(x)}`);
    return `{${items.join(', ')}}`;
  }
  throw new TypeError(`can't store a ${typeof v} as JSON`);
}
