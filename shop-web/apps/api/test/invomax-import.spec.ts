import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { btrieveFile, detailBytes, invoiceBytes } from '@shop/invomax/testing';
import { runImportCommand } from '../src/cli';
import { type Config, loadConfig } from '../src/config';
import { copyTable, importOnce, lastGoodImport, lastImport, releaseLock, takeLock } from '../src/invomax/import';
import { openImDb } from '../src/invomax/imdb';
import { tempDir } from './py';

const invFile = (records: Buffer[], headerCount?: number): Buffer =>
  btrieveFile({ pageSize: 1536, recordLength: 498, records, headerCount });
const detFile = (records: Buffer[]): Buffer => btrieveFile({ pageSize: 1024, recordLength: 265, records });

const inv = (no: string, extra: Record<string, unknown> = {}): Buffer =>
  invoiceBytes({
    invoice_no: no,
    date: '2026-11-20',
    name: 'JANE DOE',
    phone: '(555)010-0000',
    plate: 'XKS-4827',
    total: 22833,
    balance: 0,
    ...extra,
  });
const line = (no: string, n: number, extra: Record<string, unknown> = {}): Buffer =>
  detailBytes({
    invoice_no: no,
    code: `P${n}`,
    description: `ITEM ${n}`,
    kind: 'part',
    qty: 1,
    unit: 1000 * n,
    amount: 1000 * n,
    vehicle: '2019 Honda HR-V EX',
    ...extra,
  });

let tmp: { dir: string; done: () => void };
let cfg: Config;
let sleepCalls: number[];
const sleep = async (ms: number): Promise<void> => {
  sleepCalls.push(ms);
};

const put = (invoices: Buffer[], lines: Buffer[]): void => {
  writeFileSync(join(cfg.invomaxDir, 'INVOICE.btv'), invFile(invoices));
  writeFileSync(join(cfg.invomaxDir, 'DETAIL.btv'), detFile(lines));
};
const initial = (): void =>
  put(
    [inv('9000001'), inv('9000002'), inv('9000003')],
    [line('9000001', 1), line('9000001', 2), line('9000002', 1), line('9000003', 1), line('9000003', 2)],
  );
const q = <T>(sql: string, ...args: string[]): T[] => {
  const db = new DatabaseSync(cfg.invomaxDb);
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
};
const count = (table: string): number => q<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0].n;
const log = (): string => (existsSync(cfg.log) ? readFileSync(cfg.log, 'utf8') : '');

beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'im'));
  cfg = loadConfig({ SHOP_ROOT: tmp.dir, INVOMAX_DIR: join(tmp.dir, 'im') });
  sleepCalls = [];
  initial();
});
afterEach(() => tmp.done());

test('first import stores everything and logs counts only', async () => {
  writeFileSync(cfg.vehicles, JSON.stringify({ Honda: { 'HR-V': [2016, 2022] } }));
  const r = await importOnce(cfg, { sleep });
  expect(r).toMatchObject({ ok: true, tries: 1, invoices: 3, lines: 5, added: 3, changed: 0, gone: 0, error: '' });
  expect(log()).toMatch(/invomax import ok 3\/5 \+3 ~0 -0/);
  expect(log()).toMatch(/invomax import notes odd 0 bad 0 dup 0 \d+ms/);
  expect(log()).not.toMatch(/DOE|5550100000|XKS4827/);
  expect(count('im_invoices')).toBe(3);
  expect(count('im_lines')).toBe(5);
  expect(q<{ year: number }>('SELECT year FROM im_lines LIMIT 1')[0].year).toBe(2019);
  expect(q<{ journal_mode: string }>('PRAGMA journal_mode')[0].journal_mode).toBe('wal');
  const rows = q<{ ok: number; invoices: number; lines: number; odd: number; bad: number; duplicates: number; started: string }>(
    'SELECT * FROM im_imports',
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ok: 1, invoices: 3, lines: 5, odd: 0, bad: 0, duplicates: 0 });
  expect(rows[0].started).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
});

test('an unchanged second import changes nothing', async () => {
  await importOnce(cfg, { sleep });
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true, added: 0, changed: 0, gone: 0 });
});

