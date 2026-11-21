// The shop server: no arguments -> serve on 127.0.0.1:8081; `admin <name>` -> make or reset an admin;
// `import-invomax` -> copy InvoMax's bills into invomax.db.
// Exit codes while serving (shop-web/tools/run-shop.cmd reads them): 1 = stopped by an error, restart it;
// 3 = the port is already taken (another copy is serving), don't.
import { runAdminCommand, runImportCommand, terminalIo } from './cli';
import { loadConfig } from './config';
import { crashExit, logLine, processGuard } from './http/log';
import { startServer } from './server';

const EXIT_PORT_IN_USE = 3;

async function main(args: string[]): Promise<number | null> {
  const config = loadConfig();
  if (!args.length) {
    const server = await startServer(config);
    // serving (R13): an uncaught error is logged (class name only) and the process exits for a clean restart;
    // a stray rejected promise is only logged
    process.on('uncaughtException', crashExit(config.log));
    process.on('unhandledRejection', processGuard(config.log));
    logLine(config.log, `started ${config.host}:${server.port}`);
    console.log(
      `Serving on ${config.host}:${server.port}. No admin yet? Open /setup with the code in ${config.setup},` +
        ' or run: node shop-web/apps/api/dist/main.js admin <name>',
    );
    return null; // keeps running
  }
  if (args.length === 1 && args[0] === 'import-invomax') return runImportCommand(config, console.log);
  try {
    return await runAdminCommand(args, terminalIo(), config.db);
  } catch (e) {
    if (e instanceof Error && e.message === 'cancelled') {
      console.log('Cancelled; nothing changed.');
      return 1;
    }
    throw e;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== null) process.exit(code);
  },
  (e: unknown) => {
    // the shop PC's own console: the reason, never a stack
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'EADDRINUSE') {
      console.error('The shop server is already running on this port.');
      process.exit(EXIT_PORT_IN_USE);
    }
    console.error(String(err?.message ?? e));
    process.exit(1);
  },
);
