// shop.log: one line per request, no customer data (pinweb.Web.log): time, method, path without the query,
// status (or "dropped" / "error <Class>"), who asked (role#user id), seconds.
import { appendFileSync } from 'node:fs';
import type { Request, RequestHandler, Response } from 'express';
import type { Session } from '../accounts';
import { beforeHeaders } from './hooks';

const pad = (n: number): string => String(n).padStart(2, '0');
const stamp = (d = new Date()): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** The thrown value's class name for the log, and nothing else of it. */
export function className(e: unknown): string {
  const name = e !== null && typeof e === 'object' ? ((e.constructor as { name?: string } | undefined)?.name ?? 'Object') : typeof e;
  return String(name).replace(/[^\w$.]/g, '').slice(0, 60) || 'unknown';
}

/** A line about no request in particular (a server or process error). Never throws. */
export function logLine(path: string, what: string): void {
  try {
    appendFileSync(path, `${stamp()} ${what}\n`, 'utf8');
  } catch {
    // nothing to tell
  }
}

/**
 * For process.on('unhandledRejection') while serving: logs `error <Class>` and lets the server keep going, as
 * Python's threaded server outlives one handler's crash. Never throws.
 */
export function processGuard(path: string): (e: unknown) => void {
  return (e) => logLine(path, `error ${className(e)}`);
}

/**
 * For process.on('uncaughtException') while serving (ruling R13): logs `error <Class>` (synchronously), then
 * exits 1, so run-shop.cmd starts a clean copy instead of serving on with state half-updated.
 */
export function crashExit(path: string, exit: (code: number) => void = (code) => process.exit(code)): (e: unknown) => void {
  return (e) => {
    logLine(path, `error ${className(e)}`);
    exit(1);
  };
}

/** Records the signed-in caller for this request's log line. */
export function noteActor(res: Response, s: Session | null): void {
  if (s) res.locals['actor'] = `${s.role}#${s.user_id}`;
}

/** Appends one line; a log that can't be written never fails the request. */
export function writeLog(path: string, req: Request, res: Response, what: string): void {
  const started = (res.locals['started'] as number | undefined) ?? Date.now();
  const actor = res.locals['actor'] as string | undefined;
  const url = (req.originalUrl || req.url).split(/[?#]/)[0];
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  try {
    appendFileSync(path, `${stamp()} ${req.method} ${url} ${what}${actor ? ` ${actor}` : ''} ${secs}s\n`, 'utf8');
  } catch {
    // pythonw has no console either: nothing to tell
  }
}

/** Logs each request when its headers go out, or "dropped" when the connection ends first. */
export function requestLog(path: string): RequestHandler {
  return (req, res, next) => {
    res.locals['started'] = Date.now();
    let logged = false;
    beforeHeaders(res, (status) => {
      logged = true;
      writeLog(path, req, res, String(status));
    });
    res.on('close', () => {
      if (!logged) writeLog(path, req, res, 'dropped');
    });
    next();
  };
}
