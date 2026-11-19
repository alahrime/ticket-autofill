// Pages, sign-in, sign-out and first-run setup (shop.py: get()'s page routes, login, signed_in, first_run).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { type Request, type RequestHandler, type Response, Router } from 'express';
import { Invalid } from '@shop/domain';
import { type Accounts, clientKey, Locked, LoginFailed, makeAdmin, type Role, type User } from '../accounts';
import { depsOf } from '../http/deps';
import { noteActor } from '../http/log';
import { CHOOSER, redirect, sendHtml, setupPage, signInPage, waitMessage, webPage } from '../http/pages';
import { clientIp, readForm, sessionCookie, sessionOf, sidOf } from '../http/security';

export const SETUP_LIFE = 86400; // a setup code lasts 24 h
export const SETUP_WINDOW = 600; // 5 wrong codes per client per 10 min
export const SETUP_TRIES = 5;
const HOME: Record<string, string> = { admin: '/admin', mechanic: '/tech' };
const PAGES = [
  ['/admin', 'admin', 'admin'],
  ['/tech', 'mechanic', 'tech'],
] as const; // page, the role it's served to, its web/ file

/** Python's s[:n] on code points. */
const first = (s: string, n: number): string => (s.length <= n ? s : Array.from(s).slice(0, n).join(''));

/** The first-run code in the setup file, or '' when missing or over 24 hours old. */
export function readSetupCode(path: string): string {
  try {
    if (Date.now() / 1000 - statSync(path).mtimeMs / 1000 > SETUP_LIFE) return '';
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/** At start: no active admin -> a fresh code in the setup file unless a live one is there; an admin -> no file. */
export function makeSetupCode(accounts: Accounts, path: string): void {
  if (accounts.list('admin', true).length) rmSync(path, { force: true });
  else if (!readSetupCode(path)) writeFileSync(path, `${randomBytes(9).toString('base64url')}\n`, 'utf8');
}

/** Timing-safe equality of two codes, whatever their lengths (as hmac.compare_digest). */
function sameCode(typed: string, code: string): boolean {
  const h = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(h(typed), h(code));
}

/** The caller's session, recorded for the log line. */
function signedIn(req: Request, res: Response) {
  const s = sessionOf(req);
  noteActor(res, s);
  return s;
}

/** 303 to `where` with a new session cookie, signing out whatever this device was before. */
function startSession(req: Request, res: Response, role: Role, token: string, where: string): void {
  depsOf(req).accounts.logout(sidOf(req));
  redirect(res, 303, where, { 'Set-Cookie': sessionCookie(token, role, req) });
}

const login =
  (role: Role): RequestHandler =>
  async (req, res) => {
    const f = await readForm(req);
    const name = first(f.get('name') ?? '', 80);
    let token: string;
    try {
      ({ token } = await depsOf(req).accounts.login(name, f.get('secret') ?? '', role, clientIp(req)));
    } catch (e) {
      if (e instanceof LoginFailed) {
        const msg = `${e.message.slice(0, 1).toUpperCase()}${e.message.slice(1)}.`;
        return sendHtml(res, 401, signInPage(role, msg, name));
      }
      if (e instanceof Locked)
        return sendHtml(res, 429, signInPage(role, waitMessage(e), name), { 'Retry-After': String(e.retryAfter) });
      throw e;
    }
    startSession(req, res, role, token, HOME[role] as string);
  };

/** The routes; the setup lockout and lock live in this router. */
export function authRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const setupFails = new Map<string, number[]>(); // wrong setup codes: client -> times
  let setupQueue: Promise<unknown> = Promise.resolve();
  /** One first run at a time, from the admin check to the admin made (makeAdmin awaits its hash). */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = setupQueue.then(fn, fn);
    setupQueue = run.catch(() => undefined);
    return run;
  };

  r.get('/', (_req, res) => sendHtml(res, 200, CHOOSER));
  r.get('/desk', (_req, res) => redirect(res, 302, '/admin'));
  r.get('/checkin', (_req, res) => redirect(res, 303, '/')); // the check-in kiosk is retired
  for (const [path, role, file] of PAGES) {
    r.get(path, async (req, res) => {
      const s = signedIn(req, res);
      sendHtml(res, 200, s?.role === role ? await webPage(depsOf(req).config.web, file) : signInPage(role));
    });
  }
  r.get('/api/me', (req, res) => {
    const s = signedIn(req, res);
    if (!s) return void res.status(401).json({ error: 'sign in' });
    res.json({ role: s.role, name: s.name, id: s.user_id });
  });
  r.get('/setup', (req, res) => {
    // only until there is an admin
    if (depsOf(req).accounts.list('admin', true).length) return void res.status(404).json({ error: 'not found' });
    sendHtml(res, 200, setupPage());
  });

  r.post('/login/admin', login('admin'));
  r.post('/login/tech', login('mechanic'));
  r.post('/logout', (req, res) => {
    const { accounts } = depsOf(req);
    const token = sidOf(req);
    const s = accounts.session(token);
    accounts.logout(token);
    redirect(res, 303, HOME[s?.role ?? ''] ?? '/', { 'Set-Cookie': sessionCookie(null, null, req) });
  });

  // First run, no admin yet: the one-time code in setup_code.txt makes the admin and signs them in.
  r.post('/setup', async (req, res) => {
    const f = await readForm(req); // read before the lock
    const name = first(f.get('name') ?? '', 80);
    const password = f.get('password') ?? '';
    const { accounts, config } = depsOf(req);
    const made = await serial(async (): Promise<User | null> => {
      if (accounts.list('admin', true).length) {
        res.status(404).json({ error: 'not found' });
        return null;
      }
      const t = Date.now() / 1000;
      const key = clientKey(clientIp(req));
      for (const [k, v] of setupFails) if (!v.length || t - (v[v.length - 1] as number) >= SETUP_WINDOW) setupFails.delete(k);
      const tries = (setupFails.get(key) ?? []).filter((x) => t - x < SETUP_WINDOW);
      setupFails.set(key, tries);
      if (tries.length >= SETUP_TRIES) {
        const e = new Locked((tries[tries.length - SETUP_TRIES] as number) + SETUP_WINDOW - t);
        sendHtml(res, 429, setupPage(waitMessage(e), name), { 'Retry-After': String(e.retryAfter) });
        return null;
      }
      const code = readSetupCode(config.setup);
      if (!code || !sameCode((f.get('code') ?? '').trim(), code)) {
        tries.push(t);
        sendHtml(res, 401, setupPage('Wrong or expired setup code.', name));
        return null;
      }
      if (password !== (f.get('again') ?? '')) {
        sendHtml(res, 400, setupPage("The passwords don't match.", name));
        return null;
      }
      let user: User;
      try {
        user = await makeAdmin(accounts, name, password);
      } catch (e) {
        if (!(e instanceof Invalid)) throw e;
        sendHtml(res, 400, setupPage(Object.values(e.errors).join(' '), name));
        return null;
      }
      try {
        rmSync(config.setup, { force: true });
      } catch {
        // used up anyway: there is an admin now
      }
      return user;
    });
    if (!made) return;
    let token: string;
    try {
      ({ token } = await accounts.login(made.name, password, 'admin', clientIp(req)));
    } catch (e) {
      if (e instanceof Locked || e instanceof LoginFailed) return redirect(res, 303, '/admin'); // just sign in on /admin
      throw e;
    }
    startSession(req, res, 'admin', token, '/admin');
  });
  return r;
}