test('an edited bill wins, a vanished bill is kept as gone, and comes back', async () => {
  await importOnce(cfg, { sleep, now: () => new Date(2026, 10, 20, 9, 0, 0) });
  put([inv('9000001', { total: 99999 }), inv('9000002')], [line('9000001', 7), line('9000002', 1)]);
  const r2 = await importOnce(cfg, { sleep, now: () => new Date(2026, 10, 21, 9, 0, 0) });
  expect(r2).toMatchObject({ ok: true, invoices: 2, changed: 1, gone: 1, added: 0 });
  type Row = { gone_at: string; total: number; first_seen: string; updated_at: string };
  const row = (no: string): Row => q<Row>('SELECT * FROM im_invoices WHERE invoice_no = ?', no)[0];
  expect(row('9000003').gone_at).toBe('2026-11-21T09:00:00');
  expect(row('9000001')).toMatchObject({ total: 99999, first_seen: '2026-11-20T09:00:00', updated_at: '2026-11-21T09:00:00' });
  expect(q<{ code: string }>('SELECT code FROM im_lines WHERE invoice_no = ?', '9000001')).toEqual([{ code: 'P7' }]);
  expect(q('SELECT 1 FROM im_lines WHERE invoice_no = ?', '9000003')).toHaveLength(2); // a gone bill keeps its lines
  initial();
  const r3 = await importOnce(cfg, { sleep });
  expect(r3).toMatchObject({ added: 0, changed: 1, gone: 0 }); // 9000001 reverts; 9000003 returns
  expect(row('9000003').gone_at).toBe('');
});

test('an invoice whose lines alone changed counts as changed', async () => {
  await importOnce(cfg, { sleep });
  put(
    [inv('9000001'), inv('9000002'), inv('9000003')],
    [line('9000001', 1), line('9000001', 2), line('9000002', 1, { description: 'X' }), line('9000003', 1), line('9000003', 2)],
  );
  expect(await importOnce(cfg, { sleep })).toMatchObject({ changed: 1, added: 0 });
});

test('lines of no invoice are stored too', async () => {
  put([inv('9000001')], [line('9000001', 1), line('9000099', 1)]);
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true, invoices: 1, lines: 2 });
  expect(count('im_lines')).toBe(2);
  expect(await importOnce(cfg, { sleep })).toMatchObject({ added: 0, changed: 0, gone: 0 });
});

test('a torn copy retries 3 times, then fails and keeps the last good import', async () => {
  await importOnce(cfg, { sleep });
  writeFileSync(join(cfg.invomaxDir, 'INVOICE.btv'), invFile([inv('9000001'), inv('9000002')], 5));
  sleepCalls = [];
  const r = await importOnce(cfg, { sleep });
  expect(r).toMatchObject({ ok: false, tries: 4 });
  expect(r.error).toBeTruthy();
  expect(sleepCalls).toEqual([60_000, 60_000, 60_000]);
  expect(count('im_invoices')).toBe(3);
  expect(count('im_lines')).toBe(5);
  expect(log()).toMatch(/invomax import failed BtrieveError/);
  const db = new DatabaseSync(cfg.invomaxDb);
  expect(lastImport(db)).toMatchObject({ ok: false });
  expect(lastGoodImport(db)).toMatch(/^\d{4}-/);
  db.close();
});

test('a torn copy that heals on retry imports', async () => {
  const good = invFile([inv('9000001'), inv('9000002'), inv('9000003')]);
  writeFileSync(join(cfg.invomaxDir, 'INVOICE.btv'), invFile([inv('9000001')], 9));
  const heal = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    writeFileSync(join(cfg.invomaxDir, 'INVOICE.btv'), good);
  };
  const r = await importOnce(cfg, { sleep: heal });
  expect(r).toMatchObject({ ok: true, tries: 2, invoices: 3 });
  expect(sleepCalls).toEqual([60_000]);
});

test('one at a time', async () => {
  const [a, b] = await Promise.all([importOnce(cfg, { sleep }), importOnce(cfg, { sleep })]);
  expect([a.ok, b.ok].sort()).toEqual([false, true]);
  expect([a, b].find((r) => !r.ok)?.error).toBe('already running');
  expect(count('im_imports')).toBe(1);
});

test('never opens InvoMax files for writing', async () => {
  const files = ['INVOICE.btv', 'DETAIL.btv'].map((f) => join(cfg.invomaxDir, f));
  files.forEach((f) => chmodSync(f, 0o444));
  const before = files.map((f) => statSync(f).mtimeMs);
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true });
  expect(files.map((f) => statSync(f).mtimeMs)).toEqual(before);
  files.forEach((f) => chmodSync(f, 0o666));
});

