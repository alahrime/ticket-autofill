// The Express app (shop.py's Handler without the socket): guards, routes, the 401/404 fallback and the error
// mapping. Nothing here listens; server.ts does.
import express, { type ErrorRequestHandler, type Express, type Request, type Response } from 'express';
import { Invalid, Refused, Stale } from '@shop/domain';
import { Locked, LoginFailed } from './accounts';
import type { Config } from './config';
import { BadInput, Gone, NotFound } from './errors';
import type { Deps } from './http/deps';
import { className, requestLog, writeLog } from './http/log';
import { refuseCrossSite, refuseHugeBody, securityHeaders, sessionOf } from './http/security';
import { authRoutes } from './routes/auth';
import { catalogRoutes } from './routes/catalog';
import { ticketRoutes } from './routes/tickets';

type Mapped = { status: number; body: Record<string, unknown>; headers?: Record<string, string> } | 'drop';

const statusOf = (e: object): unknown => (e as { status?: unknown }).status;

/** A known error -> its reply; null for anything else (a 500 that says nothing). */
function mapError(e: unknown): Mapped | null {
  if (e instanceof Gone) return 'drop';
  if (e instanceof Invalid) return { status: 400, body: { error: e.message, errors: e.errors } };
  if (e instanceof BadInput) return { status: 400, body: { error: e.message } };
  if (e instanceof LoginFailed) return { status: 401, body: { error: e.message } };
  if (e instanceof Locked)
    return { status: 429, body: { error: e.message }, headers: { 'Retry-After': String(e.retryAfter) } };
  if (e instanceof NotFound) return { status: 404, body: { error: 'not found' } };
  if (e instanceof Stale || e instanceof Refused) return { status: 409, body: { error: e.message } };
  // body-parser / Express client errors (http-errors: a 4xx status and a type): Python's 400s, never their text
  if (e && typeof e === 'object') {
    const status = statusOf(e);
    const type = (e as { type?: unknown }).type;
    if (type === 'request.aborted') return 'drop';
    if (typeof status === 'number' && status >= 400 && status < 500)
      return { status: 400, body: { error: status === 413 ? 'Request too big.' : 'bad request' } };
  }
  return null;
}


/** Error mapping (shop.py run() + pinweb Web.run()): never echoes internals, never crashes the process. */
export function errorHandler(config: Config): ErrorRequestHandler {
  // four parameters: that is how Express tells an error handler apart
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next) => {
    try {
      const mapped = mapError(err);
      if (mapped === 'drop' || res.headersSent || req.socket.destroyed) {
        req.socket.destroy(); // the client left, or the reply had begun: nothing sane to add
        return;
      }
      if (!req.complete) res.setHeader('Connection', 'close'); // don't wait for a body nobody will read
      if (!mapped) {
        writeLog(config.log, req, res, `error ${className(err)}`);
        res.status(500).json({ error: 'server error' });
        return;
      }
      res.status(mapped.status).set(mapped.headers ?? {}).json(mapped.body);
    } catch {
      req.socket.destroy();
    }
  };
}

export function createApp(deps: Deps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false); // the ticket list makes its own
  app.set('env', 'production'); // Express's last-resort handler never shows a stack
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  app.locals['deps'] = deps;

  app.use(requestLog(deps.config.log));
  app.use(securityHeaders);
  app.use(refuseCrossSite);
  app.use(refuseHugeBody);
  app.use(authRoutes());
  app.use(ticketRoutes());
  app.use(catalogRoutes());
  app.use((req, res) => {
    // as shop.py: an /api/ GET or any POST needs a session first; then nothing here is 404
    if ((req.path.startsWith('/api/') || req.method === 'POST') && !sessionOf(req))
      return void res.status(401).json({ error: 'sign in' });
    res.status(404).json({ error: 'not found' });
  });
  app.use(errorHandler(deps.config));
  return app;
}
