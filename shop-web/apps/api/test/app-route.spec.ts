// The React admin app's pages (/bills, /jobs) and its built files (/app/assets/*), over a real server on a temp
// SHOP_ROOT whose config.app holds a made-up build.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeServer, send, type TestServer } from './helpers';

jest.setTimeout(60_000);

let s: TestServer;
let a: string;

const INDEX = '<!doctype html><html><head><title>Shop admin</title></head><body><div id="root"></div></body></html>';

function build(files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    const f = join(s.config.app, name);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
}

beforeEach(async () => {
  s = await makeServer();
  a = await s.admin();
  build({
    'index.html': INDEX,
    'assets/index-abc123.js': 'console.log(1);',
    'assets/index-abc123.css': 'body{margin:0}',
    'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/sub/deep.js': 'export {};',
    'secret.txt': 'not an asset',
  });
  writeFileSync(join(s.config.root, 'outside.txt'), 'outside');
});
afterEach(() => s.close());

describe('the app pages', () => {
  it.each(['/bills', '/jobs'])('%s: 303 to /admin without a session', async (path) => {
    const r = await s.call(path);
    expect([r.status, r.headers.location]).toEqual([303, '/admin']);
  });

  it.each(['/bills', '/jobs'])('%s: the built index.html for an admin, no-store and with the CSP', async (path) => {
    const r = await s.call(path, undefined, a);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.text).toBe(INDEX);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('a mechanic is sent to /admin too (never the admin app)', async () => {
    const m = await s.tech('Al Fixit');
    const r = await s.call('/bills', undefined, m);
    expect([r.status, r.headers.location]).toEqual([303, '/admin']);
    expect(r.text).not.toContain('root');
  });

  it('says "Not built yet" when the app has no build', async () => {
    rmSync(s.config.app, { recursive: true, force: true });
    const r = await s.call('/bills', undefined, a);
    expect(r.status).toBe(200);
    expect(r.text).toContain('Not built yet');
    expect(r.text).toContain('href="/admin"');
  });

  it('/bills/<no>/print: 303 to /admin without a session, the app for an admin', async () => {
    const r = await s.call('/bills/9000010/print');
    expect([r.status, r.headers.location]).toEqual([303, '/admin']);
    const ok = await s.call('/bills/9000010/print', undefined, a);
    expect([ok.status, ok.text]).toEqual([200, INDEX]);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect((await s.call('/bills/1/print?noprint=1', undefined, a)).status).toBe(200);
  });

  it('a mechanic is sent to /admin from the print page too', async () => {
    const m = await s.tech('Al Fixit');
    const r = await s.call('/bills/9000010/print', undefined, m);
    expect([r.status, r.headers.location]).toEqual([303, '/admin']);
  });

  it('a print path needs a 1 to 7 digit number, and exactly /print', async () => {
    const bad = [
      '/bills/abc/print',
      '/bills//print',
      '/bills/12345678/print',
      '/bills/9000010/print/',
      '/bills/9000010/Print',
      '/bills/9000010',
      '/bills/-1/print',
      '/bills/9000010/print/x',
    ];
    for (const p of bad) expect([p, (await s.call(p, undefined, a)).status]).toEqual([p, 404]);
  });

  it('only the exact paths', async () => {
    for (const p of ['/bills/', '/Bills', '/bills/x']) expect([p, (await s.call(p, undefined, a)).status]).toEqual([p, 404]);
  });
});

describe('/app/assets', () => {
  it('serves the built files with their types, cached for good', async () => {
    const cases: Array<[string, string, string]> = [
      ['index-abc123.js', 'text/javascript; charset=utf-8', 'console.log(1);'],
      ['index-abc123.css', 'text/css; charset=utf-8', 'body{margin:0}'],
      ['logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ['sub/deep.js', 'text/javascript; charset=utf-8', 'export {};'],
    ];
    for (const [name, type, text] of cases) {
      const r = await s.call(`/app/assets/${name}`);
      expect([name, r.status, r.headers['content-type'], r.text]).toEqual([name, 200, type, text]);
      expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('refuses anything outside the assets folder', async () => {
    const bad = [
      '/app/assets/../x',
      '/app/assets/../secret.txt',
      '/app/assets/../index.html',
      '/app/assets/../../../../outside.txt',
      '/app/assets/%2e%2e/secret.txt',
      '/app/assets/%2E%2E%2Fsecret.txt',
      '/app/assets/sub/..%2f..%2fsecret.txt',
      '/app/assets/..%5csecret.txt',
      '/app/assets/sub\\..\\..\\secret.txt',
      '/app/assets/%5c..%5csecret.txt',
      '/app/assets/C:%5cWindows%5cwin.ini',
      '/app/assets/%00.js',
      '/app/assets/%zz.js',
    ];
    for (const p of bad) {
      const r = await send(s.base, 'GET', p);
      expect([p, r.status]).toEqual([p, 404]);
      expect(r.text).not.toContain('not an asset');
      expect(r.text).not.toContain('outside');
    }
  });

  it('never lists a folder, and a missing file is 404', async () => {
    for (const p of ['/app/assets/', '/app/assets/sub', '/app/assets/sub/', '/app/assets/nope.js', '/app/assets'])
      expect([p, (await s.call(p)).status]).toEqual([p, 404]);
  });

  it('does not serve a file type it does not know', async () => {
    build({ 'assets/notes.exe': 'MZ' });
    expect((await s.call('/app/assets/notes.exe')).status).toBe(404);
  });
});

describe('/shop-logo', () => {
  const logo = (name: string, body: string): void => writeFileSync(join(s.config.root, name), body);

  it('404 when the shop has no logo', async () => {
    const r = await s.call('/shop-logo', undefined, a);
    expect([r.status, r.body]).toEqual([404, { error: 'not found' }]);
  });

  it('serves logo.png to an admin as image/png', async () => {
    logo('logo.png', 'PNGDATA1');
    const r = await s.call('/shop-logo', undefined, a);
    expect(r.status).toBe(200);
    expect(r.text).toBe('PNGDATA1');
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-cache');
  });

  it('logo.svg gets a no-script CSP', async () => {
    logo('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const r = await s.call('/shop-logo', undefined, a);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/svg+xml');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('not signed in or a mechanic: 303 to /admin', async () => {
    logo('logo.png', 'PNGDATA1');
    const r = await s.call('/shop-logo');
    expect([r.status, r.headers.location]).toEqual([303, '/admin']);
    const m = await s.tech('Al Fixit');
    const rm = await s.call('/shop-logo', undefined, m);
    expect([rm.status, rm.headers.location]).toEqual([303, '/admin']);
  });

  it('png wins over svg when both exist', async () => {
    logo('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    logo('logo.png', 'PNGDATA1');
    const r = await s.call('/shop-logo', undefined, a);
    expect([r.status, r.headers['content-type']]).toEqual([200, 'image/png']);
  });
});