test('a new vehicles.json refills unchanged lines; an unreadable one leaves them alone', async () => {
  const makes = (): string[] => q<{ make: string }>('SELECT DISTINCT make FROM im_lines').map((r) => r.make);
  await importOnce(cfg, { sleep }); // no vehicles.json yet
  expect(makes()).toEqual(['']);
  expect(log()).toMatch(/invomax import vehicles unreadable/);
  writeFileSync(cfg.vehicles, JSON.stringify({ Honda: { 'HR-V': [2016, 2022] } }));
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true, changed: 0, added: 0 });
  expect(makes()).toEqual(['Honda']);
  expect(q<{ model: string }>('SELECT DISTINCT model FROM im_lines')).toEqual([{ model: 'HR-V' }]);
  writeFileSync(cfg.vehicles, '{ not json');
  put([inv('9000004')], [line('9000004', 1)]);
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true, added: 1 });
  expect(q<{ make: string }>('SELECT make FROM im_lines WHERE invoice_no = ?', '9000004')[0].make).toBe('');
  expect(q<{ make: string }>('SELECT make FROM im_lines WHERE invoice_no = ?', '9000001')[0].make).toBe('Honda');
  expect(q<{ vehicles_hash: string }>('SELECT vehicles_hash FROM im_imports ORDER BY id DESC LIMIT 1')[0].vehicles_hash).toBe('');
});

test('a busy file retries like a torn one; other errors fail at once', async () => {
  let n = 0;
  const busy = (src: string, dest: string): void => {
    if (n++ === 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    copyTable(src, dest);
  };
  expect(await importOnce(cfg, { sleep, copy: busy })).toMatchObject({ ok: true, tries: 2 });
  expect(sleepCalls).toEqual([60_000]);
  for (const code of ['EPERM', 'EACCES', 'EAGAIN']) {
    sleepCalls = [];
    const always = (): void => {
      throw Object.assign(new Error(code), { code });
    };
    expect(await importOnce(cfg, { sleep, copy: always })).toMatchObject({ ok: false, tries: 4, error: code });
    expect(sleepCalls).toEqual([60_000, 60_000, 60_000]);
  }
  sleepCalls = [];
  const missing = (): void => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  expect(await importOnce(cfg, { sleep, copy: missing })).toMatchObject({ ok: false, tries: 1 });
  expect(sleepCalls).toEqual([]);
});

test('importOnce never rejects: a blocked import folder is a logged failure', async () => {
  writeFileSync(cfg.importDir, 'a file where the folder should be');
  const r = await importOnce(cfg, { sleep });
  expect(r.ok).toBe(false);
  expect(log()).toMatch(/invomax import failed \w+/);
  expect(await importOnce(cfg, { sleep, now: () => { throw new Error('clock'); } })).toMatchObject({ ok: false });
  expect(count('im_imports')).toBe(2);
});

test('a short read never reaches the database', async () => {
  const many = Array.from({ length: 100 }, (_, i) => String(9001000 + i));
  put(many.map((n) => inv(n)), many.map((n) => line(n, 1)));
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true, invoices: 100 });
  sleepCalls = [];
  put(many.slice(0, 80).map((n) => inv(n)), many.slice(0, 80).map((n) => line(n, 1)));
  const r = await importOnce(cfg, { sleep });
  expect(r).toMatchObject({ ok: false, tries: 4, error: 'too few bills (80 of 100)' });
  expect(sleepCalls).toEqual([60_000, 60_000, 60_000]);
  expect(q<{ n: number }>("SELECT count(*) AS n FROM im_invoices WHERE gone_at = ''")[0].n).toBe(100);
  put(many.map((n) => inv(n)), []); // DETAIL decodes to nothing
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: false, error: 'too few bills (100 of 100)' });
  expect(count('im_lines')).toBe(100);
  put(many.slice(0, 91).map((n) => inv(n)), many.slice(0, 91).map((n) => line(n, 1))); // 91% is fine
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true, gone: 9 });
});

test('the lock: a second taker waits for the release', () => {
  const first = takeLock(cfg.importDir);
  expect(first).not.toBeNull();
  expect(takeLock(cfg.importDir)).toBeNull();
  releaseLock(first as NonNullable<typeof first>);
  const again = takeLock(cfg.importDir);
  expect(again).not.toBeNull();
  releaseLock(again as NonNullable<typeof again>);
});

test('another process holding the lock blocks the import; killing it frees the lock', async () => {
  mkdirSync(cfg.importDir, { recursive: true });
  const script =
    "const { DatabaseSync } = require('node:sqlite');" +
    'const db = new DatabaseSync(process.argv[1]);' +
    "db.exec('BEGIN EXCLUSIVE'); console.log('held'); setInterval(() => undefined, 1000);";
  const child = spawn(process.execPath, ['-e', script, join(cfg.importDir, 'lock.db')], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((ok, fail) => {
      child.stdout.on('data', (b: Buffer) => b.toString().includes('held') && ok());
      child.on('error', fail);
      child.on('exit', () => fail(new Error('child ended early')));
    });
    expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: false, error: 'already running' });
    expect(existsSync(cfg.invomaxDb)).toBe(false);
  } finally {
    const exited = new Promise((ok) => child.on('exit', ok));
    child.kill();
    await exited;
  }
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true, invoices: 3 });
});

