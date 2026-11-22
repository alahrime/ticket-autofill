// The nightly run: at 02:00 local time (and as a catch-up when the PC was off or signed out then), our own
// backup, its pruning and the copy to the USB drive, then the InvoMax import and auto-linking. Checked at start
// and every 5 minutes; whatever fails is logged by class name and tried again on a later check, never thrown.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { backupFolder, backupNow, copyBackups, pruneBackups } from './backup';
import type { Config } from './config';
import { BadInput } from './errors';
import type { LinkStore } from './history/links';
import { className, logLine } from './http/log';
import { importOnce, lastGoodImport } from './invomax/import';
import { every, type Schedule } from './purge';

export const NIGHTLY_CHECK_MS = 300_000;

/** Today's 02:00 (local) if `now` is at or after it, else yesterday's. */
export function latestTwoAm(now: Date): Date {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 0, 0, 0);
  return now >= today ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 2, 0, 0, 0);
}

/** One rule for the 02:00 run and the catch-up: nothing good yet, or the last good one before the latest 02:00. */
export const due = (now: Date, lastGood: Date | null): boolean => lastGood === null || lastGood < latestTwoAm(now);

export type Nightly = {
  stop(): void;
  importNow(): 'started' | 'running';
  copyNow(): { copied: number; skipped: number; target: string }[];
  running(): boolean;
  /** Resolves once no check and no import is in progress (the server's close and tests wait on it). */
  settled(): Promise<void>;
};

export type NightlyDeps = { config: Config; links: LinkStore; im: DatabaseSync };
export type NightlyOpts = {
  clock?: () => Date;
  schedule?: Schedule;
  sleep?: (ms: number) => Promise<void>;
  /** false: no check at start, only on the schedule's ticks (the test server's own; the real one checks). */
  atStart?: boolean;
};

const BACKUP_NAME = /^tickets-\d{4}-\d{2}-\d{2}\.db$/;

/** When the newest tickets-*.db backup was written (its mtime), or null (none, or the folder can't be read). */
function lastBackupFile(dir: string): Date | null {
  try {
    if (!existsSync(dir)) return null;
    const newest = readdirSync(dir)
      .filter((n) => BACKUP_NAME.test(n))
      .sort()
      .pop();
    return newest ? statSync(join(dir, newest)).mtime : null;
  } catch {
    return null; // backupNow says what is wrong
  }
}

/** 'YYYY-MM-DDTHH:MM:SS' (local, as nowIso writes it) -> Date; null for anything else. */
function localIso(s: string | null): Date | null {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, se);
}

const driveThere = (target: string): boolean => existsSync(parse(resolve(target)).root);

/** Starts the checks (at once unless atStart is false, then every NIGHTLY_CHECK_MS). */
export function startNightly(deps: NightlyDeps, opts: NightlyOpts = {}): Nightly {
  const { config, links, im } = deps;
  const clock = opts.clock ?? (() => new Date());
  const log = (what: string): void => logLine(config.log, what);
  let checking: Promise<void> | null = null;
  let importing: Promise<void> | null = null;
  let lastBackup: Date | null = null; // this process's last good backup (the file's mtime counts too)

  const autoLink = (): void => {
    try {
      const n = links.autoLink(clock());
      if (n) log(`invomax autolink ${n}`);
    } catch (e) {
      log(`invomax autolink failed ${className(e)}`);
    }
  };

  /** One import in the background, then auto-linking if it was good. importOnce never rejects. */
  const runImport = (): Promise<void> => {
    const run = (async () => {
      const r = await importOnce(config, { sleep: opts.sleep, now: clock });
      if (r.ok) autoLink();
    })()
      .catch((e: unknown) => log(`invomax import failed ${className(e)}`))
      .finally(() => {
        importing = null;
      });
    importing = run;
    return run;
  };

  const backup = async (now: Date): Promise<void> => {
    try {
      await backupNow(config, now);
      lastBackup = now;
    } catch (e) {
      log(`backup failed ${className(e)}`);
      return;
    }
    try {
      pruneBackups(config.backups, now);
    } catch (e) {
      log(`backup prune failed ${className(e)}`);
    }
    for (const entry of config.backupTargets) {
      const target = backupFolder(entry);
      if (!driveThere(target)) continue; // the USB drive isn't in: nothing to say at night
      try {
        copyBackups(config.backups, target, now);
      } catch (e) {
        log(`backup copy failed ${className(e)}`);
      }
    }
  };

  const check = (): void => {
    if (checking) return;
    checking = (async () => {
      const now = clock();
      const fileAt = lastBackupFile(config.backups);
      const lastGood = lastBackup && (!fileAt || lastBackup > fileAt) ? lastBackup : fileAt;
      if (due(now, lastGood)) await backup(now);
      if (!importing && due(now, localIso(lastGoodImport(im)))) await runImport();
    })()
      .catch((e: unknown) => log(`nightly error ${className(e)}`))
      .finally(() => {
        checking = null;
      });
  };

  if (opts.atStart !== false) check();
  const timer = (opts.schedule ?? every)(check, NIGHTLY_CHECK_MS);

  return {
    stop: () => timer.stop(),
    importNow: () => {
      if (importing) return 'running';
      void runImport();
      return 'started';
    },
    copyNow: () => {
      if (!config.backupTargets.length) throw new BadInput('no USB drive set up');
      const now = clock();
      const out: { copied: number; skipped: number; target: string }[] = [];
      for (const entry of config.backupTargets) {
        const target = backupFolder(entry);
        if (!driveThere(target)) continue;
        const r = copyBackups(config.backups, target, now);
        out.push({ copied: r.copied, skipped: r.skipped, target });
      }
      if (!out.length) throw new BadInput('drive not found');
      return out;
    },
    running: () => importing !== null,
    settled: async () => {
      while (checking || importing) await Promise.allSettled([checking, importing]);
    },
  };
}
