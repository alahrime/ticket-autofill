// The nightly run: backup (+ prune, + copy to the USB drive) and the InvoMax import (+ auto-linking), at 02:00
// local time and as a catch-up when the PC was off then. A fake clock and a hand-ticked schedule drive it.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Refused } from '@shop/domain';
import { btrieveFile, detailBytes, invoiceBytes } from '@shop/invomax/testing';
import { backupFolder } from '../src/backup';
import { type Config, loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { BadInput } from '../src/errors';
import { LinkStore } from '../src/history/links';
import { openImDb } from '../src/invomax/imdb';
import { JobIndex } from '../src/jobs/index';
import { JobMap } from '../src/jobs/jobmap';
import { due, latestTwoAm, type Nightly, NIGHTLY_CHECK_MS, startNightly } from '../src/nightly';
import { TicketStore } from '../src/store';
import { tempDir } from './py';

const invFile = (records: Buffer[]): Buffer => btrieveFile({ pageSize: 1536, recordLength: 498, records });
const detFile = (records: Buffer[]): Buffer => btrieveFile({ pageSize: 1024, recordLength: 265, records });

let tmp: { dir: string; done: () => void };
let cfg: Config;
let db: DatabaseSync;
let im: DatabaseSync;
let links: LinkStore;
let now: Date;
let ticks: Array<() => void>;
let every: number[];
let n: Nightly | undefined;

const schedule = (f: () => void, ms: number): { stop(): void } => {
  ticks.push(f);
  every.push(ms);
  return { stop: () => ticks.splice(0) };
};
const start = (o: { links?: LinkStore; jobs?: JobIndex; sleep?: (ms: number) => Promise<void> } = {}): Nightly =>
  (n = startNightly({ config: cfg, links: o.links ?? links, im, jobs: o.jobs }, { clock: () => now, schedule, sleep: o.sleep ?? (async () => undefined) }));
const tick = async (): Promise<void> => {
  (ticks[0] as () => void)();
  await n?.settled();
};
const log = (): string => (existsSync(cfg.log) ? readFileSync(cfg.log, 'utf8') : '');
const imports = (): { ok: number; finished: string }[] =>
  im.prepare('SELECT ok, finished FROM im_imports ORDER BY id').all() as never;
const putBills = (): void => {
  writeFileSync(
    join(cfg.invomaxDir, 'INVOICE.btv'),
    invFile([invoiceBytes({ invoice_no: '9000001', date: '2026-11-20', name: 'JANE DOE', phone: '(555)010-0000', plate: 'XKS-4827', total: 22833 })]),
  );
  writeFileSync(
    join(cfg.invomaxDir, 'DETAIL.btv'),
    detFile([detailBytes({ invoice_no: '9000001', code: 'P1', description: 'ITEM 1', kind: 'part', qty: 1, unit: 1000, amount: 1000, vehicle: '2019 Honda HR-V EX' })]),
  );
};
/** A filled ticket (filled 2026-11-20) whose plate matches the bill above. */
const filledTicket = (): number => {
  const t = new TicketStore(db).create({ first: 'Jane', last: 'Testcase', phone: '5550100000', year: '2019', make: 'Honda', model: 'HR-V', plate: 'xks-4827' });
  const data = JSON.parse((db.prepare('SELECT data FROM tickets WHERE id = ?').get(t.id) as { data: string }).data) as Record<string, unknown>;
  data['updated'] = '2026-11-20T10:00:00';
  db.prepare("UPDATE tickets SET status = 'filled', data = ? WHERE id = ?").run(JSON.stringify(data), t.id);
  return t.id;
};
const finals = (): { ticket_id: number; invoice_no: string }[] =>
  db.prepare('SELECT ticket_id, invoice_no FROM invoice_finals').all() as never;
/** As if the last good run was at `at`: a backup file made then and an ok import row finished then. */
const ranAt = (at: Date): void => {
  mkdirSync(cfg.backups, { recursive: true });
  const p = (x: number): string => String(x).padStart(2, '0');
  const day = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  const file = join(cfg.backups, `tickets-${day}.db`);
  openDb(file).close();
  utimesSync(file, at, at);
  im.prepare(
    `INSERT INTO im_imports (started, finished, ok, tries, invoices, lines, added, changed, gone)
     VALUES (?, ?, 1, 1, 0, 0, 0, 0, 0)`,
  ).run(`${day}T${p(at.getHours())}:${p(at.getMinutes())}:00`, `${day}T${p(at.getHours())}:${p(at.getMinutes())}:00`);
};
const missingRoot = (): string => {
  for (const l of 'ZYXWVUTSRQ') if (!existsSync(`${l}:\\`)) return `${l}:\\`;
  throw new Error('no free drive letter to probe');
};

beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'im'));
  cfg = loadConfig({ SHOP_ROOT: tmp.dir, INVOMAX_DIR: join(tmp.dir, 'im') });
  db = openDb(cfg.db);
  im = openImDb(cfg.invomaxDb);
  links = new LinkStore(db, im);
  now = new Date(2026, 10, 21, 1, 0, 0);
  ticks = [];
  every = [];
  n = undefined;
  putBills();
});
afterEach(async () => {
  n?.stop();
  await n?.settled();
  db.close();
  im.close();
  tmp.done();
});

