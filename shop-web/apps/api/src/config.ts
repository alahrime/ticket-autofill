// Where the shop's files are and where the server listens (shop.py's constants).
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type Config = {
  host: string;
  port: number;
  root: string;
  db: string;
  catalog: string;
  vehicles: string;
  web: string;
  setup: string;
  log: string;
};

export const HOST = '127.0.0.1'; // this PC only: phones and the iPad come in through the Cloudflare tunnel
export const PORT = 8081;

/** SHOP_ROOT, else the nearest folder above this file holding shop.py (the repo root). */
function shopRoot(env: NodeJS.ProcessEnv): string {
  if (env['SHOP_ROOT']) return resolve(env['SHOP_ROOT']);
  for (let d = resolve(__dirname); ; d = dirname(d)) {
    if (existsSync(join(d, 'shop.py'))) return d;
    if (dirname(d) === d) break;
  }
  throw new Error('shop.py not found; set SHOP_ROOT to the folder holding tickets.db');
}

function port(text: string | undefined): number {
  if (text === undefined || text === '') return PORT;
  const n = Number(text);
  if (!/^[0-9]{1,5}$/.test(text) || n > 65535) throw new Error(`SHOP_PORT must be a port number, not ${JSON.stringify(text)}`);
  return n;
}

/** The files in the repo root (tickets.db, parts.csv, vehicles.json, web/, setup_code.txt, shop.log). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = shopRoot(env);
  const at = (name: string): string => join(root, name);
  return {
    host: HOST,
    port: port(env['SHOP_PORT']),
    root,
    db: at('tickets.db'),
    catalog: at('parts.csv'),
    vehicles: at('vehicles.json'),
    web: at('web'),
    setup: at('setup_code.txt'),
    log: at('shop.log'),
  };
}
