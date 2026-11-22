// Backups of tickets.db and invomax.db (SQLite online backup), pruning, copy to a USB drive, and restore.
// Only files named exactly tickets-YYYY-MM-DD.db or invomax-YYYY-MM-DD.db are ever pruned or copied.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
} from 'node:fs';
import { copyFile, mkdir, open, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { Config } from './config';
import { BadInput } from './errors';
import { className } from './http/log';
import { releaseLock, takeLock } from './invomax/import';

const DATED = /^(tickets|invomax)-(\d{4})-(\d{2})-(\d{2})\.db$/;
const TICKETS_KEPT = 90;
const INVOMAX_DAILY = 14;
const INVOMAX_MONTHS = 24;
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 2 * DAY_MS;
const OFFSITE_STALE_MS = 7 * DAY_MS;
const ATTEMPT = 'offsite-attempt.json'; // the last copy to the USB drive: { at, ok, error: its error class or null }

const pad = (n: number): string => String(n).padStart(2, '0');
/** The local date of d as YYYY-MM-DD (file names use the local date). */
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Names in dir matching `<kind>-YYYY-MM-DD.db`, newest first (the date sorts as text). */
function dated(dir: string, kind: 'tickets' | 'invomax'): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => DATED.exec(n)?.[1] === kind)
    .sort()
    .reverse();
}

function removeFiles(...paths: string[]): void {
  for (const p of paths) rmSync(p, { force: true });
}

