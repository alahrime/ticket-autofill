import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupHealth, backupNow, copyBackups, lastGoodBackup, pruneBackups, restoreBackup } from '../src/backup';
import { runCopyBackupsCommand, runRestoreCommand } from '../src/cli';
import { type Config, loadConfig } from '../src/config';
import { BadInput } from '../src/errors';
import { openImDb } from '../src/invomax/imdb';
import { tempDir } from './py';

let tmp: { dir: string; done: () => void };
let cfg: Config;
const NOW = new Date(2026, 10, 21, 2, 0, 0); // local 2026-11-21 02:00

beforeEach(() => {
  tmp = tempDir();
  cfg = loadConfig({ SHOP_ROOT: tmp.dir });
});
afterEach(() => tmp.done());

const makeDb = (path: string, value: string): void => {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS notes (v TEXT)');
  db.prepare('INSERT INTO notes (v) VALUES (?)').run(value);
  db.close();
};
const rows = (path: string): string[] => {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare('SELECT v FROM notes ORDER BY rowid').all() as { v: string }[]).map((r) => r.v);
  } finally {
    db.close();
  }
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
    other.prepare('INSERT INTO notes (v) VALUES (?)').run('pending');
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
    touch(cfg.backups, ['tickets-2026-11-20.db', 'invomax-2026-11-20.db', 'notes.txt']);
    const target = join(tmp.dir, 'usb', 'shop-backups');
    expect(copyBackups(cfg.backups, target, NOW)).toEqual({ copied: 2, skipped: 0 });
    expect(readdirSync(target).sort()).toEqual(['invomax-2026-11-20.db', 'tickets-2026-11-20.db']);
    expect(copyBackups(cfg.backups, target, NOW)).toEqual({ copied: 0, skipped: 2 });
    const o = JSON.parse(readFileSync(join(cfg.backups, 'offsite.json'), 'utf8')) as { at: string; target: string };
    expect(o).toEqual({ at: NOW.toISOString(), target });
  });

  it('recopies a file whose size differs', () => {
    touch(cfg.backups, ['tickets-2026-11-20.db']);
    const target = join(tmp.dir, 'usb');
    copyBackups(cfg.backups, target, NOW);
    writeFileSync(join(cfg.backups, 'tickets-2026-11-20.db'), 'a longer body than before');
    expect(copyBackups(cfg.backups, target, NOW)).toEqual({ copied: 1, skipped: 0 });
  });

  it('throws BadInput for a missing drive and writes no offsite.json', () => {
    touch(cfg.backups, ['tickets-2026-11-20.db']);
    const root = missingRoot();
    expect(existsSync(root)).toBe(false);
    expect(() => copyBackups(cfg.backups, join(root, 'shop-backups'), NOW)).toThrow(BadInput);
    expect(() => copyBackups(cfg.backups, join(root, 'shop-backups'), NOW)).toThrow('drive not found');
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
});
