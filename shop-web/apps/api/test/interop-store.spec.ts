// tickets.db is shared with Python's tickets.Store: each side reads what the other wrote.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { edit, markDeleted, type Ticket } from '@shop/domain';
import { openDb } from '../src/db';
import { TicketStore } from '../src/store';
import { py, pyEnv, REPO_ROOT, tempDir } from './py';

jest.setTimeout(30_000);

const DESK = {
  first: 'jane',
  last: 'testcase',
  phone: '5550100000',
  year: '2019',
  make: 'cadillac',
  model: 'cts',
  plate: 'xks-4827',
  request: 'oil change',
};

const today = (): string => {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe('tickets.db shared with python', () => {
  let path: string;
  let db: DatabaseSync;
  let s: TicketStore;
  let done: () => void;

  beforeEach(() => {
    const tmp = tempDir();
    done = tmp.done;
    path = join(tmp.dir, 'tickets.db');
    db = openDb(path);
    s = new TicketStore(db);
  });

  afterEach(() => {
    db.close();
    done();
  });

  it('python reads what TS wrote', () => {
    const t = s.create({ ...DESK, notes: 'café' });
    edit(
      t,
      {
        lines: [
          { desc: 'diag', labor: 60 },
          { desc: 'brake pads', qty: 2, price: 12.5, labor: 80, code: 'pads' },
        ],
        deposits: [{ amount: 20, method: 'card', date: today(), note: 'half' }],
      },
      'desk',
    );
    s.save(t, 1);
    const out = py(
      [
        'import dataclasses, json, os, tickets',
        's = tickets.Store(os.environ["DB"])',
        't = s.get(int(os.environ["ID"]))',
        'raw = s.db.execute("SELECT data FROM tickets WHERE id = ?", (t.id,)).fetchone()[0]',
        's.close()',
        'print(json.dumps({"ticket": dataclasses.asdict(t), "same_bytes": json.dumps(json.loads(raw)) == raw}))',
      ].join('\n'),
      { DB: path, ID: String(t.id) },
    );
    const got = JSON.parse(out) as { ticket: Ticket; same_bytes: boolean };
    expect(got.ticket).toEqual(s.get(t.id));
    expect(got.ticket.lines[1]).toEqual({ desc: 'brake pads', qty: 2, price: 12.5, labor: 80, code: 'PADS', id: 2 });
    expect(got.ticket.deposits).toHaveLength(1);
    expect(got.same_bytes).toBe(true); // TS's JSON is byte for byte what Python's json.dumps writes
  });

  it('TS reads what python wrote, unknown keys kept', () => {
    const id = py(
      [
        'import json, os, tickets',
        's = tickets.Store(os.environ["DB"])',
        't = s.create(json.loads(os.environ["DESK"]))',
        'd = json.loads(s.db.execute("SELECT data FROM tickets WHERE id = ?", (t.id,)).fetchone()[0])',
        'd["zz_future"] = "x"',
        's.db.execute("UPDATE tickets SET data = ? WHERE id = ?", (json.dumps(d), t.id))',
        's.close()',
        'print(t.id)',
      ].join('\n'),
      { DB: path, DESK: JSON.stringify(DESK) },
    );
    const t = s.get(Number(id)) as Ticket;
    expect(t).toMatchObject({ first: 'JANE', last: 'TESTCASE', phone: '(555)010-0000', version: 1 });
    expect(t.zz_future).toBe('x');
    t.notes = 'from TS';
    s.save(t, 1);
    expect(s.get(t.id)).toMatchObject({ notes: 'from TS', version: 2, zz_future: 'x' });
    const back = py(
      [
        'import json, os, tickets',
        's = tickets.Store(os.environ["DB"])',
        't = s.get(int(os.environ["ID"]))',
        's.close()',
        'print(json.dumps([t.notes, t.version]))',
      ].join('\n'),
      { DB: path, ID: String(t.id) },
    );
    expect(JSON.parse(back)).toEqual(['from TS', 2]);
  });

  it('python save keeps deleted fields', () => {
    const t = s.create(DESK);
    s.save(markDeleted(t, 'mechanic#3', '2026-11-18T14:03:09'), 1);
    const out = py(
      [
        'import json, os, tickets',
        's = tickets.Store(os.environ["DB"])',
        't = s.get(int(os.environ["ID"]))',
        'seen = [t.status, t.deleted_at, t.deleted_by, t.deleted_from]',
        't.notes = "from python"',
        's.save(t, t.version)',
        'listed = [x.id for x in s.list()]',
        's.close()',
        'print(json.dumps({"seen": seen, "listed": listed}))',
      ].join('\n'),
      { DB: path, ID: String(t.id) },
    );
    // python loads the three fields, keeps them on its save, and leaves the deleted ticket off its list
    expect(JSON.parse(out)).toEqual({ seen: ['deleted', '2026-11-18T14:03:09', 'mechanic#3', 'waiting'], listed: [] });
    expect(s.get(t.id)).toMatchObject({
      status: 'deleted',
      notes: 'from python',
      version: 3,
      deleted_at: '2026-11-18T14:03:09',
      deleted_by: 'mechanic#3',
      deleted_from: 'waiting',
    });
  });

  it('waits for a python write lock', async () => {
    const t = s.create(DESK);
    const child = spawn(
      'python',
      [
        '-c',
        [
          'import os, sqlite3, time',
          'db = sqlite3.connect(os.environ["DB"], isolation_level=None)',
          'db.execute("BEGIN IMMEDIATE")',
          'print("locked", flush=True)',
          'time.sleep(1.0)',
          'db.execute("COMMIT")',
          'db.close()',
        ].join('\n'),
      ],
      { cwd: REPO_ROOT, env: pyEnv({ DB: path }), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = new Promise<number | null>((ok, fail) => {
      child.on('error', fail);
      child.on('close', ok);
    });
    await new Promise<void>((ok, fail) => {
      let out = '';
      child.stdout.on('data', (b: Buffer) => {
        out += b.toString();
        if (out.includes('locked')) ok();
      });
      child.on('close', (code) => fail(new Error(`python exited (${code}) before locking`)));
    });
    const start = Date.now();
    t.notes = 'after the lock';
    s.save(t, 1);
    const waited = Date.now() - start;
    expect(waited).toBeGreaterThanOrEqual(800);
    expect(waited).toBeLessThan(5000);
    expect(s.get(t.id)).toMatchObject({ notes: 'after the lock', version: 2 });
    expect(await exited).toBe(0);
  });
});
