// `admin <name>`: makes or resets an admin from the shop PC's command line (shop.py main()).
import { createInterface } from 'node:readline';
import { Invalid } from '@shop/domain';
import { Accounts, makeAdmin } from './accounts';
import { backupFolder, copyBackups, isDrive, restoreBackup } from './backup';
import type { Config } from './config';
import { openDb } from './db';
import { BadInput } from './errors';
import { importOnce, type ImportOpts } from './invomax/import';

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
    io.out('usage: node shop-web/apps/api/dist/main.js [admin <name> | import-invomax]');
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

/** `import-invomax`: copies and imports InvoMax's bills now; prints the counts (or the error) -> exit code. */
export async function runImportCommand(
  config: Config,
  out: (s: string) => void,
  sleep?: ImportOpts['sleep'],
): Promise<number> {
  const r = await importOnce(config, sleep ? { sleep } : {});
  if (!r.ok) {
    out(`Import failed after ${r.tries} ${r.tries === 1 ? 'try' : 'tries'}: ${r.error}`);
    return 1;
  }
  out(
    `Imported ${r.invoices} invoices and ${r.lines} lines: ${r.added} new, ${r.changed} changed, ${r.gone} gone ` +
      `(${r.tries} ${r.tries === 1 ? 'try' : 'tries'}).`,
  );
  return 0;
}

/** `restore <file>`: puts a backup in place of the live db (the server must be stopped) -> exit code. */
export async function runRestoreCommand(config: Config, file: string, out: (s: string) => void): Promise<number> {
  try {
    const aside = await restoreBackup(file, config);
    out(`Restored. ${aside ? `The old file is kept as ${aside}.` : 'There was no old file.'}`);
    return 0;
  } catch (e) {
    out(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** `copy-backups <drive>`: copies the backups to <drive>\shop-backups -> exit code. */
export async function runCopyBackupsCommand(
  config: Config,
  drive: string,
  out: (s: string) => void,
  now = new Date(),
): Promise<number> {
  try {
    if (!isDrive(drive)) throw new BadInput('give a drive letter, like D:');
    const target = backupFolder(drive);
    const r = await copyBackups(config.backups, target, now);
    out(`Copied ${r.copied} backup${r.copied === 1 ? '' : 's'} to ${target} (${r.skipped} already there).`);
    return 0;
  } catch (e) {
    if (!(e instanceof BadInput)) throw e;
    out(`Nothing copied: ${e.message}`);
    return 1;
  }
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
