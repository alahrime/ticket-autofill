// Copies InvoMax's INVOICE.btv and DETAIL.btv (read-only: never written, locked or renamed there), decodes
// them and upserts into invomax.db. Logs counts, invoice numbers and class names only (shop.log).
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  /** Replaces copyTable (tests inject failures). */
  copy?: (src: string, dest: string) => void;
};

export const RETRIES = 3;
export const RETRY_MS = 60_000;

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

export class ImportRefused extends Error {}
class TooFewBills extends Error {}

const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN']);
/** A torn read, a short read, or InvoMax holding a file for a moment: worth another try. */
function retryable(e: unknown): boolean {
  if (e instanceof BtrieveError || e instanceof TooFewBills) return true;
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && TRANSIENT.has(code);
}

/** The import lock: an open connection holding an EXCLUSIVE transaction on lock.db (the OS drops it if we die). */
export type Lock = { db: DatabaseSync };

/** The lock taken, or null when another import (any process) holds it. No stale files: a crash frees it. */
export function takeLock(dir: string): Lock | null {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'lock.db'));
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
    return { db };
  } catch (e) {
    try {
      db.close();
    } catch {
      // nothing to free
    }
    const msg = String((e as Error)?.message ?? e);
    if (/locked|busy/i.test(msg) || (e as { errcode?: number })?.errcode === 5) return null;
    throw e;
  }
}

/** Ends the lock's transaction and closes its connection; never throws. */
export function releaseLock(lock: Lock): void {
  try {
    lock.db.exec('ROLLBACK');
  } catch {
    // closing frees it anyway
  }
  try {
    lock.db.close();
  } catch {
    // already closed
  }
}

