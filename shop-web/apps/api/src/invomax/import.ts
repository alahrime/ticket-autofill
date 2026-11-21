// Copies InvoMax's INVOICE.btv and DETAIL.btv (read-only: never written, locked or renamed there), decodes
// them and upserts into invomax.db. Logs counts, invoice numbers and class names only (shop.log).
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '@shop/domain';
import { BtrieveError, type ImLine, parseVehicle, readInvoiceFiles, type Vehicles } from '@shop/invomax';
import type { Config } from '../config';
import { className, logLine } from '../http/log';
import { openImDb } from './imdb';

export type ImportResult = {
  ok: boolean;
  tries: number;
  invoices: number;
  lines: number;
  added: number;
  changed: number;
  gone: number;
  error: string;
};

export type ImportOpts = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  vehicles?: Vehicles;
};

export const RETRIES = 3;
export const RETRY_MS = 60_000;
const STALE_LOCK_MS = 30 * 60_000;

/** Copies src to dest + '.tmp' (src opened read-only, nothing written there), then renames over dest. */
export function copyTable(src: string, dest: string): void {
  const tmp = `${dest}.tmp`;
  const from = openSync(src, 'r');
  try {
    const to = openSync(tmp, 'w');
    try {
      const buf = Buffer.alloc(1 << 20);
      for (;;) {
        const n = readSync(from, buf, 0, buf.length, null);
        if (n === 0) break;
        for (let at = 0; at < n; ) at += writeSync(to, buf, at, n - at);
      }
    } finally {
      closeSync(to);
    }
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    closeSync(from);
  }
}

/** The lock file's path taken, or null when another import holds it (a lock older than 30 minutes is taken over). */
function takeLock(dir: string): string | null {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, 'wx'));
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(path).mtimeMs <= STALE_LOCK_MS) return null;
        rmSync(path, { force: true });
      } catch {
        // vanished or unreadable meanwhile: try once more
      }
    }
  }
  return null;
}

