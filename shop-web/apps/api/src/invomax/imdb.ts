// invomax.db: the TS-only copy of InvoMax's bills (WAL). tickets.db is untouched. Money is integer cents.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS im_invoices (
  invoice_no TEXT PRIMARY KEY,
  "date" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  name TEXT NOT NULL,
  "first" TEXT NOT NULL,
  "last" TEXT NOT NULL,
  phone TEXT NOT NULL,
  plate TEXT NOT NULL,
  address TEXT NOT NULL,
  parts INTEGER NOT NULL,
  labor INTEGER NOT NULL,
  supplies INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  deposit INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  total INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  tax_rate REAL NOT NULL,
  hash TEXT NOT NULL,
  lines_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  gone_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS im_invoices_date ON im_invoices ("date");
CREATE INDEX IF NOT EXISTS im_invoices_plate ON im_invoices (plate);
CREATE INDEX IF NOT EXISTS im_invoices_phone ON im_invoices (phone);
CREATE INDEX IF NOT EXISTS im_invoices_name ON im_invoices (name);
CREATE TABLE IF NOT EXISTS im_lines (
  invoice_no TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  code TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL,
  qty REAL NOT NULL,
  unit INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  vehicle TEXT NOT NULL,
  year INTEGER,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  trim TEXT NOT NULL,
  PRIMARY KEY (invoice_no, line_no)
);
CREATE INDEX IF NOT EXISTS im_lines_code ON im_lines (code);
CREATE TABLE IF NOT EXISTS im_imports (
  id INTEGER PRIMARY KEY,
  started TEXT NOT NULL,
  finished TEXT NOT NULL,
  ok INTEGER NOT NULL,
  tries INTEGER NOT NULL,
  invoices INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  added INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  gone INTEGER NOT NULL,
  odd INTEGER NOT NULL DEFAULT 0,
  bad INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
`;

/** Opens invomax.db in WAL mode, creating the tables and indexes if missing. */
export function openImDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
