// The shared tickets.db: the tickets table exactly as tickets.Store creates it.
import { DatabaseSync } from 'node:sqlite';

/** Opens tickets.db, creating the tickets table and its status index if missing. Journal mode is left as is. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000'); // wait up to 5 s for another process's write lock, as Python's sqlite3
  db.exec('CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS tickets_status ON tickets (status)');
  return db;
}