describe('latestTwoAm and due', () => {
  it('is today 02:00 from 02:00 on, else yesterday 02:00 (local time)', () => {
    expect(latestTwoAm(new Date(2026, 10, 21, 1, 59, 59))).toEqual(new Date(2026, 10, 20, 2, 0, 0));
    expect(latestTwoAm(new Date(2026, 10, 21, 2, 0, 0))).toEqual(new Date(2026, 10, 21, 2, 0, 0));
    expect(latestTwoAm(new Date(2026, 11, 1, 0, 30))).toEqual(new Date(2026, 10, 30, 2, 0, 0)); // across a month
  });

  it('is due with no good run, or one before the latest 02:00', () => {
    const at = new Date(2026, 10, 21, 14, 0);
    expect(due(at, null)).toBe(true);
    expect(due(at, new Date(2026, 10, 21, 1, 59))).toBe(true);
    expect(due(at, new Date(2026, 10, 21, 2, 0))).toBe(false);
    expect(due(at, new Date(2026, 10, 21, 2, 10))).toBe(false);
  });
});

describe('startNightly', () => {
  it('on start with no backups, backs up, imports and links at once; then checks every 5 minutes', async () => {
    const id = filledTicket();
    start();
    await n?.settled();
    expect(existsSync(join(cfg.backups, 'tickets-2026-11-21.db'))).toBe(true);
    expect(existsSync(join(cfg.backups, 'invomax-2026-11-21.db'))).toBe(true);
    expect(imports()).toEqual([{ ok: 1, finished: '2026-11-21T01:00:00' }]);
    expect(finals()).toEqual([{ ticket_id: id, invoice_no: '9000001' }]); // the first good import links too
    expect(log()).toMatch(/invomax import ok 1\/1/);
    expect(log()).not.toMatch(/DOE|JANE|5550100000|XKS/);
    expect(every).toEqual([NIGHTLY_CHECK_MS]);
    expect(NIGHTLY_CHECK_MS).toBe(300_000);
    expect(n?.running()).toBe(false);
  });

  it('at 14:00, with the last good run at 02:10 today, runs nothing', async () => {
    ranAt(new Date(2026, 10, 21, 2, 10));
    now = new Date(2026, 10, 21, 14, 0);
    const before = statSync(join(cfg.backups, 'tickets-2026-11-21.db')).mtimeMs;
    start();
    await n?.settled();
    await tick();
    expect(imports()).toHaveLength(1);
    expect(statSync(join(cfg.backups, 'tickets-2026-11-21.db')).mtimeMs).toBe(before);
    expect(existsSync(join(cfg.backups, 'invomax-2026-11-21.db'))).toBe(false);
    expect(log()).toBe('');
  });

  it('a tick past the next 02:00 runs both once; a tick at 02:05 runs nothing', async () => {
    ranAt(new Date(2026, 10, 21, 2, 10));
    now = new Date(2026, 10, 21, 14, 0);
    start();
    await n?.settled();
    now = new Date(2026, 10, 22, 2, 0, 30);
    await tick();
    expect(existsSync(join(cfg.backups, 'tickets-2026-11-22.db'))).toBe(true);
    expect(imports()).toHaveLength(2);
    expect(imports()[1]).toEqual({ ok: 1, finished: '2026-11-22T02:00:30' });
    rmSync(join(cfg.backups, 'tickets-2026-11-22.db')); // a second backup would make it again
    now = new Date(2026, 10, 22, 2, 5);
    await tick();
    expect(existsSync(join(cfg.backups, 'tickets-2026-11-22.db'))).toBe(false);
    expect(imports()).toHaveLength(2);
  });

  it('a failed import logs `invomax import failed`; the next tick tries again', async () => {
    rmSync(join(cfg.invomaxDir, 'INVOICE.btv'));
    start();
    await n?.settled();
    expect(log()).toMatch(/invomax import failed \w+/);
    expect(imports().map((r) => r.ok)).toEqual([0]);
    putBills();
    now = new Date(2026, 10, 21, 1, 5);
    await tick();
    expect(imports().map((r) => r.ok)).toEqual([0, 1]);
  });

  it('a failed auto-link is logged and does not fail the import', async () => {
    filledTicket();
    const broken = new LinkStore(db, im);
    broken.autoLink = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };
    start({ links: broken });
    await n?.settled();
    expect(imports().map((r) => r.ok)).toEqual([1]);
    expect(log()).toMatch(/invomax autolink failed Error\n/);
    expect(log()).not.toMatch(/locked/);
    now = new Date(2026, 10, 21, 1, 5);
    await tick();
    expect(imports()).toHaveLength(1); // the import was good: not due again
  });

  it('a good import rebuilds the job index over the new lines', async () => {
    const jobs = new JobIndex(new JobMap(db), im, cfg.catalog);
    new JobMap(db).put({ im_code: 'P1', words: [], job: 'FBP' }, 'admin#1');
    expect(jobs.coverage().lines).toBe(0); // built before the import
    start({ jobs });
    await n?.settled();
    expect(jobs.builds).toBe(2);
    expect(jobs.job('9000001', 1)).toBe('FBP');
    expect(jobs.builds).toBe(2); // nothing changed since: no third build
  });

  it('a failed job index rebuild is logged and does not fail the import', async () => {
    const jobs = new JobIndex(new JobMap(db), im, cfg.catalog);
    jobs.refresh = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };
    start({ jobs });
    await n?.settled();
    expect(imports().map((r) => r.ok)).toEqual([1]);
    expect(log()).toMatch(/jobmap rebuild failed Error\n/);
    expect(log()).not.toMatch(/locked/);
  });

  it('a failed backup is logged by class; the import still runs', async () => {
    writeFileSync(cfg.backups, 'a file where the backups folder should be');
    start();
    await n?.settled();
    expect(log()).toMatch(/backup failed \w+/);
    expect(imports().map((r) => r.ok)).toEqual([1]);
  });

  it('importNow starts one in the background; while it runs, it says running', async () => {
    ranAt(new Date(2026, 10, 21, 2, 10));
    now = new Date(2026, 10, 21, 14, 0);
    writeFileSync(join(cfg.invomaxDir, 'INVOICE.btv'), Buffer.alloc(100, 7)); // junk: retried after a sleep
    let open!: () => void;
    const gate = new Promise<void>((ok) => (open = ok));
    start({ sleep: () => gate });
    await n?.settled();
    expect(n?.importNow()).toBe('started');
    await new Promise((ok) => setTimeout(ok, 20));
    expect(n?.running()).toBe(true);
    expect(n?.importNow()).toBe('running');
    open();
    await n?.settled();
    expect(n?.running()).toBe(false);
    expect(log()).toMatch(/invomax import failed/);
    putBills();
    expect(n?.importNow()).toBe('started');
    await n?.settled();
    expect(imports().map((r) => r.ok)).toEqual([1, 0, 1]);
  });

  it('a target whose drive is missing is skipped silently at night', async () => {
    cfg.backupTargets = [missingRoot()];
    start();
    await n?.settled();
    expect(existsSync(join(cfg.backups, 'tickets-2026-11-21.db'))).toBe(true);
    expect(log()).not.toMatch(/copy/);
    expect(imports().map((r) => r.ok)).toEqual([1]);
  });

  it('copyNow: no target is "no USB drive set up"; a missing drive is "drive not found"', async () => {
    ranAt(new Date(2026, 10, 21, 2, 10));
    now = new Date(2026, 10, 21, 14, 0);
    start();
    await n?.settled();
    await expect(n?.copyNow()).rejects.toThrow(new BadInput('no USB drive set up'));
    cfg.backupTargets = [missingRoot()];
    await expect(n?.copyNow()).rejects.toThrow(new BadInput('drive not found'));
  });

  it('copyNow runs one copy at a time: a second while one runs is refused (409)', async () => {
    ranAt(new Date(2026, 10, 21, 2, 10));
    now = new Date(2026, 10, 21, 14, 0);
    start();
    await n?.settled();
    cfg.backupTargets = [join(tmp.dir, 'usb')]; // the backups' own drive: the copy itself fails, after the guard
    const first = n?.copyNow() as Promise<unknown>;
    const second = n?.copyNow() as Promise<unknown>; // while the first is still running
    await expect(second).rejects.toThrow(new Refused('a copy is already running'));
    await expect(first).rejects.toThrow('that drive holds the backups already');
    await n?.settled();
    await expect(n?.copyNow()).rejects.toThrow('that drive holds the backups already'); // free again
  });

  it('stop() ends the timer', async () => {
    ranAt(new Date(2026, 10, 21, 2, 10));
    now = new Date(2026, 10, 21, 14, 0);
    start();
    await n?.settled();
    n?.stop();
    expect(ticks).toHaveLength(0);
  });
});

describe('backupFolder', () => {
  it('a drive letter means <drive>\\shop-backups; a folder is used as given', () => {
    expect(backupFolder('D:')).toBe('D:\\shop-backups');
    expect(backupFolder('d:\\')).toBe('d:\\shop-backups');
    expect(backupFolder('D:\\shop-backups')).toBe('D:\\shop-backups');
    expect(backupFolder('E:\\copies\\shop')).toBe('E:\\copies\\shop');
  });
});
