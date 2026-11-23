// The nightly run: at 02:00 local time (and as a catch-up when the PC was off or signed out then), our own
// backups (tickets.db and invomax.db, each on its own), their pruning and the copy to the USB drive, then the
// InvoMax import, auto-linking and the job index. Checked at start and every 5 minutes; whatever fails is logged by
// class name and tried again on a later check, never thrown: a failed backup an hour on, a failed import after 1, 2,
// 4... hours (and always at the next 02:00), so a lasting problem never reruns all day.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Refused } from '@shop/domain';
import { backupFile, type BackupKind, backupFolder, copyBackups, pruneBackups } from './backup';
import type { Config } from './config';
import { BadInput } from './errors';
import type { LinkStore } from './history/links';
import { className, logLine } from './http/log';
import { importOnce, lastGoodImport } from './invomax/import';
import type { JobIndex } from './jobs/index';
import { every, type Schedule } from './purge';

export const NIGHTLY_CHECK_MS = 300_000;
const HOUR_MS = 3_600_000;

/** Today's 02:00 (local) if `now` is at or after it, else yesterday's. */
export function latestTwoAm(now: Date): Date {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 0, 0, 0);
  return now >= today ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 2, 0, 0, 0);
}

/** One rule for the 02:00 run and the catch-up: nothing good yet, or the last good one before the latest 02:00. */
export const due = (now: Date, lastGood: Date | null): boolean => lastGood === null || lastGood < latestTwoAm(now);

/**
 * When a failed automatic import may run again: 1, 2, 4... hours after the `fails`-th failure in a row (at `at`),
 * but never later than the 02:00 after it.
 */
export function importRetryAt(at: Date, fails: number): Date {
  const backOff = new Date(at.getTime() + HOUR_MS * 2 ** Math.min(Math.max(fails - 1, 0), 10));
  const twoAm = latestTwoAm(at);
  const next = new Date(twoAm.getFullYear(), twoAm.getMonth(), twoAm.getDate() + 1, 2, 0, 0, 0);
  return backOff < next ? backOff : next;
}

export type Nightly = {
  stop(): void;
  /** Runs an import now, back-off or not; 'off' when shop-settings.json turned the import off. */
  importNow(): 'started' | 'running' | 'off';
  /**
   * Runs an import now and waits for it (after any one already running): 'ok', 'failed', or 'off' when
   * shop-settings.json turned the import off. Own billing's first number asks for one before it proposes.
   */
  importWait(): Promise<'ok' | 'failed' | 'off'>;
  /** Copies the backups to the USB drive now; rejects BadInput (no target / drive not found) or Refused (one is running). */
  copyNow(): Promise<{ copied: number; skipped: number; target: string }[]>;
  running(): boolean;
  /** Resolves once no check and no import is in progress (the server's close and tests wait on it). */
  settled(): Promise<void>;
};

/** jobs: the job index, rebuilt after a good import (left out: nothing to rebuild). */
export type NightlyDeps = { config: Config; links: LinkStore; im: DatabaseSync; jobs?: JobIndex };
export type NightlyOpts = {
  clock?: () => Date;
  schedule?: Schedule;
  sleep?: (ms: number) => Promise<void>;
  /** false: no check at start, only on the schedule's ticks (the test server's own; the real one checks). */
  atStart?: boolean;
};

const BACKUP_NAME = /^(tickets|invomax)-\d{4}-\d{2}-\d{2}\.db$/;
const KINDS: BackupKind[] = ['tickets', 'invomax'];

