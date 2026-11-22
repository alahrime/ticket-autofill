// Job mapping rules: which parts.csv job (or 'ignore') an InvoMax bill line is, by its code and the words of its
// description. Accepted rules live in tickets.db's job_map (made here, if missing; Python never touches it).
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '@shop/domain';
import { GENERIC_CODES } from '@shop/invomax';
import { BadInput } from '../errors';

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
/** Matching costs line pairs x rules, on the event loop: a new rule past either cap is refused. */
export const MAX_RULES = 2000;
export const MAX_RULES_PER_CODE = 300;
const RULE_WORD = /^[A-Z0-9]*[A-Z][A-Z0-9]*$/;

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
 * A rule's words as sent: each upper-case letters and digits with at least one letter, so normalising keeps
 * every one (a digit-only word would vanish and leave a catch-all rule); a generic code's rule needs one. Else
 * BadInput.
 */
export function checkWords(imCode: string, words: string[]): string[] {
  const sent = new Set(words);
  const kept = ruleWords(words);
  if (!words.every((w) => RULE_WORD.test(w)) || kept.length !== sent.size || !kept.every((w) => sent.has(w)))
    throw new BadInput('each word must be upper-case letters and digits, with a letter');
  if (GENERIC_CODES.includes(imCode) && !kept.length) throw new BadInput('a LABOR or INSTALL- rule needs words');
  return kept;
}

/** A rule with its word set worked out once. */
export type Prepared = { rule: Rule; words: Set<string> };

/** Rules by code, each with its word set (for matching many lines). */
export function prepareRules(rules: Rule[]): Map<string, Prepared[]> {
  const byCode = new Map<string, Prepared[]>();
  for (const rule of rules) {
    let list = byCode.get(rule.im_code);
    if (!list) {
      list = [];
      byCode.set(rule.im_code, list);
    }
    list.push({ rule, words: new Set(rule.words) });
  }
  return byCode;
}

/** matchRule over prepared rules of the line's code: `have` is the line's word set. */
export function matchPrepared(have: Set<string>, rules: Prepared[]): Rule | null {
  let best: Rule | null = null;
  let bestSize = -1;
  for (const { rule: r, words: w } of rules) {
    if (w.size < bestSize) continue;
    let all = true;
    for (const x of w)
      if (!have.has(x)) {
        all = false;
        break;
      }
    if (!all) continue;
    const newer = best !== null && (r.made_at > best.made_at || (r.made_at === best.made_at && r.id > best.id));
    if (w.size > bestSize || newer) {
      best = r;
      bestSize = w.size;
    }
  }
  return best;
}

/**
 * The rule for a line: same code, every rule word among the line's (as a set); the most words wins, a tie
 * the newer made_at (then the higher id). An empty-words rule matches any line with that code.
 */
export function matchRule(line: { code: string; words: string[] }, rules: Rule[]): Rule | null {
  return matchPrepared(new Set(line.words), prepareRules(rules).get(line.code) ?? []);
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

  /**
   * Adds the rule, or replaces the one with the same code and words (always allowed). A new rule past
   * MAX_RULES, or MAX_RULES_PER_CODE for its code, is BadInput('too many rules').
   */
  put(r: { im_code: string; words: string[]; job: string }, by: string, now: Date = new Date()): Rule {
    const words = ruleWords(r.words).join(' ');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.upsert(r.im_code, words, r.job, by, now);
      this.db.exec('COMMIT');
      this.changes++;
      return toRule(row);
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private upsert(imCode: string, words: string, job: string, by: string, now: Date): Row {
    const stored = this.db.prepare('SELECT 1 AS ok FROM job_map WHERE im_code = ? AND words = ?').get(imCode, words);
    if (!stored) {
      const n = this.db
        .prepare('SELECT COUNT(*) AS n, SUM(im_code = ?) AS code FROM job_map')
        .get(imCode) as { n: number; code: number | null };
      if (n.n >= MAX_RULES || (n.code ?? 0) >= MAX_RULES_PER_CODE) throw new BadInput('too many rules');
    }
    return this.db
      .prepare(
        `INSERT INTO job_map (im_code, words, job, made_by, made_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (im_code, words) DO UPDATE SET job = excluded.job, made_by = excluded.made_by, made_at = excluded.made_at
         RETURNING id, im_code, words, job, made_by, made_at`,
      )
      .get(imCode, words, job, by, nowIso(now)) as Row;
  }

  /** Drops the rule with this code and words; false when there was none. */
  remove(imCode: string, words: string[]): boolean {
    const n = this.db.prepare('DELETE FROM job_map WHERE im_code = ? AND words = ?').run(imCode, ruleWords(words).join(' ')).changes;
    this.changes++;
    return Number(n) > 0;
  }
}
