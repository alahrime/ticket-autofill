// The 14-day purge of deleted tickets: once at start, then every hour while the server runs.
import { className, logLine } from './http/log';
import type { TicketStore } from './store';

export const PURGE_EVERY_MS = 3_600_000;

/** Runs `run` every `ms` until stop(); tests pass their own to tick by hand. */
export type Schedule = (run: () => void, ms: number) => { stop(): void };

/** setInterval, not holding the process open. */
export const every: Schedule = (run, ms) => {
  const h = setInterval(run, ms);
  h.unref();
  return { stop: () => clearInterval(h) };
};

export type PurgeOpts = { clock?: () => Date; schedule?: Schedule };

/**
 * One purge: logs `purged N` when it removed any, and nothing about the tickets. A failure (a locked database,
 * a bad clock) is logged as `purge error <Class>` and never thrown: the next hour tries again.
 */
export function purgeOnce(store: TicketStore, log: string, clock: () => Date = () => new Date()): void {
  try {
    const n = store.purge(clock());
    if (n) logLine(log, `purged ${n}`);
  } catch (e) {
    logLine(log, `purge error ${className(e)}`);
  }
}

/** Purges now and every PURGE_EVERY_MS; stop() ends the timer (the server's close). */
export function startPurge(store: TicketStore, log: string, opts: PurgeOpts = {}): { stop(): void } {
  const run = (): void => purgeOnce(store, log, opts.clock);
  run();
  return (opts.schedule ?? every)(run, PURGE_EVERY_MS);
}
