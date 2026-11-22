// Job mapping: rules that map InvoMax bill lines (invomax.db) to parts.csv job codes, the in-memory index over
// all lines, the proposals and the admin routes. Made-up bills only (9000001+).
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { GENERIC_CODES } from '@shop/invomax';
import { openDb } from '../src/db';
import { JobIndex } from '../src/jobs/index';
import { JobMap, matchRule, normalDesc, type Rule } from '../src/jobs/jobmap';
import { propose } from '../src/jobs/propose';
import { openImDb } from '../src/invomax/imdb';
import { loadParts } from '../src/routes/catalog';
import { makeServer, type TestServer } from './helpers';
import { REPO_ROOT, tempDir } from './py';

jest.setTimeout(30_000);

const PARTS = loadParts(join(REPO_ROOT, 'parts.csv'));

const rule = (im_code: string, words: string[], job: string, made_at = '2026-11-21T10:00:00', id = 1): Rule => ({
  id,
  im_code,
  words,
  job,
  made_by: 'admin#1',
  made_at,
});

type L = { inv: string; no: number; code: string; desc: string; kind?: 'part' | 'labor' | 'other'; unit?: number; qty?: number };

function putBill(im: DatabaseSync, inv: string, date: string, gone = false): void {
  im.prepare(
    `INSERT INTO im_invoices (invoice_no, "date", "key", name, "first", "last", phone, plate, address, parts, labor,
       supplies, discount, deposit, tax, total, balance, tax_rate, hash, lines_hash, first_seen, updated_at, gone_at, plate_norm)
     VALUES (?, ?, '', 'JANE DOE', 'JANE', 'DOE', '5550100000', 'XKS-4827', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, '', '', '', '', ?, 'XKS4827')`,
  ).run(inv, date, gone ? '2026-11-21T01:00:00' : '');
}

function putLine(im: DatabaseSync, l: L): void {
  const qty = l.qty ?? 1;
  const unit = l.unit ?? 10000;
  im.prepare(
    `INSERT INTO im_lines (invoice_no, line_no, code, description, kind, qty, unit, amount, vehicle, year, make, model, trim)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2019 Cadillac XT5', 2019, 'Cadillac', 'XT5', '')`,
  ).run(l.inv, l.no, l.code, l.desc, l.kind ?? 'labor', qty, unit, Math.round(qty * unit));
}

function putImport(im: DatabaseSync): void {
  im.prepare(
    `INSERT INTO im_imports (started, finished, ok, tries, invoices, lines, added, changed, gone)
     VALUES ('2026-11-21T01:00:00', '2026-11-21T01:00:05', 1, 1, 0, 0, 0, 0, 0)`,
  ).run();
}

describe('normalDesc', () => {
  it('upper-cases, splits on non-alphanumerics and drops digit-only tokens', () => {
    expect(normalDesc('R&R FRT pads (2)')).toEqual(['R', 'R', 'FRT', 'PADS']);
    expect(normalDesc('  ')).toEqual([]);
    expect(normalDesc('5W30 oil, 5 qt')).toEqual(['5W30', 'OIL', 'QT']);
  });
});

describe('GENERIC_CODES', () => {
  it('is LABOR and INSTALL- (LAYOUT.md)', () => {
    expect([...GENERIC_CODES]).toEqual(['LABOR', 'INSTALL-']);
  });
});

describe('matchRule', () => {
  const line = { code: 'LABOR', words: normalDesc('REPLACE FRONT BRAKE PADS') };

  it('more words wins', () => {
    const fbp = rule('LABOR', ['FRONT', 'PADS'], 'FBP', '2026-11-01T00:00:00', 1);
    const rbp = rule('LABOR', ['PADS'], 'RBP', '2026-11-21T00:00:00', 2);
    expect(matchRule(line, [rbp, fbp])?.job).toBe('FBP');
  });

  it('a tie goes to the newer made_at', () => {
    const a = rule('LABOR', ['FRONT'], 'FBP', '2026-11-01T00:00:00', 1);
    const b = rule('LABOR', ['PADS'], 'RBP', '2026-11-02T00:00:00', 2);
    expect(matchRule(line, [a, b])?.job).toBe('RBP');
    expect(matchRule(line, [b, a])?.job).toBe('RBP');
  });

  it('needs the code and every word; words compare as a set', () => {
    expect(matchRule(line, [rule('INSTALL-', ['PADS'], 'FBP')])).toBeNull();
    expect(matchRule(line, [rule('LABOR', ['REAR', 'PADS'], 'RBP')])).toBeNull();
    expect(matchRule({ code: 'LABOR', words: ['R', 'R', 'PADS'] }, [rule('LABOR', ['R', 'PADS'], 'FBP')])?.job).toBe('FBP');
  });

  it('empty words match any line with that code', () => {
    expect(matchRule({ code: 'FBP', words: ['ANYTHING'] }, [rule('FBP', [], 'FBP')])?.job).toBe('FBP');
    expect(matchRule({ code: 'FBP', words: [] }, [rule('FBP', [], 'FBP')])?.job).toBe('FBP');
  });
});

