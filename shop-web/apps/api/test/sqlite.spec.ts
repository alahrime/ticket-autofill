import { DatabaseSync } from 'node:sqlite';

describe('node:sqlite', () => {
  it('opens node:sqlite under jest', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    db.prepare('INSERT INTO t (x) VALUES (?)').run(1);
    const row = db.prepare('SELECT x FROM t').get() as { x: number };
    expect(row.x).toBe(1);
    db.close();
  });
});