function loadVehicles(config: Config): Vehicles {
  try {
    const v: unknown = JSON.parse(readFileSync(config.vehicles, 'utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Vehicles) : {};
  } catch {
    return {}; // the vehicle fields stay empty; the import goes on
  }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const realSleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
const empty = { invoices: 0, lines: 0, added: 0, changed: 0, gone: 0 };

type Decoded = ReturnType<typeof readInvoiceFiles>;
type Existing = { hash: string; lines_hash: string; gone_at: string };

/** Upserts one decoded read in one transaction -> counts. */
function upsert(db: DatabaseSync, d: Decoded, vehicles: Vehicles, now: string): typeof empty {
  const existing = new Map<string, Existing>();
  for (const r of db.prepare('SELECT invoice_no, hash, lines_hash, gone_at FROM im_invoices').all() as (Existing & {
    invoice_no: string;
  })[])
    existing.set(r.invoice_no, r);

  const byInvoice = new Map<string, ImLine[]>();
  for (const l of d.lines) {
    const list = byInvoice.get(l.invoice_no);
    if (list) list.push(l);
    else byInvoice.set(l.invoice_no, [l]);
  }
  for (const list of byInvoice.values()) list.sort((a, b) => a.line_no - b.line_no);

  const insInvoice = db.prepare(
    `INSERT INTO im_invoices (invoice_no, "date", "key", name, "first", "last", phone, plate, address, parts, labor, supplies,
       discount, deposit, tax, total, balance, tax_rate, hash, lines_hash, first_seen, updated_at, gone_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
  );
  const updInvoice = db.prepare(
    `UPDATE im_invoices SET "date" = ?, "key" = ?, name = ?, "first" = ?, "last" = ?, phone = ?, plate = ?, address = ?,
       parts = ?, labor = ?, supplies = ?, discount = ?, deposit = ?, tax = ?, total = ?, balance = ?, tax_rate = ?,
       hash = ?, lines_hash = ?, updated_at = ?, gone_at = '' WHERE invoice_no = ?`,
  );
  const comeBack = db.prepare("UPDATE im_invoices SET gone_at = '' WHERE invoice_no = ?");
  const delLines = db.prepare('DELETE FROM im_lines WHERE invoice_no = ?');
  const insLine = db.prepare(
    `INSERT OR REPLACE INTO im_lines (invoice_no, line_no, code, description, kind, qty, unit, amount, vehicle, year, make, model, trim)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const putLines = (no: string, list: ImLine[]): void => {
    delLines.run(no);
    for (const l of list) {
      const v = parseVehicle(l.vehicle, vehicles);
      insLine.run(no, l.line_no, l.code, l.description, l.kind, l.qty, l.unit, l.amount, l.vehicle, v.year, v.make, v.model, v.trim);
    }
  };

  let added = 0;
  let changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const seen = new Set<string>();
    for (const i of d.invoices) {
      seen.add(i.invoice_no);
      const mine = byInvoice.get(i.invoice_no) ?? [];
      const linesHash = sha(JSON.stringify(mine));
      const fields = [
        i.date, i.key, i.name, i.first, i.last, i.phone, i.plate, i.address,
        i.parts, i.labor, i.supplies, i.discount, i.deposit, i.tax, i.total, i.balance, i.tax_rate,
        i.hash, linesHash,
      ] as const;
      const old = existing.get(i.invoice_no);
      if (!old) {
        insInvoice.run(i.invoice_no, ...fields, now, now);
        putLines(i.invoice_no, mine);
        added++;
      } else if (old.hash !== i.hash || old.lines_hash !== linesHash) {
        updInvoice.run(...fields, now, i.invoice_no);
        putLines(i.invoice_no, mine);
        changed++;
      } else if (old.gone_at !== '') {
        comeBack.run(i.invoice_no);
      }
    }
    // Lines of no invoice (orphans) are stored too, replaced each time (a few dozen rows).
    for (const [no, list] of byInvoice) if (!seen.has(no) && !existing.has(no)) putLines(no, list);

    let gone = 0;
    const markGone = db.prepare('UPDATE im_invoices SET gone_at = ? WHERE invoice_no = ?');
    for (const [no, old] of existing) {
      if (!seen.has(no) && old.gone_at === '') {
        markGone.run(now, no);
        gone++;
      }
    }
    db.exec('COMMIT');
    return { invoices: d.invoices.length, lines: d.lines.length, added, changed, gone };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * One import: lock, copy both tables into importDir, decode (retrying a torn copy 3 times, a minute apart),
 * upsert, record an im_imports row and log the counts. Never throws for a failed import: ok is false.
 */
export async function importOnce(config: Config, opts: ImportOpts = {}): Promise<ImportResult> {
  const lock = takeLock(config.importDir); // synchronous: a second call in this process sees it
  if (!lock) return { ok: false, tries: 0, ...empty, error: 'already running' };
  const sleep = opts.sleep ?? realSleep;
  await Promise.resolve(); // yield once with the lock held, so a second call in this process meets it
  const now = opts.now ?? (() => new Date());
  const started = nowIso(now());
  let db: DatabaseSync | undefined;
  let tries = 0;
  let outcome: { counts: typeof empty; d: Decoded; ms: number } | { error: unknown };
  try {
    db = openImDb(config.invomaxDb);
    const vehicles = opts.vehicles ?? loadVehicles(config);
    const invoiceCopy = join(config.importDir, 'INVOICE.btv');
    const detailCopy = join(config.importDir, 'DETAIL.btv');
    for (;;) {
      tries++;
      const t0 = Date.now();
      try {
        copyTable(join(config.invomaxDir, 'INVOICE.btv'), invoiceCopy);
        copyTable(join(config.invomaxDir, 'DETAIL.btv'), detailCopy);
        const d = readInvoiceFiles(readFileSync(invoiceCopy), readFileSync(detailCopy));
        const counts = upsert(db, d, vehicles, nowIso(now()));
        outcome = { counts, d, ms: Date.now() - t0 };
        break;
      } catch (e) {
        if (!(e instanceof BtrieveError) || tries > RETRIES) {
          outcome = { error: e };
          break;
        }
      }
      await sleep(RETRY_MS);
    }
    const finished = nowIso(now());
    if ('error' in outcome) {
      const error = String((outcome.error as Error)?.message ?? outcome.error).slice(0, 300);
      db.prepare(
        `INSERT INTO im_imports (started, finished, ok, tries, invoices, lines, added, changed, gone, error)
         VALUES (?, ?, 0, ?, 0, 0, 0, 0, 0, ?)`,
      ).run(started, finished, tries, error);
      logLine(config.log, `invomax import failed ${className(outcome.error)}`);
      return { ok: false, tries, ...empty, error };
    }
    const { counts: c, d, ms } = outcome;
    db.prepare(
      `INSERT INTO im_imports (started, finished, ok, tries, invoices, lines, added, changed, gone, odd, bad, duplicates, ms)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(started, finished, tries, c.invoices, c.lines, c.added, c.changed, c.gone, d.oddNumbers, d.badNumbers, d.duplicates, ms);
    logLine(config.log, `invomax import ok ${c.invoices}/${c.lines} +${c.added} ~${c.changed} -${c.gone}`);
    logLine(config.log, `invomax import notes odd ${d.oddNumbers} bad ${d.badNumbers} dup ${d.duplicates} ${ms}ms`);
    return { ok: true, tries, ...c, error: '' };
  } catch (e) {
    logLine(config.log, `invomax import failed ${className(e)}`);
    return { ok: false, tries, ...empty, error: String((e as Error)?.message ?? e).slice(0, 300) };
  } finally {
    db?.close();
    rmSync(lock, { force: true });
  }
}

/** The newest import row, or null before any. */
export function lastImport(db: DatabaseSync): { finished: string; ok: boolean; invoices: number } | null {
  const r = db.prepare('SELECT finished, ok, invoices FROM im_imports ORDER BY id DESC LIMIT 1').get() as
    | { finished: string; ok: number; invoices: number }
    | undefined;
  return r ? { finished: r.finished, ok: r.ok === 1, invoices: r.invoices } : null;
}

/** When the newest good import finished, or null. */
export function lastGoodImport(db: DatabaseSync): string | null {
  const r = db.prepare('SELECT finished FROM im_imports WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() as
    | { finished: string }
    | undefined;
  return r?.finished ?? null;
}
