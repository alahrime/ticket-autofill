// Backups of tickets.db and invomax.db (SQLite online backup), pruning, copy to a USB drive, and restore.
// Only files named exactly tickets-YYYY-MM-DD.db or invomax-YYYY-MM-DD.db are ever pruned or copied.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { Config } from './config';
import { BadInput } from './errors';

const DATED = /^(tickets|invomax)-(\d{4})-(\d{2})-(\d{2})\.db$/;
const TICKETS_KEPT = 90;
const INVOMAX_DAILY = 14;
const INVOMAX_MONTHS = 24;
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

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
  const source = new DatabaseSync(src);
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

/** Throws unless PRAGMA quick_check says ok. */
function quickCheck(file: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    const r = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    if (r.length !== 1 || Object.values(r[0] ?? {})[0] !== 'ok') throw new Error('backup failed its check');
  } catch (e) {
    throw e instanceof Error && e.message === 'backup failed its check' ? e : new Error('backup failed its check');
  } finally {
    db?.close();
  }
}

/** Writes backups/tickets-<local date>.db and, if invomax.db exists, backups/invomax-<local date>.db. */
export async function backupNow(config: Config, now: Date): Promise<{ tickets: string; invomax: string | null }> {
  mkdirSync(config.backups, { recursive: true });
  const day = ymd(now);
  const tickets = join(config.backups, `tickets-${day}.db`);
  await backupOne(config.db, tickets);
  let invomax: string | null = null;
  if (existsSync(config.invomaxDb)) {
    invomax = join(config.backups, `invomax-${day}.db`);
    await backupOne(config.invomaxDb, invomax);
  }
  return { tickets, invomax };
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

/** The date in the newest tickets-*.db name (local midnight), or null. */
export function lastGoodBackup(dir: string): Date | null {
  const newest = dated(dir, 'tickets')[0];
  const m = newest ? DATED.exec(newest) : null;
  return m ? new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4])) : null;
}

/** last: newest tickets backup date; stale: none in the last 2 days; offsite: when it was last copied off the PC. */
export function backupHealth(dir: string, now: Date): { last: string | null; stale: boolean; offsite: string | null } {
  const last = lastGoodBackup(dir);
  let offsite: string | null = null;
  try {
    const j: unknown = JSON.parse(readFileSync(join(dir, 'offsite.json'), 'utf8'));
    const at = (j as { at?: unknown } | null)?.at;
    if (typeof at === 'string') offsite = at;
  } catch {
    offsite = null;
  }
  return {
    last: last ? ymd(last) : null,
    stale: last === null || now.getTime() - last.getTime() > STALE_MS,
    offsite,
  };
}

/** Copies the dated backups to target (made if missing), skipping a file already there with the same size. */
export function copyBackups(dir: string, target: string, now: Date): { copied: number; skipped: number } {
  const where = resolve(target);
  if (!existsSync(parse(where).root)) throw new BadInput('drive not found');
  mkdirSync(where, { recursive: true });
  const names = [...dated(dir, 'tickets'), ...dated(dir, 'invomax')];
  let copied = 0;
  let skipped = 0;
  for (const n of names) {
    const from = join(dir, n);
    const to = join(where, n);
    if (existsSync(to) && statSync(to).size === statSync(from).size) {
      skipped++;
      continue;
    }
    const tmp = `${to}.tmp`;
    try {
      copyFileSync(from, tmp);
      renameSync(tmp, to);
    } catch (e) {
      removeFiles(tmp);
      throw e;
    }
    copied++;
  }
  if (names.length && names.every((n) => existsSync(join(where, n)))) {
    writeFileSync(join(dir, 'offsite.json'), JSON.stringify({ at: now.toISOString(), target: where }));
  }
  return { copied, skipped };
}

function serverIsUp(host: string, port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect({ host, port });
    s.setTimeout(2000);
    s.once('connect', () => {
      s.destroy();
      ok(true);
    });
    s.once('error', () => ok(false));
    s.once('timeout', () => {
      s.destroy();
      ok(false);
    });
  });
}

/** Puts a backup in place of tickets.db or invomax.db (by the file name); the old file is set aside -> its name. */
export async function restoreBackup(file: string, config: Config): Promise<string> {
  if (await serverIsUp(config.host, config.port)) throw new Error('stop the shop server first');
  const prefix = /^(tickets|invomax)-/.exec(basename(file))?.[1];
  if (!prefix) throw new BadInput('the file name must start with tickets- or invomax-');
  if (!existsSync(file)) throw new BadInput('backup file not found');
  const live = prefix === 'tickets' ? config.db : config.invomaxDb;
  const staged = `${live}.restoring`;
  removeFiles(staged, `${staged}-wal`, `${staged}-shm`);
  try {
    copyFileSync(file, staged);
    quickCheck(staged);
  } catch (e) {
    removeFiles(staged, `${staged}-wal`, `${staged}-shm`);
    throw e;
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const aside = `${basename(live)}.before-restore-${stamp}`;
  if (existsSync(live)) {
    for (const ext of ['', '-wal', '-shm']) {
      if (existsSync(live + ext)) renameSync(live + ext, join(dirname(live), aside + ext));
    }
  }
  renameSync(staged, live);
  return existsSync(join(dirname(live), aside)) ? aside : '';
}