const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const within = (inner: string, outer: string): boolean => {
  const rel = relative(norm(outer), norm(inner));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Refuses when the import folder and InvoMax's folder overlap: nothing may ever be written in InvoMax's. */
function checkFolders(config: Config): void {
  if (within(config.importDir, config.invomaxDir) || within(config.invomaxDir, config.importDir))
    throw new ImportRefused('import folder is inside the InvoMax folder');
}

/** vehicles.json, or null when it can't be read (the vehicle columns are then left alone). */
function loadVehicles(config: Config): Vehicles | null {
  try {
    const v: unknown = JSON.parse(readFileSync(config.vehicles, 'utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Vehicles) : null;
  } catch {
    return null;
  }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const realSleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
const NO_VEHICLE = { year: null, make: '', model: '', trim: '' };
const empty = { invoices: 0, lines: 0, added: 0, changed: 0, gone: 0 };

type Decoded = ReturnType<typeof readInvoiceFiles>;
type Existing = { hash: string; lines_hash: string; gone_at: string };

/** Upserts one decoded read in one transaction -> counts. */
function upsert(db: DatabaseSync, d: Decoded, vehicles: Vehicles | null, vhash: string, now: string): typeof empty {
  const cache = new Map<string, ReturnType<typeof parseVehicle>>();
  const vehicleOf = (text: string): ReturnType<typeof parseVehicle> => {
    if (!vehicles) return NO_VEHICLE;
    let v = cache.get(text);
    if (!v) cache.set(text, (v = parseVehicle(text, vehicles)));
    return v;
  };
  const lastHash = (
    db.prepare('SELECT vehicles_hash AS h FROM im_imports WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() as
      | { h: string }
      | undefined
  )?.h;

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
      const v = vehicleOf(l.vehicle);
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

    if (vehicles && vhash !== lastHash) {
      // a new vehicles.json: every stored line is read against it again, unchanged bills included
      const setVehicle = db.prepare(
        'UPDATE im_lines SET year = ?, make = ?, model = ?, trim = ? WHERE invoice_no = ? AND line_no = ?',
      );
      const rows = db.prepare('SELECT invoice_no, line_no, vehicle FROM im_lines').all() as {
        invoice_no: string;
        line_no: number;
        vehicle: string;
      }[];
      for (const r of rows) {
        const v = vehicleOf(r.vehicle);
        setVehicle.run(v.year, v.make, v.model, v.trim, r.invoice_no, r.line_no);
      }
    }

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
 * One import: lock, copy both tables into importDir, decode (retrying a torn or short read, or InvoMax holding a
 * file, 3 times a minute apart), upsert, record an im_imports row and log the counts. Never rejects: ok is false.
 */
export async function importOnce(config: Config, opts: ImportOpts = {}): Promise<ImportResult> {
  const sleep = opts.sleep ?? realSleep;
  const now = (): string => {
    try {
      return nowIso((opts.now ?? (() => new Date()))());
    } catch {
      return nowIso(new Date());
    }
  };
  const started = now();
  let lock: Lock | null = null;
  let db: DatabaseSync | undefined;
  let tries = 0;
  try {
    checkFolders(config); // before anything is created
    lock = takeLock(config.importDir); // synchronous: a second call in this process sees it
    if (!lock) return { ok: false, tries: 0, ...empty, error: 'already running' };
    await Promise.resolve(); // yield once with the lock held, so a second call in this process meets it
    db = openImDb(config.invomaxDb);
    const vehicles = opts.vehicles ?? loadVehicles(config);
    const vhash = vehicles ? sha(JSON.stringify(vehicles)) : '';
    if (!vehicles) logLine(config.log, 'invomax import vehicles unreadable');
    const copy = opts.copy ?? copyTable;
    const invoiceCopy = join(config.importDir, 'INVOICE.btv');
    const detailCopy = join(config.importDir, 'DETAIL.btv');
    for (;;) {
      tries++;
      const t0 = Date.now();
      try {
        copy(join(config.invomaxDir, 'INVOICE.btv'), invoiceCopy);
        copy(join(config.invomaxDir, 'DETAIL.btv'), detailCopy);
        const d = readInvoiceFiles(readFileSync(invoiceCopy), readFileSync(detailCopy));
        const stored = (db.prepare("SELECT count(*) AS n FROM im_invoices WHERE gone_at = ''").get() as { n: number }).n;
        if ((stored >= 100 && d.invoices.length < stored * 0.9) || (d.invoices.length > 0 && d.lines.length === 0))
          throw new TooFewBills(`too few bills (${d.invoices.length} of ${stored})`);
        const c = upsert(db, d, vehicles, vhash, now());
        const ms = Date.now() - t0;
        db.prepare(
          `INSERT INTO im_imports (started, finished, ok, tries, invoices, lines, added, changed, gone, odd, bad, duplicates, ms, vehicles_hash)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(started, now(), tries, c.invoices, c.lines, c.added, c.changed, c.gone, d.oddNumbers, d.badNumbers, d.duplicates, ms, vhash);
        logLine(config.log, `invomax import ok ${c.invoices}/${c.lines} +${c.added} ~${c.changed} -${c.gone}`);
        logLine(config.log, `invomax import notes odd ${d.oddNumbers} bad ${d.badNumbers} dup ${d.duplicates} ${ms}ms`);
        return { ok: true, tries, ...c, error: '' };
      } catch (e) {
        if (!retryable(e) || tries > RETRIES) throw e;
      }
      await sleep(RETRY_MS);
    }
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    logLine(config.log, `invomax import failed ${className(e)}`);
    try {
      db ??= openImDb(config.invomaxDb);
      db.prepare(
        `INSERT INTO im_imports (started, finished, ok, tries, invoices, lines, added, changed, gone, error)
         VALUES (?, ?, 0, ?, 0, 0, 0, 0, 0, ?)`,
      ).run(started, now(), tries, error);
    } catch {
      // no database to note it in: the log line is all there is
    }
    return { ok: false, tries, ...empty, error };
  } finally {
    try {
      db?.close();
    } catch {
      // closing must not keep the lock
    } finally {
      if (lock) releaseLock(lock);
    }
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
