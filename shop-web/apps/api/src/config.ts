// Where the shop's files are and where the server listens (shop.py's constants).
import { existsSync, readFileSync } from 'node:fs';
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
  invomaxDir: string; // InvoMax's own folder: only ever read
  /** false when shop-settings.json has `"invomaxDir": null` (InvoMax retired): no import runs at all. */
  importInvomax: boolean;
  invomaxDb: string;
  importDir: string;
  backups: string;
  backupTargets: string[];
  app: string;
  /** true when shop-settings.json has `"ownBilling": true`: the app prints its own bills (default false). */
  ownBilling: boolean;
  /** The shop's details for the bill header (`"shop"` in shop-settings.json); all empty until set. */
  shopInfo: ShopInfo;
};

export type ShopInfo = { name: string; address: string[]; phone: string; hours: string };

/** Where InvoMax keeps its files on the shop PC unless shop-settings.json or INVOMAX_DIR says otherwise. */
export const DEFAULT_INVOMAX_DIR = String.raw`C:\hunni\files`;

type Settings = { invomaxDir: string | null; backupTargets: string[]; ownBilling: boolean; shopInfo: ShopInfo };

const isText = (x: unknown): x is string => typeof x === 'string';

/**
 * shop-settings.json: missing -> defaults; unreadable or the wrong shape -> defaults and one warning (the server
 * still starts). `"invomaxDir": null` turns the InvoMax import off.
 */
function settings(file: string): Settings {
  const defaults: Settings = {
    invomaxDir: DEFAULT_INVOMAX_DIR,
    backupTargets: [],
    ownBilling: false,
    shopInfo: { name: '', address: [], phone: '', hours: '' },
  };
  if (!existsSync(file)) return defaults;
  try {
    const j: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error('shape');
    const o = j as Record<string, unknown>;
    const dir = o['invomaxDir'];
    const targets = o['backupTargets'];
    if (dir !== undefined && dir !== null && (typeof dir !== 'string' || dir === '')) throw new Error('shape');
    if (targets !== undefined && (!Array.isArray(targets) || !targets.every((t) => typeof t === 'string'))) throw new Error('shape');
    const own = o['ownBilling'];
    if (own !== undefined && typeof own !== 'boolean') throw new Error('shape');
    const shop = o['shop'];
    let shopInfo = defaults.shopInfo;
    if (shop !== undefined) {
      if (shop === null || typeof shop !== 'object' || Array.isArray(shop)) throw new Error('shape');
      const s = shop as Record<string, unknown>;
      const { name, address, phone, hours } = s;
      if (!isText(name) || !isText(phone) || !isText(hours) || !Array.isArray(address) || !address.every(isText)) throw new Error('shape');
      shopInfo = { name, address: [...address], phone, hours };
    }
    return {
      invomaxDir: dir === undefined ? defaults.invomaxDir : dir,
      backupTargets: (targets as string[] | undefined) ?? [],
      ownBilling: own ?? false,
      shopInfo,
    };
  } catch {
    console.warn(
      'shop-settings.json is not valid (invomaxDir: text or null, backupTargets: list of text, ownBilling: true or false, ' +
        'shop: {name, address: list of text, phone, hours}); using the defaults.',
    );
    return defaults;
  }
}

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
  const set = settings(at('shop-settings.json'));
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
    // off (null): the default folder is named but never read, as importOnce refuses first
    invomaxDir: env['INVOMAX_DIR'] ? resolve(env['INVOMAX_DIR']) : resolve(root, set.invomaxDir ?? DEFAULT_INVOMAX_DIR),
    importInvomax: Boolean(env['INVOMAX_DIR']) || set.invomaxDir !== null,
    invomaxDb: at('invomax.db'),
    importDir: at('invomax-import'),
    backups: at('backups'),
    backupTargets: set.backupTargets,
    app: join(root, 'shop-web', 'apps', 'admin-app', 'dist'),
    ownBilling: set.ownBilling,
    shopInfo: set.shopInfo,
  };
}
