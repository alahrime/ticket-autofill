// A callback just before a response's status line and headers go out (what the on-headers package does).
import type { ServerResponse } from 'node:http';

/** fn(status) runs once, right before the headers are written, while they can still change. */
export function beforeHeaders(res: ServerResponse, fn: (status: number) => void): void {
  const writeHead = res.writeHead;
  let done = false;
  res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    if (!done) {
      done = true;
      fn(typeof args[0] === 'number' ? args[0] : res.statusCode);
    }
    return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as typeof res.writeHead;
}
