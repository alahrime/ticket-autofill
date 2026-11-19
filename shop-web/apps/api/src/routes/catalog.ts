// Part hints from parts.csv and the year / make / model lists (shop.py: hints, vehicles and their routes).
import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { pyStrip } from '@shop/domain';
import { depsOf } from '../http/deps';
import { queryValues, signedIn } from '../view';

export const MAX_HINTS = 8;

export type Hint = {
  code: string;
  description: string;
  part_price: number;
  labor_price: number;
};
type Part = Hint & { aliases: string[] };

/** Rows of an excel-dialect CSV (Python's csv module): quoted fields, "" inside quotes, CRLF / LF / CR. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = (): void => {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row); // DictReader skips blank lines
    row = [];
    field = '';
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      endRow();
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
    i++;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/** Python's float() on a decimal string (spaces around allowed); null for anything else. */
function pyFloat(s: string): number | null {
  const t = pyStrip(s);
  if (
    !/^[+-]?(\d+(_\d+)*)?(\.(\d+(_\d+)*)?)?([eE][+-]?\d+(_\d+)*)?$/.test(t) ||
    !/\d/.test(t.split(/[eE]/)[0] as string)
  )
    return null;
  const n = Number(t.replace(/_/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** parts.csv by code (prices.load_catalog: a later row with the same code replaces the earlier); throws when malformed. */
function loadCatalog(path: string): Part[] {
  const text = readFileSync(path, 'utf8').replace(/^\ufeff/, '');
  const [head, ...rows] = csvRows(text);
  const col = (name: string): number => {
    const at = (head ?? []).indexOf(name);
    if (at < 0) throw new Error(`no ${name} column`);
    return at;
  };
  const [code, description, aliases, partPrice, laborPrice] = [
    col('code'),
    col('description'),
    col('aliases'),
    col('part_price'),
    col('labor_price'),
  ];
  col('sided');
  const byCode = new Map<string, Part>();
  for (const r of rows) {
    const get = (i: number): string => {
      const v = r[i];
      if (v === undefined) throw new Error('short row');
      return v;
    };
    const part_price = pyFloat(get(partPrice));
    const labor_price = pyFloat(get(laborPrice));
    if (part_price === null || labor_price === null)
      throw new Error('price is not a number');
    byCode.set(get(code), {
      code: get(code),
      description: get(description),
      aliases: get(aliases).toLowerCase().split('|'),
      part_price,
      labor_price,
    });
  }
  return [...byCode.values()];
}

/** Up to MAX_HINTS parts.csv rows whose code, description or aliases contain q (any case); [] for an empty q. */
export function hints(q: string, catalogPath: string): Hint[] {
  const want = pyStrip(q).toLowerCase();
  if (!want) return [];
  let cat: Part[];
  try {
    cat = loadCatalog(catalogPath);
  } catch {
    return []; // missing or malformed: no hints, never a 500
  }
  return cat
    .filter(
      (p) =>
        p.code.toLowerCase().includes(want) ||
        p.description.toLowerCase().includes(want) ||
        p.aliases.some((a) => a.includes(want)),
    )
    .slice(0, MAX_HINTS)
    .map(({ code, description, part_price, labor_price }) => ({
      code,
      description,
      part_price,
      labor_price,
    }));
}

const vehicleCache = new Map<string, Buffer>();

/** vehicles.json as bytes, read once per path; {} when missing or not JSON. */
export function vehicles(path: string): Buffer {
  let raw = vehicleCache.get(path);
  if (!raw) {
    try {
      raw = readFileSync(path);
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      raw = Buffer.from('{}');
    }
    vehicleCache.set(path, raw);
  }
  return raw;
}

export function catalogRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  r.get('/api/vehicles', signedIn(), (req, res) => {
    res.setHeader('Content-Type', 'application/json'); // as Python: the file's bytes, no charset added
    res.send(vehicles(depsOf(req).config.vehicles));
  });
  r.get('/api/catalog', signedIn('admin', 'mechanic'), (req, res) => {
    res.json(
      hints(
        queryValues(req.originalUrl, 'q')[0] ?? '',
        depsOf(req).config.catalog,
      ),
    );
  });
  return r;
}
