import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupHealth, backupNow, copyBackups, lastGoodBackup, pruneBackups, restoreBackup } from '../src/backup';
import { runCopyBackupsCommand, runRestoreCommand } from '../src/cli';
import { type Config, loadConfig } from '../src/config';
import { BadInput } from '../src/errors';
import { openImDb } from '../src/invomax/imdb';
import { releaseLock, takeLock } from '../src/invomax/import';
import { tempDir } from './py';

let tmp: { dir: string; done: () => void };
let cfg: Config;
const NOW = new Date(2026, 10, 21, 2, 0, 0); // local 2026-11-21 02:00
const SAME = { allowSameDrive: true }; // temp dirs share one drive

beforeEach(() => {
  tmp = tempDir();
  cfg = loadConfig({ SHOP_ROOT: tmp.dir });
});
afterEach(() => tmp.done());

const makeDb = (path: string, value: string): void => {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS tickets (v TEXT)');
  db.prepare('INSERT INTO tickets (v) VALUES (?)').run(value);
  db.close();
};
const rows = (path: string): string[] => {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare('SELECT v FROM tickets ORDER BY rowid').all() as { v: string }[]).map((r) => r.v);
  } finally {
    db.close();
  }
};
/** Real (tiny, valid) sqlite backups in the backups folder. */
const real = (names: string[]): void => {
  mkdirSync(cfg.backups, { recursive: true });
  for (const n of names) makeDb(join(cfg.backups, n), n);
};
const touch = (dir: string, names: string[]): void => {
  mkdirSync(dir, { recursive: true });
  for (const n of names) writeFileSync(join(dir, n), n);
};
const day = (start: Date, i: number): string => {
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
/** A drive root that does not exist on this PC (probed, so the test is deterministic). */
const missingRoot = (): string => {
  for (const l of 'ZYXWVUTSRQ') if (!existsSync(`${l}:\\`)) return `${l}:\\`;
  throw new Error('no free drive letter to probe');
};
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });

