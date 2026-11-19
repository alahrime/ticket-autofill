// `admin <name>`: makes or resets an admin from the shop PC's command line (shop.py main()).
import { createInterface } from 'node:readline';
import { Invalid } from '@shop/domain';
import { Accounts, makeAdmin } from './accounts';
import { openDb } from './db';

export type CliIo = {
  prompt(q: string, hidden: boolean): Promise<string>;
  out(s: string): void;
};

/** Runs `admin <name>` on the tickets.db at dbPath (loadConfig().db) -> exit code. Never echoes the password. */
export async function runAdminCommand(
  args: string[],
  io: CliIo,
  dbPath: string,
): Promise<number> {
  if (args.length !== 2 || args[0] !== 'admin') {
    io.out('usage: node shop-web/dist/apps/api/main.js [admin <name>]');
    return 1;
  }
  const password = await io.prompt('New password (10+ characters): ', true);
  if (password !== (await io.prompt('Same password again: ', true))) {
    io.out("The passwords don't match; nothing changed.");
    return 1;
  }
  const db = openDb(dbPath);
  let name: string;
  try {
    name = (await makeAdmin(new Accounts(db), args[1], password)).name;
  } catch (e) {
    if (!(e instanceof Invalid)) throw e;
    io.out(Object.values(e.errors).join('; '));
    return 1;
  } finally {
    db.close();
  }
  io.out(
    `Admin ${name} is ready; sign in at /admin. A running server keeps its lockout until start-shop.bat restarts it.`,
  );
  return 0;
}

/** Prompts on the terminal; a hidden prompt shows nothing of what is typed (like Python's getpass). */
export function terminalIo(): CliIo {
  // Piped input (not a terminal): one reader for every prompt, so lines that arrive together aren't lost.
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let ended = false;
  let rl: ReturnType<typeof createInterface> | undefined;
  const nextLine = (): Promise<string> => {
    if (!rl) {
      rl = createInterface({ input: process.stdin, terminal: false });
      rl.on('line', (line) => {
        const wake = waiting.shift();
        if (wake) wake(line);
        else lines.push(line);
      });
      rl.on('close', () => {
        ended = true;
        for (const wake of waiting.splice(0)) wake('');
      });
    }
    const line = lines.shift();
    if (line !== undefined || ended) return Promise.resolve(line ?? '');
    return new Promise((ok) => waiting.push(ok));
  };
  return {
    out: (s) => console.log(s),
    prompt: async (q, hidden) => {
      const stdin = process.stdin;
      if (!hidden || !stdin.isTTY) {
        if (hidden) process.stderr.write('Warning: password input may be shown.\n'); // as Python's GetPassWarning
        process.stdout.write(q);
        return nextLine(); // the caller exits the process when done (stdin stays open)
      }
      process.stdout.write(q);
      return new Promise((ok, fail) => {
        let typed = '';
        stdin.setRawMode(true);
        stdin.setEncoding('utf8');
        stdin.resume();
        const done = (): void => {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
        };
        const onData = (chunk: string): void => {
          for (const c of chunk) {
            if (c === '\r' || c === '\n' || c === '\u0003') {
              done();
              if (c === '\u0003') fail(new Error('cancelled'));
              else ok(typed);
              return;
            }
            if (c === '\u007f' || c === '\b')
              typed = [...typed].slice(0, -1).join('');
            else if (c >= ' ') typed += c;
          }
        };
        stdin.on('data', onData);
      });
    },
  };
}
