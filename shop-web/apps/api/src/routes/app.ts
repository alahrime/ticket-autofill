// The React admin app (shop-web/apps/admin-app, built into config.app): its pages /bills, /jobs and the bill
// print page /bills/<no>/print for a signed-in admin, and its built files under /app/assets/. Nothing outside
// config.app/assets is ever served, folders are never listed, and an unknown file type is 404.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { type Request, type RequestHandler, type Response, Router } from 'express';
import { depsOf } from '../http/deps';
import { noteActor } from '../http/log';
import { page, redirect, sendHtml } from '../http/pages';
import { sessionOf } from '../http/security';

export const APP_PAGES = ['/bills', '/jobs', /^\/bills\/\d{1,7}\/print$/] as const;
const ASSETS = '/app/assets/';
export const ASSET_CACHE = 'public, max-age=31536000, immutable';

/** The types Vite's build writes (and nothing else is served). */
export const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const NOT_BUILT = page(
  'Not built yet',
  '<p>The admin app isn\'t built yet: <code>cd shop-web &amp;&amp; npx nx build admin-app</code>.</p><p><a href="/admin">Back to tickets</a></p>',
);

const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

/**
 * The file under `dir` that URL path `raw` (still percent-encoded, after /app/assets/) names, or null for anything
 * that could step outside it: `..` (plain or encoded), backslashes, NUL, a drive or an absolute path, bad escapes.
 */
export function assetPath(dir: string, raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!name || /[\\\0:]/.test(name) || name.startsWith('/')) return null;
  const parts = name.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  const file = resolve(dir, ...parts);
  return inside(file, resolve(dir)) ? file : null;
}

const notFound = (res: Response): void => void res.status(404).json({ error: 'not found' });

/** A file in config.app/assets: its own type, cached for good (the build names each by its hash). */
const asset: RequestHandler = async (req: Request, res: Response) => {
  const dir = join(depsOf(req).config.app, 'assets');
  const file = assetPath(dir, req.path.slice(ASSETS.length));
  const type = file ? ASSET_TYPES[extname(file).toLowerCase()] : undefined;
  if (!file || !type) return notFound(res);
  let body: Buffer;
  try {
    // the real path too: a link inside assets/ pointing out of it is refused like `..`
    const [real, realDir] = await Promise.all([realpath(file), realpath(dir)]);
    if (!inside(real, realDir) || !(await stat(real)).isFile()) return notFound(res);
    body = await readFile(real);
  } catch {
    return notFound(res); // missing (or gone meanwhile)
  }
  res.status(200).set({ 'Content-Type': type, 'Cache-Control': ASSET_CACHE }).send(body);
};

/** /bills, /jobs and /bills/<no>/print: the app's index.html, read fresh, to an admin; anyone else goes to /admin (its sign-in). */
const appPage: RequestHandler = async (req, res) => {
  const s = sessionOf(req);
  noteActor(res, s);
  if (s?.role !== 'admin') return redirect(res, 303, '/admin');
  let html: Buffer | string;
  try {
    html = await readFile(join(depsOf(req).config.app, 'index.html'));
  } catch {
    html = NOT_BUILT;
  }
  sendHtml(res, 200, html);
};

/** The shop's optional logo in the shop root, first found wins. */
const LOGOS: ReadonlyArray<[string, string]> = [
  ['logo.png', 'image/png'],
  ['logo.jpg', 'image/jpeg'],
  ['logo.jpeg', 'image/jpeg'],
  ['logo.svg', 'image/svg+xml'],
];

/** /shop-logo: the logo for the bill's print page, to an admin; 404 when the shop has none. An SVG never runs script. */
const shopLogo: RequestHandler = async (req, res) => {
  const s = sessionOf(req);
  noteActor(res, s);
  if (s?.role !== 'admin') return redirect(res, 303, '/admin');
  for (const [name, type] of LOGOS) {
    let body: Buffer;
    try {
      body = await readFile(join(depsOf(req).config.root, name));
    } catch {
      continue; // not there (or unreadable): try the next
    }
    // nosniff comes from securityHeaders, and so does an SVG's no-script CSP (it strips any other on non-HTML)
    res.set({ 'Content-Type': type, 'Cache-Control': 'no-cache' });
    return void res.status(200).send(body);
  }
  notFound(res);
};

export function appRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  r.get('/shop-logo', shopLogo);
  for (const p of APP_PAGES) r.get(p, appPage);
  r.get(/^\/app\/assets\/./, asset);
  return r;
}