describe('backupNow', () => {
  it('writes both files, readable and holding the rows', async () => {
    makeDb(cfg.db, 'JANE DOE');
    openImDb(cfg.invomaxDb).close();
    const r = await backupNow(cfg, NOW);
    expect(r.tickets).toBe(join(cfg.backups, 'tickets-2026-11-21.db'));
    expect(r.invomax).toBe(join(cfg.backups, 'invomax-2026-11-21.db'));
    expect(rows(r.tickets)).toEqual(['JANE DOE']);
    const im = new DatabaseSync(r.invomax as string);
    expect(im.prepare('SELECT count(*) AS n FROM im_invoices').get()).toEqual({ n: 0 });
    im.close();
    expect(readdirSync(cfg.backups).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('skips invomax when there is no invomax.db, and overwrites that day', async () => {
    makeDb(cfg.db, 'a');
    expect((await backupNow(cfg, NOW)).invomax).toBeNull();
    makeDb(cfg.db, 'b');
    const r = await backupNow(cfg, NOW);
    expect(rows(r.tickets)).toEqual(['a', 'b']);
    expect(readdirSync(cfg.backups)).toEqual(['tickets-2026-11-21.db']);
  });

  it('works while another connection holds an open write transaction', async () => {
    makeDb(cfg.db, 'committed');
    const other = new DatabaseSync(cfg.db);
    other.exec('BEGIN IMMEDIATE');
    other.prepare('INSERT INTO tickets (v) VALUES (?)').run('pending');
    try {
      const r = await backupNow(cfg, NOW);
      expect(rows(r.tickets)).toEqual(['committed']);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
  });

  it('throws and leaves no .tmp when the source is not a database', async () => {
    writeFileSync(cfg.db, 'this is not a database file at all, just text'.repeat(50));
    await expect(backupNow(cfg, NOW)).rejects.toThrow();
    expect(existsSync(cfg.backups) ? readdirSync(cfg.backups) : []).toEqual([]);
  });
});

describe('pruneBackups', () => {
  it('keeps the newest 90 tickets files', () => {
    const start = new Date(2026, 0, 1);
    const names = Array.from({ length: 100 }, (_, i) => `tickets-${day(start, i)}.db`);
    touch(cfg.backups, names);
    const removed = pruneBackups(cfg.backups, NOW);
    expect(removed.sort()).toEqual(names.slice(0, 10).sort());
    expect(readdirSync(cfg.backups)).toHaveLength(90);
    expect(readdirSync(cfg.backups)).toContain(names[99]);
  });

  it('keeps 14 daily plus one per month for 24 months of invomax files', () => {
    const start = new Date(2024, 0, 1);
    const names: string[] = [];
    for (let i = 0; i < 912; i++) names.push(`invomax-${day(start, i)}.db`); // ~30 months, to 2026-06-30
    touch(cfg.backups, names);
    pruneBackups(cfg.backups, NOW);
    const left = readdirSync(cfg.backups).sort();
    expect(left.length).toBeLessThanOrEqual(38);
    expect(left.length).toBeGreaterThanOrEqual(24);
    for (const n of names.slice(-14)) expect(left).toContain(n);
    expect(left).toContain('invomax-2026-06-01.db'); // first of the month kept
    expect(left).toContain('invomax-2024-07-01.db'); // the 24th month back (2024-07..2026-06)
    expect(left).not.toContain('invomax-2024-06-01.db'); // the 25th month is gone
    expect(left).not.toContain('invomax-2026-06-10.db');
  });

  it('keeps the earliest file of a month when the first is missing', () => {
    touch(cfg.backups, ['invomax-2026-05-03.db', 'invomax-2026-05-04.db']);
    const start = new Date(2026, 5, 1);
    touch(cfg.backups, Array.from({ length: 20 }, (_, i) => `invomax-${day(start, i)}.db`));
    pruneBackups(cfg.backups, NOW);
    const left = readdirSync(cfg.backups);
    expect(left).toContain('invomax-2026-05-03.db');
    expect(left).not.toContain('invomax-2026-05-04.db');
  });

  it('leaves offsite.json and unknown files alone', () => {
    const start = new Date(2026, 0, 1);
    const names = Array.from({ length: 100 }, (_, i) => `tickets-${day(start, i)}.db`);
    const odd = [
      'offsite.json',
      'notes.txt',
      'tickets-2026-01-01.db.tmp',
      'tickets-2026-1-1.db',
      'tickets-backup-2026-01-01.db',
      'invomax-2026-01-01.db.bak',
    ];
    touch(cfg.backups, [...names, ...odd]);
    pruneBackups(cfg.backups, NOW);
    const left = readdirSync(cfg.backups);
    for (const o of odd) expect(left).toContain(o);
  });

  it('returns [] for a missing folder', () => {
    expect(pruneBackups(join(tmp.dir, 'nope'), NOW)).toEqual([]);
  });
});

describe('lastGoodBackup and backupHealth', () => {
  it('reads the newest tickets date', () => {
    expect(lastGoodBackup(cfg.backups)).toBeNull();
    touch(cfg.backups, ['tickets-2026-11-19.db', 'tickets-2026-11-20.db', 'invomax-2026-11-21.db']);
    expect(lastGoodBackup(cfg.backups)).toEqual(new Date(2026, 10, 20));
  });

  it('flags stale after 2 days and reports offsite', () => {
    expect(backupHealth(cfg.backups, NOW)).toEqual({ last: null, stale: true, offsite: null });
    touch(cfg.backups, ['tickets-2026-11-20.db']);
    expect(backupHealth(cfg.backups, NOW)).toEqual({ last: '2026-11-20', stale: false, offsite: null });
    expect(backupHealth(cfg.backups, new Date(2026, 10, 23, 3)).stale).toBe(true);
    writeFileSync(join(cfg.backups, 'offsite.json'), JSON.stringify({ at: '2026-11-20T10:00:00.000Z', target: 'E:\\shop-backups' }));
    expect(backupHealth(cfg.backups, NOW).offsite).toBe('2026-11-20T10:00:00.000Z');
    writeFileSync(join(cfg.backups, 'offsite.json'), '{not json');
    expect(backupHealth(cfg.backups, NOW).offsite).toBeNull();
  });
});

describe('copyBackups', () => {
  it('copies, is idempotent, and writes offsite.json', () => {
    real(['tickets-2026-11-20.db', 'invomax-2026-11-20.db']);
    touch(cfg.backups, ['notes.txt']);
    const target = join(tmp.dir, 'usb', 'shop-backups');
    expect(copyBackups(cfg.backups, target, NOW, SAME)).toEqual({ copied: 2, skipped: 0 });
    expect(readdirSync(target).sort()).toEqual(['invomax-2026-11-20.db', 'tickets-2026-11-20.db']);
    expect(copyBackups(cfg.backups, target, NOW, SAME)).toEqual({ copied: 0, skipped: 2 });
    const o = JSON.parse(readFileSync(join(cfg.backups, 'offsite.json'), 'utf8')) as { at: string; target: string };
    expect(o).toEqual({ at: NOW.toISOString(), target });
  });

  it('recopies a same-size file whose mtime differs, and keeps the source mtime on the copy', () => {
    real(['tickets-2026-11-20.db']);
    const target = join(tmp.dir, 'usb');
    const src = join(cfg.backups, 'tickets-2026-11-20.db');
    const when = new Date(2026, 10, 20, 2, 0, 0);
    utimesSync(src, when, when);
    expect(copyBackups(cfg.backups, target, NOW, SAME)).toEqual({ copied: 1, skipped: 0 });
    expect(Math.abs(statSync(join(target, 'tickets-2026-11-20.db')).mtimeMs - when.getTime())).toBeLessThan(2000);
    expect(copyBackups(cfg.backups, target, NOW, SAME)).toEqual({ copied: 0, skipped: 1 });
    const later = new Date(2026, 10, 20, 5, 0, 0); // same name and size, different time
    utimesSync(src, later, later);
    expect(copyBackups(cfg.backups, target, NOW, SAME)).toEqual({ copied: 1, skipped: 0 });
  });

  it('fails a corrupt copy, deletes it and writes no offsite.json', () => {
    real(['tickets-2026-11-20.db']);
    const target = join(tmp.dir, 'usb');
    const corrupt = (tmpPath: string): void => {
      const b = readFileSync(tmpPath);
      for (let i = 0; i < b.length; i += 5) b[i] = 0xff;
      writeFileSync(tmpPath, b);
    };
    expect(() => copyBackups(cfg.backups, target, NOW, { ...SAME, afterCopy: corrupt })).toThrow('failed its check');
    expect(existsSync(join(cfg.backups, 'offsite.json'))).toBe(false);
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses a target on the same drive as the backups', () => {
    real(['tickets-2026-11-20.db']);
    expect(() => copyBackups(cfg.backups, join(tmp.dir, 'usb'), NOW)).toThrow(BadInput);
    expect(() => copyBackups(cfg.backups, join(tmp.dir, 'usb'), NOW)).toThrow('that drive holds the backups already');
    expect(existsSync(join(cfg.backups, 'offsite.json'))).toBe(false);
  });

  it('throws BadInput for a missing drive and writes no offsite.json', () => {
    real(['tickets-2026-11-20.db']);
    const root = missingRoot();
    expect(existsSync(root)).toBe(false);
    expect(() => copyBackups(cfg.backups, join(root, 'shop-backups'), NOW, SAME)).toThrow(BadInput);
    expect(() => copyBackups(cfg.backups, join(root, 'shop-backups'), NOW, SAME)).toThrow('drive not found');
    expect(existsSync(join(cfg.backups, 'offsite.json'))).toBe(false);
  });
});

describe('restoreBackup', () => {
  let listener: Server | undefined;
  afterEach(async () => {
    if (listener) await new Promise((ok) => listener?.close(ok));
    listener = undefined;
  });
  const listen = (): Promise<number> =>
    new Promise((ok) => {
      listener = createServer().listen(0, '127.0.0.1', () => ok((listener?.address() as { port: number }).port));
    });

  it('refuses while a listener is on the port', async () => {
    makeDb(cfg.db, 'now');
    const good = await backupNow(cfg, NOW);
    const busy = { ...cfg, port: await listen() };
    await expect(restoreBackup(good.tickets, busy)).rejects.toThrow('stop the shop server first');
    expect(rows(cfg.db)).toEqual(['now']);
  });

  it('restores on a free port and sets the old file aside', async () => {
    makeDb(cfg.db, 'old');
    const good = await backupNow(cfg, NOW);
    makeDb(cfg.db, 'newer');
    writeFileSync(`${cfg.db}-wal`, '');
    const aside = await restoreBackup(good.tickets, { ...cfg, port: await freePort() });
    expect(aside).toMatch(/^tickets\.db\.before-restore-\d{8}-\d{6}$/);
    expect(rows(cfg.db)).toEqual(['old']);
    expect(rows(join(tmp.dir, aside))).toEqual(['old', 'newer']);
    expect(existsSync(`${cfg.db}-wal`)).toBe(false);
    expect(readdirSync(tmp.dir).filter((n) => n.includes('.restoring'))).toEqual([]);
  });

  it('restores invomax.db by the file name prefix', async () => {
    makeDb(cfg.db, 'x');
    openImDb(cfg.invomaxDb).close();
    const r = await backupNow(cfg, NOW);
    const aside = await restoreBackup(r.invomax as string, { ...cfg, port: await freePort() });
    expect(aside).toMatch(/^invomax\.db\.before-restore-/);
    expect(existsSync(cfg.invomaxDb)).toBe(true);
  });

  it('refuses a corrupt backup before moving anything', async () => {
    makeDb(cfg.db, 'keep');
    const good = await backupNow(cfg, NOW);
    const bytes = readFileSync(good.tickets);
    for (let i = 0; i < bytes.length; i += 7) bytes[i] = 0xff;
    writeFileSync(good.tickets, bytes);
    await expect(restoreBackup(good.tickets, { ...cfg, port: await freePort() })).rejects.toThrow();
    expect(rows(cfg.db)).toEqual(['keep']);
    expect(readdirSync(tmp.dir).filter((n) => n.includes('before-restore') || n.includes('.restoring'))).toEqual([]);
  });

  it('treats a non-refused connect error as the server being up', async () => {
    makeDb(cfg.db, 'now');
    const good = await backupNow(cfg, NOW);
    const odd = { ...cfg, host: '256.256.256.256', port: await freePort() }; // an error that is not ECONNREFUSED
    await expect(restoreBackup(good.tickets, odd)).rejects.toThrow('stop the shop server first');
    expect(rows(cfg.db)).toEqual(['now']);
  });

  it('puts the old files back when the final rename fails', async () => {
    makeDb(cfg.db, 'old');
    const good = await backupNow(cfg, NOW);
    makeDb(cfg.db, 'newer');
    writeFileSync(`${cfg.db}-wal`, '');
    const failing = (from: string, to: string): void => {
      if (from.endsWith('.restoring')) throw new Error('EPERM: simulated'); // only the swap-in fails
      renameSync(from, to);
    };
    const err = (await restoreBackup(good.tickets, { ...cfg, port: await freePort() }, { rename: failing }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('undone');
    expect(err.message).not.toContain('Nothing restored');
    expect(existsSync(`${cfg.db}-wal`)).toBe(true);
    expect(rows(cfg.db)).toEqual(['old', 'newer']);
    expect(readdirSync(tmp.dir).filter((n) => n.includes('before-restore') || n.includes('.restoring'))).toEqual([]);
  });

  it('names where the data sits when the rollback fails too', async () => {
    makeDb(cfg.db, 'old');
    const good = await backupNow(cfg, NOW);
    let swapped = false;
    const failing = (from: string, to: string): void => {
      if (to === cfg.db) throw new Error('EPERM: simulated');
      if (from === cfg.db && swapped) throw new Error('EPERM: rollback');
      if (to.includes('before-restore')) swapped = true;
      renameSync(from, to);
    };
    const err = (await restoreBackup(good.tickets, { ...cfg, port: await freePort() }, { rename: failing }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/tickets\.db\.before-restore-\d{8}-\d{6}/);
    expect(err.message).toContain(`${cfg.db}.restoring`);
    expect(existsSync(`${cfg.db}.restoring`)).toBe(true);
    const aside = readdirSync(tmp.dir).find((n) => n.includes('before-restore')) as string;
    expect(rows(join(tmp.dir, aside))).toEqual(['old']);
  });

  it('refuses a database of the wrong kind before moving anything', async () => {
    makeDb(cfg.db, 'keep');
    openImDb(cfg.invomaxDb).close();
    const r = await backupNow(cfg, NOW);
    const wrong = join(tmp.dir, 'tickets-2026-11-20.db'); // an invomax file named like a tickets backup
    copyFileSync(r.invomax as string, wrong);
    await expect(restoreBackup(wrong, { ...cfg, port: await freePort() })).rejects.toThrow('not a tickets backup');
    const wrong2 = join(tmp.dir, 'invomax-2026-11-20.db'); // and the other way round
    copyFileSync(r.tickets, wrong2);
    await expect(restoreBackup(wrong2, { ...cfg, port: await freePort() })).rejects.toThrow('not a invomax backup');
    expect(rows(cfg.db)).toEqual(['keep']);
    expect(readdirSync(tmp.dir).filter((n) => n.includes('before-restore') || n.includes('.restoring'))).toEqual([]);
  });

  it('refuses an invomax restore while an import holds the lock', async () => {
    makeDb(cfg.db, 'x');
    openImDb(cfg.invomaxDb).close();
    const r = await backupNow(cfg, NOW);
    const lock = takeLock(cfg.importDir);
    expect(lock).not.toBeNull();
    try {
      await expect(restoreBackup(r.invomax as string, { ...cfg, port: await freePort() })).rejects.toThrow(
        'an InvoMax import is running; try again later',
      );
    } finally {
      if (lock) releaseLock(lock);
    }
    expect(readdirSync(tmp.dir).filter((n) => n.includes('before-restore') || n.includes('.restoring'))).toEqual([]);
    await expect(restoreBackup(r.invomax as string, { ...cfg, port: await freePort() })).resolves.toMatch(/^invomax\.db\.before-restore-/);
  });

  it('rejects an unknown file name', async () => {
    writeFileSync(join(tmp.dir, 'other.db'), 'x');
    await expect(restoreBackup(join(tmp.dir, 'other.db'), { ...cfg, port: await freePort() })).rejects.toThrow(BadInput);
  });
});

describe('CLI wrappers', () => {
  it('copy-backups says drive not found for a missing drive and returns 1', () => {
    const out: string[] = [];
    const drive = missingRoot().slice(0, 2);
    expect(runCopyBackupsCommand(cfg, drive, (s) => out.push(s))).toBe(1);
    expect(out.join(' ')).toContain('drive not found');
  });

  it('restore prints the set-aside name', async () => {
    makeDb(cfg.db, 'v');
    const good = await backupNow(cfg, NOW);
    const out: string[] = [];
    expect(await runRestoreCommand({ ...cfg, port: await freePort() }, good.tickets, (s) => out.push(s))).toBe(0);
    expect(out.join(' ')).toContain('before-restore');
  });

  it.each(['D', '..', 'C:\\hunni', 'C:\\hunni\\files', 'E:foo', ''])('copy-backups refuses %p as a drive', (drive) => {
    const out: string[] = [];
    expect(runCopyBackupsCommand(cfg, drive, (s) => out.push(s))).toBe(1);
    expect(out.join(' ')).toContain('give a drive letter, like D:');
  });

  it('copy-backups refuses the drive that holds the backups', () => {
    const out: string[] = [];
    const own = { ...cfg, backups: 'C:\\somewhere\\backups' };
    expect(runCopyBackupsCommand(own, 'c:', (s) => out.push(s))).toBe(1);
    expect(out.join(' ')).toContain('that drive holds the backups already; use the USB drive');
  });
});
