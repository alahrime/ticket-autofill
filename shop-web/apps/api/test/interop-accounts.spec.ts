// Accounts in tickets.db are shared with Python's accounts.py: hashes, users and session tokens work both ways,
// so nobody signs in again after the switch.
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  Accounts,
  casefold,
  checkSecret,
  clientKey,
  hashSecret,
} from '../src/accounts';
import { openDb } from '../src/db';
import { py, tempDir } from './py';

jest.setTimeout(60_000);

const PIN = '123456';
const PW = 'made-up-pass-1';

describe('accounts shared with python', () => {
  let path: string;
  let db: DatabaseSync | undefined;
  let done: () => void;

  beforeEach(() => {
    const tmp = tempDir();
    done = tmp.done;
    path = join(tmp.dir, 'tickets.db');
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    done();
  });

  const open = (): Accounts => {
    db = openDb(path);
    return new Accounts(db, { iterations: 1000 });
  };

  it('python hash verifies in TS and back', async () => {
    const fromPy = py(
      'import accounts, os; print(accounts.hash_secret(os.environ["S"], 1000))',
      { S: 'café 1234 pw' },
    ).trim();
    expect(await checkSecret('café 1234 pw', fromPy)).toBe(true);
    expect(await checkSecret('cafe 1234 pw', fromPy)).toBe(false);
    const fromTs = await hashSecret('café 1234 pw', 1000);
    const check =
      'import accounts, os; print(accounts.check_secret(os.environ["S"], os.environ["H"]))';
    expect(py(check, { S: 'café 1234 pw', H: fromTs }).trim()).toBe('True');
    expect(py(check, { S: 'cafe 1234 pw', H: fromTs }).trim()).toBe('False');
    // the default 200 000 iterations, both ways
    const full = await hashSecret(PW);
    expect(py(check, { S: PW, H: full }).trim()).toBe('True');
  });

  it('python session token works in TS', async () => {
    const tok = py(
      'import accounts, os\n' +
        'a = accounts.Accounts(os.environ["DB"], iterations=1000)\n' +
        'a.add("Sam Testcase", "mechanic", "123456")\n' +
        'print(a.login("Sam Testcase", "123456", "mechanic", "c")[0])\n' +
        'a.close()',
      { DB: path },
    ).trim();
    const a = open();
    const s = a.session(tok);
    expect(s).toMatchObject({
      role: 'mechanic',
      name: 'Sam Testcase',
      user_id: 1,
    });
    expect(
      (await a.login('sam testcase', PIN, 'mechanic', 'c')).user.name,
    ).toBe('Sam Testcase'); // Python's hash
  });

  it('TS users and sessions work in python', async () => {
    const a = open();
    await a.add('Jane Testcase', 'admin', PW);
    const { token } = await a.login('Jane Testcase', PW, 'admin', 'c');
    db?.close();
    db = undefined;
    const out = py(
      'import accounts, os\n' +
        'a = accounts.Accounts(os.environ["DB"], iterations=1000)\n' +
        's = a.session(os.environ["TOK"])\n' +
        'print(s["role"], s["name"])\n' +
        'print(a.login("jane testcase", os.environ["PW"], "admin", "c")[1]["name"])\n' +
        'a.close()',
      { DB: path, TOK: token, PW },
    );
    expect(out.trim().split(/\r?\n/)).toEqual([
      'admin Jane Testcase',
      'Jane Testcase',
    ]);
  });

  it('kiosk sessions are deleted', () => {
    const tok = py(
      'import accounts, os\n' +
        'a = accounts.Accounts(os.environ["DB"], iterations=1000)\n' +
        'print(a.kiosk_session())\n' +
        'a.close()',
      { DB: path },
    ).trim();
    const a = open();
    expect(a.deleteKioskSessions()).toBe(1);
    expect(a.session(tok)).toBeNull();
  });

  it('names fold and client keys match python', () => {
    const names = [
      'Strauss',
      'Strauß',
      'STRAUẞ',
      'ﬁfi',
      'Fıla',
      'Fila',
      'İsa',
      'ΣΟΦΙΑ',
      'σοφια',
      'Jane Testcase',
    ];
    const pyFold = JSON.parse(
      py(
        'import json, os; print(json.dumps([n.casefold() for n in json.loads(os.environ["N"])]))',
        {
          N: JSON.stringify(names),
        },
      ),
    ) as string[];
    // equal under Python's casefold exactly when equal under ours
    names.forEach((x, i) =>
      names.forEach((y, j) =>
        expect([x, y, casefold(x) === casefold(y)]).toEqual([
          x,
          y,
          pyFold[i] === pyFold[j],
        ]),
      ),
    );
    const clients = [
      '203.0.113.9',
      ' 203.0.113.9 ',
      '2001:db8:1:2:aaaa::1',
      '2001:DB8::1',
      '::1',
      '::',
      '::ffff:203.0.113.9',
      'fe80::1:0:0:1',
      '0:0:1::',
      '1:0:0:2:0:0:0:3',
      'not an ip',
      '',
      '01.2.3.4',
      '127.0.0.1',
    ];
    const pyKeys = JSON.parse(
      py(
        'import accounts, json, os; print(json.dumps([accounts.client_key(c) for c in json.loads(os.environ["C"])]))',
        {
          C: JSON.stringify(clients),
        },
      ),
    ) as string[];
    expect(clients.map(clientKey)).toEqual(pyKeys);
  });
});
