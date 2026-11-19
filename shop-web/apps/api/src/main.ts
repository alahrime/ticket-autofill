// The shop server: no arguments -> serve on 127.0.0.1:8081; `admin <name>` -> make or reset an admin.
import { runAdminCommand, terminalIo } from './cli';
import { loadConfig } from './config';
import { startServer } from './server';

async function main(args: string[]): Promise<number | null> {
  const config = loadConfig();
  if (!args.length) {
    await startServer(config);
    console.log(
      `Serving on ${config.host}:${config.port}. No admin yet? Open /setup with the code in ${config.setup},` +
        ' or run: node shop-web/dist/apps/api/main.js admin <name>',
    );
    return null; // keeps running
  }
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
    console.error(err?.code === 'EADDRINUSE' ? 'The shop server is already running on this port.' : String(err?.message ?? e));
    process.exit(1);
  },
);