describe('propose', () => {
  const group = (im_code: string, desc: string): Parameters<typeof propose>[0] => ({ im_code, words: normalDesc(desc) });

  it('finds FBP for FRONT BRAKE PADS with the fewest words that pick it out', () => {
    expect(propose(group('LABOR', 'FRONT BRAKE PADS'), PARTS)).toEqual({ job: 'FBP', words: ['FRONT', 'PADS'] });
  });

  it('is null for MISC SHOP WORK, and when two parts tie', () => {
    expect(propose(group('LABOR', 'MISC SHOP WORK'), PARTS)).toBeNull();
    expect(propose(group('LABOR', 'FRONT BRAKE PADS AND ROTORS'), PARTS)).toBeNull();
  });

  it('a code that is a part code proposes it for every line of that code', () => {
    expect(propose({ im_code: 'FBP', words: [] }, PARTS)).toEqual({ job: 'FBP', words: [] });
    expect(propose({ im_code: 'ZZZ', words: [] }, PARTS)).toBeNull();
  });

  it('whole tokens only', () => {
    expect(propose(group('LABOR', 'OILY RAGS'), PARTS)).toBeNull();
  });
});

describe('JobIndex', () => {
  let tmp: { dir: string; done: () => void };
  let db: DatabaseSync;
  let im: DatabaseSync;
  let map: JobMap;
  let jobs: JobIndex;

  beforeEach(() => {
    tmp = tempDir();
    db = openDb(join(tmp.dir, 'tickets.db'));
    im = openImDb(join(tmp.dir, 'invomax.db'));
    map = new JobMap(db);
    jobs = new JobIndex(map, im, join(REPO_ROOT, 'parts.csv'));
    putBill(im, '9000001', '2026-11-01');
    putBill(im, '9000002', '2026-11-10');
    putBill(im, '9000003', '2026-11-12', true); // gone
    putLine(im, { inv: '9000001', no: 1, code: 'LABOR', desc: 'REPLACE FRONT BRAKE PADS', unit: 12000 });
    putLine(im, { inv: '9000001', no: 2, code: 'FBP', desc: 'PADS CERAMIC', kind: 'part', unit: 5000 });
    putLine(im, { inv: '9000001', no: 3, code: 'NOTE', desc: 'THANK YOU', kind: 'other', unit: 0 });
    putLine(im, { inv: '9000002', no: 1, code: 'LABOR', desc: 'replace front brake pads!', unit: 13000 });
    putLine(im, { inv: '9000002', no: 2, code: 'LABOR', desc: 'MISC SHOP WORK', unit: 2000 });
    putLine(im, { inv: '9000002', no: 3, code: 'FBP', desc: 'PADS 2', kind: 'part', unit: 6000, qty: 2 });
    putLine(im, { inv: '9000002', no: 4, code: 'FBP', desc: 'NO CHARGE', kind: 'part', unit: 0 });
    putLine(im, { inv: '9000003', no: 1, code: 'FBP', desc: 'PADS', kind: 'part', unit: 9900 });
  });

  afterEach(() => {
    db.close();
    im.close();
    tmp.done();
  });

  it('maps lines by rule: more words wins; an empty-words rule maps all lines of a specific code', () => {
    map.put({ im_code: 'LABOR', words: ['FRONT', 'PADS'], job: 'FBP' }, 'admin#1');
    map.put({ im_code: 'LABOR', words: ['PADS'], job: 'RBP' }, 'admin#1');
    map.put({ im_code: 'FBP', words: [], job: 'FBP' }, 'admin#1');
    expect(jobs.job('9000001', 1)).toBe('FBP');
    expect(jobs.job('9000002', 1)).toBe('FBP');
    expect(jobs.job('9000002', 2)).toBeNull();
    expect(['9000001|2', '9000002|3', '9000002|4', '9000003|1'].map((k) => jobs.job(k.split('|')[0] as string, Number(k.split('|')[1])))).toEqual([
      'FBP',
      'FBP',
      'FBP',
      'FBP',
    ]);
    expect(jobs.job('9999999', 1)).toBeNull();
  });

  it('samples: per unit, newest first, the kind asked for, not gone, not unit <= 0', () => {
    map.put({ im_code: 'LABOR', words: ['FRONT', 'PADS'], job: 'FBP' }, 'admin#1');
    map.put({ im_code: 'FBP', words: [], job: 'FBP' }, 'admin#1');
    expect(jobs.samples('FBP', 'labor')).toEqual([
      { unit: 13000, date: '2026-11-10', year: 2019, make: 'Cadillac', model: 'XT5' },
      { unit: 12000, date: '2026-11-01', year: 2019, make: 'Cadillac', model: 'XT5' },
    ]);
    expect(jobs.samples('FBP', 'part').map((x) => x.unit)).toEqual([6000, 5000]);
  });

  it('an ignore rule gives the job ignore, which has no samples', () => {
    map.put({ im_code: 'LABOR', words: ['MISC'], job: 'ignore' }, 'admin#1');
    expect(jobs.job('9000002', 2)).toBe('ignore');
    expect(jobs.samples('ignore', 'labor')).toEqual([]);
  });

  it('groups split LABOR by description but not other codes, biggest first; unmappedOnly leaves mapped ones out', () => {
    const g = jobs.groups({ unmappedOnly: false });
    expect(g.map((x) => [x.im_code, x.words.join(' '), x.lines, x.dollars])).toEqual([
      ['FBP', '', 3, 170],
      ['LABOR', 'REPLACE FRONT BRAKE PADS', 2, 250],
      ['LABOR', 'MISC SHOP WORK', 1, 20],
    ]);
    expect(g[0]?.samples).toEqual(['PADS 2', 'NO CHARGE', 'PADS CERAMIC']); // most lines, then newest, then line order
    expect(g[1]?.samples).toEqual(['replace front brake pads!', 'REPLACE FRONT BRAKE PADS']);
    expect(g[1]?.proposed).toEqual({ job: 'FBP', words: ['FRONT', 'PADS'] });
    expect(g[0]?.proposed).toEqual({ job: 'FBP', words: [] });
    expect(g[2]?.proposed).toBeNull();
    expect(g.every((x) => x.rule === null)).toBe(true);
    map.put({ im_code: 'LABOR', words: ['FRONT', 'PADS'], job: 'FBP' }, 'admin#1');
    const all = jobs.groups({ unmappedOnly: false });
    expect(all[1]?.rule).toEqual({ job: 'FBP', words: ['FRONT', 'PADS'] });
    expect(jobs.groups({ unmappedOnly: true }).map((x) => x.im_code + ' ' + x.words.join(' '))).toEqual(['FBP ', 'LABOR MISC SHOP WORK']);
  });

  it('coverage counts part and labor lines and their dollars, not gone bills', () => {
    expect(jobs.coverage()).toEqual({ lines: 6, mapped_lines: 0, dollars: 440, mapped_dollars: 0 });
    map.put({ im_code: 'LABOR', words: ['FRONT', 'PADS'], job: 'FBP' }, 'admin#1');
    expect(jobs.coverage()).toEqual({ lines: 6, mapped_lines: 2, dollars: 440, mapped_dollars: 250 });
  });

  it('rebuilds after a rule change (even in the same second) and after an import, else keeps its build', () => {
    expect(jobs.job('9000002', 2)).toBeNull();
    const built = jobs.builds;
    jobs.job('9000002', 2);
    expect(jobs.builds).toBe(built); // nothing changed: no rebuild
    map.put({ im_code: 'LABOR', words: ['MISC'], job: 'ignore' }, 'admin#1');
    expect(jobs.job('9000002', 2)).toBe('ignore');
    expect(jobs.builds).toBe(built); // a rule change applies the rules again, without reading the lines
    const applied = jobs.applies;
    map.put({ im_code: 'LABOR', words: ['MISC'], job: 'FBP' }, 'admin#1'); // same key, same second
    expect(jobs.job('9000002', 2)).toBe('FBP');
    expect(jobs.applies).toBe(applied + 1);
    putLine(im, { inv: '9000002', no: 5, code: 'LABOR', desc: 'MISC SHOP WORK' });
    expect(jobs.job('9000002', 5)).toBeNull(); // not yet: no new import row
    putImport(im);
    expect(jobs.job('9000002', 5)).toBe('FBP');
  });

  it('a second JobMap on the same tickets.db changing rules is seen by the version key', () => {
    expect(jobs.coverage().mapped_lines).toBe(0);
    new JobMap(db).put({ im_code: 'FBP', words: [], job: 'FBP' }, 'admin#2');
    expect(jobs.coverage().mapped_lines).toBe(3);
  });

  it('upserts by (im_code, words): words are a set, digit-only tokens dropped', () => {
    const a = map.put({ im_code: 'LABOR', words: ['PADS', 'FRONT', 'FRONT', '2'], job: 'RBP' }, 'admin#1');
    const b = map.put({ im_code: 'LABOR', words: ['FRONT', 'PADS'], job: 'FBP' }, 'admin#3');
    expect(b).toMatchObject({ id: a.id, im_code: 'LABOR', words: ['FRONT', 'PADS'], job: 'FBP', made_by: 'admin#3' });
    expect(map.rules()).toHaveLength(1);
    expect(map.remove('LABOR', ['PADS', 'FRONT'])).toBe(true);
    expect(map.remove('LABOR', ['PADS', 'FRONT'])).toBe(false);
    expect(map.rules()).toEqual([]);
  });
});

