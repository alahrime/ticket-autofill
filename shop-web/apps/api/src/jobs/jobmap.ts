// Job mapping rules: which parts.csv job (or 'ignore') an InvoMax bill line is, by its code and the words of its
// description. Accepted rules live in tickets.db's job_map (made here, if missing; Python never touches it).
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '@shop/domain';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_map (
  id INTEGER PRIMARY KEY,
  im_code TEXT NOT NULL,
  words TEXT NOT NULL DEFAULT '',
  job TEXT NOT NULL,
  made_by TEXT NOT NULL,
  made_at TEXT NOT NULL,
  UNIQUE (im_code, words)
);
`;

export const IGNORE = 'ignore';

export type Rule = { id: number; im_code: string; words: string[]; job: string; made_by: string; made_at: string };

/** Upper-cased, non-alphanumerics as spaces, split; tokens that are only digits dropped. */
export function normalDesc(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t !== '' && !/^\d+$/.test(t));
}

/** A rule's words as stored and compared: normalised, each once, sorted. */
export const ruleWords = (words: string[]): string[] => [...new Set(normalDesc(words.join(' ')))].sort();

/**
 * The rule for a line: same code, every rule word among the line's (as a set); the most words wins, a tie
 * the newer made_at (then the higher id). An empty-words rule matches any line with that code.
 */
export function matchRule(line: { code: string; words: string[] }, rules: Rule[]): Rule | null {
  let best: Rule | null = null;
  let bestSize = -1;
  const have = new Set(line.words);
  for (const r of rules) {
    if (r.im_code !== line.code) continue;
    const w = new Set(r.words);
    if (![...w].every((x) => have.has(x))) continue;
    const newer = best !== null && (r.made_at > best.made_at || (r.made_at === best.made_at && r.id > best.id));
    if (w.size > bestSize || (w.size === bestSize && newer)) {
      best = r;
      bestSize = w.size;
    }
  }
  return best;
}

type Row = Omit<Rule, 'words'> & { words: string };
const toRule = (r: Row): Rule => ({ ...r, words: r.words ? r.words.split(' ') : [] });

/** job_map in tickets.db. `changes` counts this process's writes (the index's version key uses it). */
export class JobMap {
  changes = 0;

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(SCHEMA);
  }

  rules(): Rule[] {
    return (this.db.prepare('SELECT id, im_code, words, job, made_by, made_at FROM job_map ORDER BY id').all() as Row[]).map(toRule);
  }

  /** Rule count and newest made_at: one cheap query, for the index's version key. */
  version(): string {
    const r = this.db.prepare('SELECT COUNT(*) AS n, MAX(made_at) AS at FROM job_map').get() as { n: number; at: string | null };
    return `${r.n}|${r.at ?? ''}|${this.changes}`;
  }

  /** Adds the rule, or replaces the one with the same code and words. */
  put(r: { im_code: string; words: string[]; job: string }, by: string, now: Date = new Date()): Rule {
    const words = ruleWords(r.words).join(' ');
    const row = this.db
      .prepare(
        `INSERT INTO job_map (im_code, words, job, made_by, made_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (im_code, words) DO UPDATE SET job = excluded.job, made_by = excluded.made_by, made_at = excluded.made_at
         RETURNING id, im_code, words, job, made_by, made_at`,
      )
      .get(r.im_code, words, r.job, by, nowIso(now)) as Row;
    this.changes++;
    return toRule(row);
  }

  /** Drops the rule with this code and words; false when there was none. */
  remove(imCode: string, words: string[]): boolean {
    const n = this.db.prepare('DELETE FROM job_map WHERE im_code = ? AND words = ?').run(imCode, ruleWords(words).join(' ')).changes;
    this.changes++;
    return Number(n) > 0;
  }
}
