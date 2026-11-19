// The guards every request goes through (pinweb.Web.reply / body, shop.py's cross_site, data, client, token,
// cookie): security headers, cross-site refusal, the body size limit, JSON bodies, the session cookie and
// the caller's address.
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { LIFETIME, type Session } from '../accounts';
import { BadInput, Gone } from '../errors';
import { depsOf } from './deps';
import { beforeHeaders } from './hooks';

export const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
export const MAX_BODY = 1024 * 1024;
const TOO_BIG = 'Request too big.';

/** no-store, nosniff, same-origin referrers on every reply; the CSP on HTML ones. */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin'); // our own forms keep a real Origin
  beforeHeaders(res, () => {
    if (String(res.getHeader('Content-Type') ?? '').startsWith('text/html')) res.setHeader('Content-Security-Policy', CSP);
    else res.removeHeader('Content-Security-Policy');
  });
  next();
};

const header = (h: IncomingHttpHeaders, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * True for a request another site's page made (a form or script there): the browser says so.
 * Sec-Fetch-Site wins when sent (with no-referrer, Chrome sends Origin: null on our own forms).
 */
export function crossSite(req: { headers: IncomingHttpHeaders }): boolean {
  const site = header(req.headers, 'sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = header(req.headers, 'origin');
  const host = header(req.headers, 'host') ?? '';
  return origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`;
}

/** 403 for a cross-site POST (or any other method that can change things), before any route runs. */
export const refuseCrossSite: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || !crossSite(req)) return next();
  res.status(403).json({ error: 'not allowed' });
};

/** A body said to be over 1 MB: 400 before reading any of it. */
export const refuseHugeBody: RequestHandler = (req, _res, next) => {
  next(Number(req.headers['content-length'] ?? 0) > MAX_BODY ? new BadInput(TOO_BIG) : undefined);
};

/** The whole body, at most max bytes (else BadInput); Gone when the client stops sending. */
export function readBody(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > max) return Promise.reject(new BadInput(TOO_BIG));
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onGone);
      req.off('close', onClose);
    };
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > max) {
        stop();
        req.pause();
        fail(new BadInput(TOO_BIG));
      } else chunks.push(c);
    };
    const onEnd = (): void => {
      stop();
      ok(Buffer.concat(chunks));
    };
    const onGone = (): void => {
      stop();
      fail(new Gone());
    };
    const onClose = (): void => {
      if (!req.complete) onGone();
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onGone);
    req.on('close', onClose);
  });
}

/** A urlencoded form body (Python's parse_qs: first value of each name, bad UTF-8 replaced). */
export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(new TextDecoder().decode(await readBody(req)));
}

/** req.body = the JSON object sent; 400 for another Content-Type (a form from another site can't send JSON). */
export const jsonBody: RequestHandler = async (req, _res, next) => {
  const type = (header(req.headers, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new BadInput('send JSON (Content-Type: application/json)');
  const raw = await readBody(req);
  let d: unknown = {};
  if (raw.length) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new BadInput('JSON must be UTF-8');
    }
    try {
      d = JSON.parse(text);
    } catch {
      throw new BadInput('not valid JSON');
    }
  }
  if (typeof d !== 'object' || d === null || Array.isArray(d)) throw new BadInput('expected a JSON object');
  req.body = d;
  next();
};

/** The sid cookie's value, or null (no cookie header, or no sid in it). */
export function sidOf(req: { headers: IncomingHttpHeaders }): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== 'sid') continue;
    const v = part.slice(eq + 1).trim();
    return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
  }
  return null;
}

/** The caller's live session, or null. */
export const sessionOf = (req: Request): Session | null => depsOf(req).accounts.session(sidOf(req));

/** Set-Cookie for a new session token (the role sets its lifetime), or one that clears sid (token null). */
export function sessionCookie(token: string | null, role: string | null, req: { headers: IncomingHttpHeaders }): string {
  const secure = header(req.headers, 'x-forwarded-proto') === 'https' ? '; Secure' : '';
  const age = token ? (LIFETIME[role ?? ''] ?? 0) : 0;
  return `sid=${token ?? ''}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict${secure}`;
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

const isLoopback = (ip: string): boolean => {
  const family = isIP(ip);
  return family !== 0 && LOOPBACK.check(ip, family === 4 ? 'ipv4' : 'ipv6');
};

/**
 * The caller's IP for the lockout: cloudflared (on this PC) passes it in CF-Connecting-IP, so that header
 * counts only when the socket peer is loopback. Never X-Forwarded-For, req.ip or trust proxy.
 */
export function clientIp(req: { headers: IncomingHttpHeaders; socket: { remoteAddress?: string } }): string {
  const peer = req.socket.remoteAddress ?? '';
  const cf = (header(req.headers, 'cf-connecting-ip') ?? '').trim();
  return isLoopback(peer) && cf ? cf : peer;
}