describe('job-map routes', () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await makeServer();
    putBill(s.im, '9000001', '2026-11-01');
    putLine(s.im, { inv: '9000001', no: 1, code: 'LABOR', desc: 'REPLACE FRONT BRAKE PADS', unit: 12000 });
    putLine(s.im, { inv: '9000001', no: 2, code: 'LABOR', desc: 'MISC SHOP WORK', unit: 2000 });
  });
  afterEach(() => s.close());

  it('lists groups and coverage, adds and deletes a rule, and the list follows', async () => {
    const a = await s.admin();
    const r = await s.call('/api/job-map?unmapped=1&page=1', undefined, a);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ page: 1, coverage: { lines: 2, mapped_lines: 0, dollars: 140, mapped_dollars: 0 } });
    expect((r.body as { groups: unknown[] }).groups).toHaveLength(2);
    const add = await s.call('/api/job-map', { im_code: 'LABOR', words: ['FRONT', 'PADS'], job: 'FBP' }, a);
    expect(add.status).toBe(200);
    expect(add.body).toEqual({
      rule: { id: 1, im_code: 'LABOR', words: ['FRONT', 'PADS'], job: 'FBP', made_by: `admin#${s.ids['Owner Test']}`, made_at: expect.any(String) },
    });
    const after = (await s.call('/api/job-map?unmapped=1', undefined, a)).body as { groups: { words: string[] }[]; coverage: { mapped_lines: number } };
    expect(after.groups.map((g) => g.words.join(' '))).toEqual(['MISC SHOP WORK']);
    expect(after.coverage.mapped_lines).toBe(1);
    expect(s.deps.jobs.job('9000001', 1)).toBe('FBP');
    const del = await s.call('/api/job-map/delete', { im_code: 'LABOR', words: ['PADS', 'FRONT'] }, a);
    expect([del.status, del.body]).toEqual([200, { deleted: true }]);
    expect(s.deps.jobs.job('9000001', 1)).toBeNull();
    expect((await s.call('/api/job-map?page=2', undefined, a)).body).toMatchObject({ groups: [], page: 2 });
  });

  it('refuses a job that is not a parts.csv code or ignore, and bad input', async () => {
    const a = await s.admin();
    const post = async (body: unknown): Promise<[number, unknown]> => {
      const r = await s.call('/api/job-map', body, a);
      return [r.status, r.body];
    };
    expect(await post({ im_code: 'LABOR', words: [], job: 'NOPE' })).toEqual([400, { error: 'job must be a parts.csv code or ignore' }]);
    expect((await post({ im_code: 'LABOR', words: ['MISC'], job: 'ignore' }))[0]).toBe(200);
    expect((await post({ im_code: '', words: [], job: 'FBP' }))[0]).toBe(400);
    expect((await post({ im_code: 'TOOLONGCODE', words: [], job: 'FBP' }))[0]).toBe(400);
    expect((await post({ im_code: 'LABOR', words: ['front'], job: 'FBP' }))[0]).toBe(400);
    expect((await post({ im_code: 'LABOR', words: ['A B'], job: 'FBP' }))[0]).toBe(400);
    expect((await post({ im_code: 'LABOR', words: Array(11).fill('PADS'), job: 'FBP' }))[0]).toBe(400);
    expect((await post({ im_code: 'LABOR', job: 'FBP' }))[0]).toBe(400);
    expect((await s.call('/api/job-map?page=0', undefined, a)).status).toBe(400);
    expect((await s.call('/api/job-map?unmapped=yes', undefined, a)).status).toBe(400);
    expect(s.log()).not.toMatch(/MISC|BRAKE/);
  });

  it('mechanics get 403, no session 401', async () => {
    const t = await s.tech('Al Fixit');
    expect((await s.call('/api/job-map', undefined, t)).status).toBe(403);
    expect((await s.call('/api/job-map', { im_code: 'LABOR', words: [], job: 'FBP' }, t)).status).toBe(403);
    expect((await s.call('/api/job-map/delete', { im_code: 'LABOR', words: [] }, t)).status).toBe(403);
    expect((await s.call('/api/job-map')).status).toBe(401);
  });
});
