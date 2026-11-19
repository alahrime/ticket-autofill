// The listening server (shop.py serve() + pinweb.OnlyServer): one copy per port, stalled clients cut off.
import { createServer, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Accounts } from './accounts';
import { createApp } from './app';
import { className, logLine } from './http/log';
import type { Config } from './config';
import { openDb } from './db';
import { type PurgeOpts, startPurge } from './purge';
import { makeSetupCode } from './routes/auth';
import { TicketStore } from './store';

export const STALL_MS = 20_000; // a client may take this long to send a request; then it ends with no reply

/** stallMs: the stall limit (tests shorten it); log: where server errors after listening go (shop.log). */
export type ListenOpts = { stallMs?: number; log?: string };

/**
 * Listens on host:port alone (exclusive: a second copy fails with EADDRINUSE, as OnlyServer). A request
 * not fully received in stallMs is dropped without a reply; other malformed requests get Node's bare 400.
 * An error after listening (EMFILE, a failed accept) is logged as `error <Class>`; the server keeps serving.
 */
export function listen(app: RequestListener, where: { host: string; port: number }, opts: ListenOpts = {}): Promise<Server> {
  const stall = opts.stallMs ?? STALL_MS;
  const server = createServer(
    { requestTimeout: stall, headersTimeout: stall, connectionsCheckingInterval: Math.min(1000, Math.max(stall / 4, 50)) },
    app,
  );
  server.requestTimeout = stall;
  server.headersTimeout = stall;
  server.on('clientError', (err: NodeJS.ErrnoException, socket: Socket) => {
    if (err.code !== 'ERR_HTTP_REQUEST_TIMEOUT' && socket.writable && socket.bytesWritten === 0)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen({ host: where.host, port: where.port, exclusive: true }, () => {
      server.off('error', fail);
      server.on('error', (e) => {
        if (opts.log) logLine(opts.log, `error ${className(e)}`);
      });
      ok(server);
    });
  });
}

/**
 * Opens tickets.db and serves; the kiosk's old sessions go and, with no admin yet, a setup code is made. Deleted
 * tickets due for the purge go at start and every hour (opts.clock / opts.schedule: tests' own).
 */
export async function startServer(
  config: Config,
  opts: ListenOpts & PurgeOpts = {},
): Promise<{ port: number; close(): Promise<void> }> {
  const { clock, schedule, ...listenOpts } = opts;
  const db = openDb(config.db);
  let server: Server;
  let purge: { stop(): void };
  try {
    const store = new TicketStore(db);
    const accounts = new Accounts(db);
    server = await listen(createApp({ store, accounts, config }), config, { log: config.log, ...listenOpts });
    // straight after listening, before any request is read: a second copy that failed above changed nothing
    try {
      accounts.deleteKioskSessions();
      makeSetupCode(accounts, config.setup);
      purge = startPurge(store, config.log, { clock, schedule });
    } catch (e) {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      throw e;
    }
  } catch (e) {
    db.close();
    throw e;
  }
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : config.port,
    close: async () => {
      purge.stop();
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      db.close();
    },
  };
}