test('the lock is released after a success and after a failure', async () => {
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true });
  writeFileSync(join(cfg.invomaxDir, 'INVOICE.btv'), Buffer.from('not a btrieve file'));
  expect(await importOnce(cfg, { sleep, copy: () => { throw new Error('boom'); } })).toMatchObject({ ok: false, error: 'boom' });
  initial();
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true });
});

test('folders that only share a name prefix do not overlap; one inside the other does, either way', async () => {
  const refused = 'import folder is inside the InvoMax folder';
  const dir = (n: string): string => join(tmp.dir, n);
  const run = (invomaxDir: string, importDir: string) => importOnce({ ...cfg, invomaxDir, importDir }, { sleep });
  expect((await run(dir('files'), dir('files2'))).error).not.toBe(refused);
  expect((await run(dir('files'), join(dir('files'), '..x'))).error).toBe(refused);
  expect((await run(join(dir('im2'), 'inner'), dir('im2'))).error).toBe(refused);
});

test('an import folder inside (or around) the InvoMax folder is refused, and nothing is written there', async () => {
  const inside = { ...cfg, importDir: join(cfg.invomaxDir, 'copies') };
  expect(await importOnce(inside, { sleep })).toMatchObject({ ok: false, error: 'import folder is inside the InvoMax folder' });
  expect(existsSync(inside.importDir)).toBe(false);
  expect(await importOnce({ ...cfg, importDir: cfg.invomaxDir.toUpperCase() }, { sleep })).toMatchObject({ ok: false });
  const around = { ...cfg, invomaxDir: join(tmp.dir, 'im'), importDir: join(tmp.dir, 'im', 'x', 'y') };
  expect(await importOnce(around, { sleep })).toMatchObject({ ok: false });
  expect(await importOnce({ ...cfg, invomaxDir: tmp.dir }, { sleep })).toMatchObject({ ok: false }); // importDir is under it
  expect(readdirSync(cfg.invomaxDir).sort()).toEqual(['DETAIL.btv', 'INVOICE.btv']);
  expect(await importOnce(cfg, { sleep })).toMatchObject({ ok: true });
});

test('import-invomax command', async () => {
  const out: string[] = [];
  expect(await runImportCommand(cfg, (s) => out.push(s))).toBe(0);
  expect(out.join('\n')).toMatch(/3 invoices/);
});

test('import-invomax command prints the error and returns 1', async () => {
  writeFileSync(join(cfg.invomaxDir, 'INVOICE.btv'), Buffer.from('not a btrieve file'));
  const out: string[] = [];
  expect(await runImportCommand(cfg, (s) => out.push(s), async () => undefined)).toBe(1);
  expect(out.join('\n')).toMatch(/failed/);
});

test('shop-settings.json: defaults, override, and a bad file only warns', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const at = (env: Record<string, string> = {}): Config => loadConfig({ SHOP_ROOT: tmp.dir, ...env });
    const dflt = String.raw`C:\hunni\files`;
    expect(at().invomaxDir).toBe(dflt);
    expect(at().invomaxDb).toBe(join(tmp.dir, 'invomax.db'));
    writeFileSync(join(tmp.dir, 'shop-settings.json'), JSON.stringify({ invomaxDir: 'D:\\x', backupTargets: ['E:\\b'] }));
    expect(at()).toMatchObject({ invomaxDir: 'D:\\x', backupTargets: ['E:\\b'] });
    expect(at({ INVOMAX_DIR: join(tmp.dir, 'im') }).invomaxDir).toBe(join(tmp.dir, 'im'));
    expect(warn).not.toHaveBeenCalled();
    writeFileSync(join(tmp.dir, 'shop-settings.json'), '{ nope');
    expect(at().invomaxDir).toBe(dflt);
    writeFileSync(join(tmp.dir, 'shop-settings.json'), JSON.stringify({ invomaxDir: 5 }));
    expect(at().backupTargets).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
  }
});

test('openImDb is idempotent', () => {
  openImDb(cfg.invomaxDb).close();
  const db = openImDb(cfg.invomaxDb);
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'im_invoices'").get()).toEqual({ n: 1 });
  db.close();
});
