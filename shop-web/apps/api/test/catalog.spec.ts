// Ports test_catalog and test_vehicles of tests/test_shop.py (the kiosk sign-in left out: the desk reads
// vehicles here), plus hints() on odd catalog files.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hints } from '../src/routes/catalog';
import { makeServer, type TestServer } from './helpers';
import { tempDir } from './py';

jest.setTimeout(30_000);

const HEADER = 'code,description,aliases,sided,part_price,labor_price\n';
const CATALOG =
  HEADER +
  'FBP,FRONT BRAKE PADS,front brake pads|front pads,no,100,100\n' +
  'OIL,OIL CHANGE,oil change,no,40,0\n' +
  Array.from(
    { length: 10 },
    (_, i) => `BR${i},BRAKE THING ${i},brake thing ${i},no,${i},5\n`,
  ).join('');

let s: TestServer;
beforeEach(async () => {
  s = await makeServer();
});
afterEach(() => s.close());

it('catalog', async () => {
  writeFileSync(s.config.catalog, CATALOG, 'utf8');
  const c = await s.admin();
  let r = await s.call('/api/catalog?q=BRAKE', undefined, c);
  expect(r.status).toBe(200);
  const h = r.body as unknown[];
  expect(h).toHaveLength(8); // capped
  expect(h[0]).toEqual({
    code: 'FBP',
    description: 'FRONT BRAKE PADS',
    part_price: 100,
    labor_price: 100,
  });
  expect(Object.keys(h[0] as object)).toEqual([
    'code',
    'description',
    'part_price',
    'labor_price',
  ]);
  expect(
    (
      (await s.call('/api/catalog?q=front%20pads', undefined, c))
        .body as Array<{ code: string }>
    )[0]?.code,
  ).toBe('FBP'); // alias
  const al = await s.tech('Al Fixit');
  expect(
    (
      (await s.call('/api/catalog?q=oil', undefined, al)).body as Array<{
        code: string;
      }>
    )[0]?.code,
  ).toBe('OIL'); // mechanics too
  expect((await s.call('/api/catalog?q=', undefined, c)).body).toEqual([]);
  expect((await s.call('/api/catalog', undefined, c)).body).toEqual([]);
  expect((await s.call('/api/catalog?q=+', undefined, c)).body).toEqual([]); // just a space
  r = await s.call('/api/catalog?q=brake');
  expect(r.status).toBe(401);
  rmSync(s.config.catalog);
  expect(await s.call('/api/catalog?q=brake', undefined, c)).toMatchObject({
    status: 200,
    body: [],
  }); // no catalog: no hints
});

it('hints from odd catalog files', () => {
  const { dir, done } = tempDir();
  try {
    const file = join(dir, 'parts.csv');
    const at = (text: string, q: string) => {
      writeFileSync(file, text, 'utf8');
      return hints(q, file);
    };
    // quoted fields, CRLF, a blank line, a BOM
    expect(
      at(
        `\ufeff${HEADER.replace('\n', '\r\n')}"X1","PADS, ""CERAMIC""",pads|cer,no, 12.5 ,0\r\n\r\nX2,CLIP,clip,no,1,2\r\n`,
        'ceramic',
      ),
    ).toEqual([
      {
        code: 'X1',
        description: 'PADS, "CERAMIC"',
        part_price: 12.5,
        labor_price: 0,
      },
    ]);
    expect(at(`${HEADER}X1,PADS,pads,no,1,\n`, 'pads')).toEqual([]); // a price that isn't a number: no hints
    expect(at(`${HEADER}X1,PADS,pads\n`, 'pads')).toEqual([]); // a short row
    expect(at('code,description\nX1,PADS\n', 'pads')).toEqual([]); // columns missing
    expect(at(`${HEADER}X1,PADS,pads,no,0x10,1\n`, 'pads')).toEqual([]); // not a Python float
    expect(
      at(
        `${HEADER}X1,OLD,old,no,1,1\nX1,NEW,new,no,2,2\nX2,PADS,old,no,3,3\n`,
        'old',
      ).map((p) => p.code),
    ).toEqual(['X2']); // a code once: the last row wins, in the first one's place
    expect(
      at(
        `${HEADER}X1,OLD,old,no,1,1\nX2,PADS,old,no,3,3\nX1,NEW,new,no,2,2\n`,
        'new',
      ).map((p) => p.code),
    ).toEqual(['X1']);
    expect(hints('pads', join(dir, 'missing.csv'))).toEqual([]);
  } finally {
    done();
  }
});

it('vehicles', async () => {
  const cars = { TOYOTA: { CAMRY: [1990, 2027] } };
  writeFileSync(s.config.vehicles, JSON.stringify(cars), 'utf8');
  expect((await s.call('/api/vehicles')).status).toBe(401);
  const c = await s.admin();
  let r = await s.call('/api/vehicles', undefined, c);
  expect([r.status, r.body, r.headers['content-type']]).toEqual([
    200,
    cars,
    'application/json',
  ]);
  expect(
    (await s.call('/api/vehicles', undefined, await s.tech('Al Fixit'))).body,
  ).toEqual(cars); // mechanics too
  rmSync(s.config.vehicles);
  expect(await s.call('/api/vehicles', undefined, c)).toMatchObject({
    status: 200,
    body: cars,
  }); // read once
  s.config.vehicles += '.missing';
  expect(await s.call('/api/vehicles', undefined, c)).toMatchObject({
    status: 200,
    body: {},
  });
  s.config.vehicles = join(s.config.root, 'bad.json');
  writeFileSync(s.config.vehicles, '{not json', 'utf8');
  r = await s.call('/api/vehicles', undefined, c);
  expect([r.status, r.body, r.text]).toEqual([200, {}, '{}']);
});