/** When the newest <kind>-*.db backup was written (its mtime), or null (none, or the folder can't be read). */
function lastBackupFile(dir: string, kind: BackupKind): Date | null {
  try {
    if (!existsSync(dir)) return null;
    const newest = readdirSync(dir)
      .filter((n) => BACKUP_NAME.exec(n)?.[1] === kind)
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
  const { config, links, im, jobs } = deps;
  const clock = opts.clock ?? (() => new Date());
  const log = (what: string): void => logLine(config.log, what);
  let checking: Promise<void> | null = null;
  let importing: Promise<void> | null = null;
  let copying: Promise<void> | null = null; // a copy to the USB drive under way (one at a time)
  // per file: this process's last good backup (the file's mtime counts too) and its last failure
  const lastBackup: Record<BackupKind, Date | null> = { tickets: null, invomax: null };
  const backupFailed: Record<BackupKind, Date | null> = { tickets: null, invomax: null };
  // the automatic import's back-off: failures in a row, when it may run again, the class last logged
  let importFails = 0;
  let importNotBefore: Date | null = null;
  let loggedFailure = '';

  const autoLink = (): void => {
    try {
      const n = links.autoLink(clock());
      if (n) log(`invomax autolink ${n}`);
    } catch (e) {
      log(`invomax autolink failed ${className(e)}`);
    }
  };

  /** The job index over the new lines, built now rather than on the next request; never fails the import. */
  const rebuildJobs = (): void => {
    try {
      jobs?.refresh();
    } catch (e) {
      log(`jobmap rebuild failed ${className(e)}`);
    }
  };

  /**
   * One import in the background, then auto-linking and the job index if it was good. importOnce never rejects.
   * A failure is logged once until its class changes; an automatic one (not the button's) backs off.
   */
  const runImport = (automatic: boolean): Promise<boolean> => {
    const run = (async () => {
      const r = await importOnce(config, { sleep: opts.sleep, now: clock, quiet: true });
      if (r.ok) {
        importFails = 0;
        importNotBefore = null;
        loggedFailure = '';
        autoLink();
        rebuildJobs();
        return true;
      }
      if (r.failure && r.failure !== loggedFailure) {
        log(`invomax import failed ${r.failure}`);
        loggedFailure = r.failure;
      }
      if (automatic) importNotBefore = importRetryAt(clock(), ++importFails);
      return false;
    })()
      .catch((e: unknown) => {
        log(`invomax import failed ${className(e)}`);
        return false;
      })
      .finally(() => {
        importing = null;
      });
    importing = run.then(() => undefined);
    return run;
  };

  /** Runs one copy to the USB drive at a time; a second while one runs is Refused (409). */
  const oneCopy = <T>(f: () => Promise<T>): Promise<T> => {
    if (copying) return Promise.reject(new Refused('a copy is already running'));
    const run = f();
    copying = run
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        copying = null;
      });
    return run;
  };

  /** Is this file's backup due: none since the latest 02:00, and no failure in the last hour? */
  const backupDue = (kind: BackupKind, now: Date): boolean => {
    if (kind === 'invomax' && !existsSync(config.invomaxDb)) return false;
    const fileAt = lastBackupFile(config.backups, kind);
    const mine = lastBackup[kind];
    const lastGood = mine && (!fileAt || mine > fileAt) ? mine : fileAt;
    const failed = backupFailed[kind];
    return due(now, lastGood) && !(failed && now.getTime() - failed.getTime() < HOUR_MS);
  };

  /** Backs up each due file on its own, then prunes and copies to the USB drive whatever succeeded. */
  const backup = async (now: Date, kinds: BackupKind[]): Promise<void> => {
    let made = 0;
    for (const kind of kinds) {
      try {
        if (await backupFile(config, kind, now)) made++;
        lastBackup[kind] = now;
        backupFailed[kind] = null;
      } catch (e) {
        backupFailed[kind] = now;
        log(`backup failed ${kind} ${className(e)}`);
      }
    }
    if (!made) return;
    try {
      pruneBackups(config.backups, now);
    } catch (e) {
      log(`backup prune failed ${className(e)}`);
    }
    if (copying) return; // a copy from the button is under way: it has these too
    await oneCopy(async () => {
      for (const entry of config.backupTargets) {
        const target = backupFolder(entry);
        if (!driveThere(target)) continue; // the USB drive isn't in: nothing to say at night
        try {
          await copyBackups(config.backups, target, now);
        } catch (e) {
          log(`backup copy failed ${className(e)}`);
        }
      }
    });
  };

  const check = (): void => {
    if (checking) return;
    checking = (async () => {
      const now = clock();
      const kinds = KINDS.filter((k) => backupDue(k, now));
      if (kinds.length) await backup(now, kinds);
      if (
        config.importInvomax &&
        !importing &&
        due(now, localIso(lastGoodImport(im))) &&
        !(importNotBefore && now < importNotBefore)
      )
        await runImport(true);
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
      if (!config.importInvomax) return 'off';
      if (importing) return 'running';
      void runImport(false);
      return 'started';
    },
    importWait: async () => {
      if (!config.importInvomax) return 'off';
      while (importing) await importing; // one already under way may have read InvoMax's files before now
      return (await runImport(false)) ? 'ok' : 'failed';
    },
    copyNow: () =>
      oneCopy(async () => {
        if (!config.backupTargets.length) throw new BadInput('no USB drive set up');
        const now = clock();
        const out: { copied: number; skipped: number; target: string }[] = [];
        for (const entry of config.backupTargets) {
          const target = backupFolder(entry);
          if (!driveThere(target)) continue;
          const r = await copyBackups(config.backups, target, now);
          out.push({ copied: r.copied, skipped: r.skipped, target });
        }
        if (!out.length) throw new BadInput('drive not found');
        return out;
      }),
    running: () => importing !== null,
    settled: async () => {
      while (checking || importing || copying) await Promise.allSettled([checking, importing, copying]);
    },
  };
}