/** Online backup of src into dest (via dest.tmp), checked with quick_check, then renamed into place. */
async function backupOne(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.tmp`;
  removeFiles(tmp, `${tmp}-wal`, `${tmp}-shm`);
  const source = new DatabaseSync(src, { readOnly: true }); // a missing file is an error, never a new empty db
  try {
    source.exec('PRAGMA busy_timeout = 5000');
    await backup(source, tmp);
  } catch (e) {
    source.close();
    removeFiles(tmp, `${tmp}-wal`, `${tmp}-shm`);
    throw e;
  }
  source.close();
  try {
    quickCheck(tmp);
  } catch (e) {
    removeFiles(tmp, `${tmp}-wal`, `${tmp}-shm`);
    throw e;
  }
  renameSync(tmp, dest);
}

/** Throws unless PRAGMA quick_check says ok; with tables, also unless each of them exists. */
function quickCheck(file: string, readOnly = false, tables: string[] = [], what = 'backup'): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly });
    const r = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    if (r.length !== 1 || Object.values(r[0] ?? {})[0] !== 'ok') throw new Error('backup failed its check');
    for (const t of tables) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t))
        throw new BadInput(`not a ${what} backup`);
    }
  } catch (e) {
    if (e instanceof BadInput) throw e;
    throw new Error('backup failed its check');
  } finally {
    db?.close();
  }
}

export type BackupKind = 'tickets' | 'invomax';

/** Writes backups/<kind>-<local date>.db -> its path; null for invomax when there is no invomax.db. */
export async function backupFile(config: Config, kind: BackupKind, now: Date): Promise<string | null> {
  const src = kind === 'tickets' ? config.db : config.invomaxDb;
  if (kind === 'invomax' && !existsSync(src)) return null;
  mkdirSync(config.backups, { recursive: true });
  const dest = join(config.backups, `${kind}-${ymd(now)}.db`);
  await backupOne(src, dest);
  return dest;
}

/** Writes backups/tickets-<local date>.db and, if invomax.db exists, backups/invomax-<local date>.db. */
export async function backupNow(config: Config, now: Date): Promise<{ tickets: string; invomax: string | null }> {
  const tickets = (await backupFile(config, 'tickets', now)) as string;
  return { tickets, invomax: await backupFile(config, 'invomax', now) };
}

/** Deletes old backups (tickets: newest 90; invomax: newest 14 plus the first file of each of the newest 24 months) -> removed names. */
export function pruneBackups(dir: string, now: Date): string[] {
  void now; // the rule counts files, not days, so a missed night never costs an older copy
  const doomed: string[] = [];
  doomed.push(...dated(dir, 'tickets').slice(TICKETS_KEPT));

  const im = dated(dir, 'invomax'); // newest first
  const keep = new Set(im.slice(0, INVOMAX_DAILY));
  const firstOfMonth = new Map<string, string>(); // YYYY-MM -> earliest name
  for (const n of [...im].reverse()) {
    const month = n.slice('invomax-'.length, 'invomax-'.length + 7);
    if (!firstOfMonth.has(month)) firstOfMonth.set(month, n);
  }
  for (const month of [...firstOfMonth.keys()].sort().reverse().slice(0, INVOMAX_MONTHS)) {
    const n = firstOfMonth.get(month);
    if (n) keep.add(n);
  }
  doomed.push(...im.filter((n) => !keep.has(n)));

  for (const n of doomed) rmSync(join(dir, n), { force: true });
  return doomed;
}

/** The date in the newest <kind>-*.db name (local midnight), or null. */
export function lastGoodBackup(dir: string, kind: BackupKind = 'tickets'): Date | null {
  const newest = dated(dir, kind)[0];
  const m = newest ? DATED.exec(newest) : null;
  return m ? new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4])) : null;
}

/** A small JSON file's object, or null when it is missing or not an object. */
function readJson(file: string): Record<string, unknown> | null {
  try {
    const j: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return j !== null && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type BackupHealth = {
  /** The newest tickets backup's date. */
  last: string | null;
  /** No tickets backup in the last 2 days, or (when there is an invomax.db) no invomax one. */
  stale: boolean;
  /** The newest invomax backup's date. */
  invomax: string | null;
  /** When the backups were last all copied off this PC. */
  offsite: string | null;
  /** That copy is more than 7 days old, or the last copy failed. */
  offsite_stale: boolean;
  /** The last copy's error class when it failed, else null. */
  offsite_failed: string | null;
};

/** How the backups stand; invomaxDb given and there: its backups count toward stale too. */
export function backupHealth(dir: string, now: Date, invomaxDb?: string): BackupHealth {
  const old = (d: Date | null): boolean => d === null || now.getTime() - d.getTime() > STALE_MS;
  const last = lastGoodBackup(dir, 'tickets');
  const im = lastGoodBackup(dir, 'invomax');
  const at = readJson(join(dir, 'offsite.json'))?.['at'];
  const offsite = typeof at === 'string' ? at : null;
  const attempt = readJson(join(dir, ATTEMPT));
  const failed = attempt && attempt['ok'] === false ? String(attempt['error'] ?? 'unknown').slice(0, 80) : null;
  const copied = offsite === null ? NaN : Date.parse(offsite);
  return {
    last: last ? ymd(last) : null,
    stale: old(last) || (invomaxDb !== undefined && existsSync(invomaxDb) && old(im)),
    invomax: im ? ymd(im) : null,
    offsite,
    offsite_stale: failed !== null || (offsite !== null && !(now.getTime() - copied <= OFFSITE_STALE_MS)),
    offsite_failed: failed,
  };
}

/** An error's class, with its errno code when it has one (Error ENOSPC): never its message. */
function errorClass(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^E[A-Z]{2,15}$/.test(code) ? `${className(e)} ${code}` : className(e);
}

const sameRoot = (a: string, b: string): boolean =>
  parse(resolve(a)).root.toLowerCase() === parse(resolve(b)).root.toLowerCase();
const MTIME_SLACK_MS = 2000; // FAT (USB sticks) stores times to 2 seconds

const DRIVE = /^[A-Za-z]:\\?$/;

/** Is `s` a bare drive letter (D: or D:\)? */
export const isDrive = (s: string): boolean => DRIVE.test(s);

/**
 * Where backups go on a target: a bare drive letter (D: or D:\) means <drive>\shop-backups (the
 * `copy-backups` command's folder); any other entry of shop-settings.json's backupTargets is used as given.
 */
export function backupFolder(target: string): string {
  if (!isDrive(target)) return target;
  return join(`${target.slice(0, 2)}\\`, 'shop-backups'); // "E:" alone would mean that drive's current folder
}

export type CopyOpts = {
  /** Tests only: allow a target on the backups' own drive. */
  allowSameDrive?: boolean;
  /** Tests only: runs on each fresh copy (still named .tmp) before its check; may hold the copy (a promise). */
  afterCopy?: (tmpPath: string) => void | Promise<void>;
};

/** The file's SHA-256 (hex), read as a stream. */
async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** stat, or null when the file isn't there. */
const statOrNull = async (p: string): Promise<Stats | null> => {
  try {
    return await stat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

/**
 * Copies the dated backups to target (made if missing), skipping a file already there with the same size and
 * mtime, then prunes the target by pruneBackups' rule. Asynchronous (fs.promises) so a long copy to the USB drive
 * never holds up the server's requests. Each attempt, good or failed (by its error class), is noted in
 * offsite-attempt.json beside offsite.json.
 */
export async function copyBackups(
  dir: string,
  target: string,
  now: Date,
  opts: CopyOpts = {},
): Promise<{ copied: number; skipped: number }> {
  const note = async (ok: boolean, error: string | null): Promise<void> => {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ATTEMPT), JSON.stringify({ at: now.toISOString(), ok, error }));
    } catch {
      // the copy's own outcome is what the caller hears
    }
  };
  try {
    const r = await copyOnce(dir, target, now, opts);
    await note(true, null);
    return r;
  } catch (e) {
    await note(false, errorClass(e));
    throw e;
  }
}

async function copyOnce(dir: string, target: string, now: Date, opts: CopyOpts): Promise<{ copied: number; skipped: number }> {
  const where = resolve(target);
  if (!existsSync(parse(where).root)) throw new BadInput('drive not found');
  if (!opts.allowSameDrive && sameRoot(where, dir)) throw new BadInput('that drive holds the backups already; use the USB drive');
  await mkdir(where, { recursive: true });
  const names = [...dated(dir, 'tickets'), ...dated(dir, 'invomax')];
  const vanished = new Set<string>(); // pruned on this PC while the copy ran: nothing to copy
  let copied = 0;
  let skipped = 0;
  for (const n of names) {
    const from = join(dir, n);
    const to = join(where, n);
    const src = await statOrNull(from);
    if (!src) {
      vanished.add(n);
      continue;
    }
    const have = await statOrNull(to);
    if (have && have.size === src.size && Math.abs(have.mtimeMs - src.mtimeMs) <= MTIME_SLACK_MS) {
      skipped++;
      continue;
    }
    const tmp = `${to}.tmp`;
    try {
      try {
        await copyFile(from, tmp);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(from)) {
          removeFiles(tmp);
          vanished.add(n); // pruned on this PC between the stat and the copy
          continue;
        }
        throw e;
      }
      const fh = await open(tmp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await utimes(tmp, src.atime, src.mtime);
      await opts.afterCopy?.(tmp);
      // the copy, read back from the drive, must be the source byte for byte (streamed: a 58 MB invomax
      // backup on a slow USB stick never holds up requests). The source was quick_checked when it was made.
      const [want, got] = await Promise.all([sha256(from), sha256(tmp)]);
      if (want !== got) throw new Error('copy did not match');
      await rename(tmp, to);
    } catch (e) {
      removeFiles(tmp, `${tmp}-wal`, `${tmp}-shm`);
      throw e;
    }
    copied++;
  }
  const kept = names.filter((n) => !vanished.has(n));
  if (kept.length && kept.every((n) => existsSync(join(where, n)))) {
    await writeFile(join(dir, 'offsite.json'), JSON.stringify({ at: now.toISOString(), target: where }));
  }
  pruneBackups(where, now); // the drive keeps what this PC keeps, so it never fills up
  return { copied, skipped };
}

/** Only a refused connection means nobody is serving; a timeout or any other error counts as "up". */
function serverIsUp(host: string, port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect({ host, port });
    s.setTimeout(2000);
    s.once('connect', () => {
      s.destroy();
      ok(true);
    });
    s.once('error', (e: NodeJS.ErrnoException) => ok(e.code !== 'ECONNREFUSED'));
    s.once('timeout', () => {
      s.destroy();
      ok(true);
    });
  });
}

export type RestoreOpts = { rename?: (from: string, to: string) => void }; // tests: a rename that can fail

/** Puts a backup in place of tickets.db or invomax.db (by the file name); the old file is set aside -> its name. */
export async function restoreBackup(file: string, config: Config, opts: RestoreOpts = {}): Promise<string> {
  if (await serverIsUp(config.host, config.port)) throw new Error('stop the shop server first');
  const prefix = /^(tickets|invomax)-/.exec(basename(file))?.[1];
  if (!prefix) throw new BadInput('the file name must start with tickets- or invomax-');
  if (!existsSync(file)) throw new BadInput('backup file not found');
  if (prefix === 'tickets') return swapIn(file, config.db, ['tickets'], 'tickets', opts);
  const lock = takeLock(config.importDir);
  if (!lock) throw new Error('an InvoMax import is running; try again later');
  try {
    return swapIn(file, config.invomaxDb, ['im_invoices', 'im_lines'], 'invomax', opts);
  } finally {
    releaseLock(lock);
  }
}

function swapIn(file: string, live: string, tables: string[], what: string, opts: RestoreOpts): string {
  const rename = opts.rename ?? renameSync;
  const staged = `${live}.restoring`;
  const cleanStaged = (): void => removeFiles(staged, `${staged}-wal`, `${staged}-shm`);
  cleanStaged();
  try {
    copyFileSync(file, staged);
    quickCheck(staged, false, tables, what);
  } catch (e) {
    cleanStaged();
    throw e;
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const aside = `${basename(live)}.before-restore-${stamp}`;
  const moved: Array<[string, string]> = []; // [from, to] already renamed
  try {
    for (const ext of ['', '-wal', '-shm']) {
      if (!existsSync(live + ext)) continue;
      const to = join(dirname(live), aside + ext);
      rename(live + ext, to);
      moved.push([live + ext, to]);
    }
    rename(staged, live);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const stuck: string[] = [];
    for (const [from, to] of [...moved].reverse()) {
      try {
        rename(to, from);
      } catch {
        stuck.push(basename(to));
      }
    }
    if (stuck.length) {
      throw new Error(
        `Restore failed (${why}) and could not put the old files back. Your data is in ${stuck.join(', ')} (in ${dirname(live)}); ` +
          `the backup copy is ${staged}. Rename the ${basename(live)}.before-restore files back to ${basename(live)} before starting the shop server.`,
      );
    }
    cleanStaged();
    throw new Error(`Restore failed and was undone; the old file is back in place (${why})`);
  }
  return moved.length ? aside : '';
}
