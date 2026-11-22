// A proposed rule for a group of InvoMax lines: the parts.csv job its code or description words name, by whole
// tokens only (no fuzzy matching). Only accepted rules are stored; proposals are worked out on each request.
import { GENERIC_CODES } from '@shop/invomax';
import type { Part } from '../routes/catalog';
import { normalDesc } from './jobmap';

export type Proposal = { job: string; words: string[] };

/** A part's phrases as token sets: its code, its description, each alias. */
function phrases(p: Part): Set<string>[] {
  const out: Set<string>[] = [];
  const seen = new Set<string>();
  for (const s of [p.code, p.description, ...p.aliases]) {
    const set = new Set(normalDesc(s));
    const key = [...set].sort().join(' ');
    if (set.size && !seen.has(key)) {
      seen.add(key);
      out.push(set);
    }
  }
  return out;
}

type Phrased = { part: Part; phrases: Set<string>[] }[];
const phrasedCache = new WeakMap<Part[], Phrased>();

/** Each part with its phrases, worked out once per parts list (the index proposes for thousands of groups). */
function phrased(parts: Part[]): Phrased {
  let all = phrasedCache.get(parts);
  if (!all) {
    all = parts.map((part) => ({ part, phrases: phrases(part) }));
    phrasedCache.set(parts, all);
  }
  return all;
}

const within = (a: Set<string>, b: Set<string>): boolean => [...a].every((x) => b.has(x));

/** The one part with the longest phrase inside `tokens`, and those phrases; null when none or a tie. */
function bestPart(tokens: Set<string>, all: Phrased): { part: Part; hits: Set<string>[] } | null {
  let best: { part: Part; hits: Set<string>[] } | null = null;
  let size = 0;
  let tied = false;
  for (const { part, phrases: ph } of all) {
    const hits = ph.filter((x) => within(x, tokens));
    const longest = Math.max(0, ...hits.map((x) => x.size));
    if (!longest || longest < size) continue;
    tied = longest === size;
    if (longest > size) {
      best = { part, hits };
      size = longest;
    }
  }
  return best && !tied ? best : null;
}

/**
 * For a generic code (LABOR, INSTALL-): the job its description words name and the fewest of those words that
 * pick out that one part. For any other code: a part with that code, else the part its code's words name, for
 * every line of the code (no words). Null when nothing matches or several parts tie.
 */
export function propose(group: { im_code: string; words: string[] }, parts: Part[]): Proposal | null {
  if (!GENERIC_CODES.includes(group.im_code)) {
    const same = parts.find((p) => p.code === group.im_code);
    if (same) return { job: same.code, words: [] };
  }
  const all = phrased(parts);
  if (!GENERIC_CODES.includes(group.im_code)) {
    const best = bestPart(new Set(normalDesc(group.im_code)), all);
    return best ? { job: best.part.code, words: [] } : null;
  }
  const best = bestPart(new Set(group.words), all);
  if (!best) return null;
  const others = all.filter((x) => x.part !== best.part);
  const alone = best.hits
    .filter((h) => !others.some((o) => o.phrases.some((x) => within(x, h))))
    .map((h) => [...h].sort())
    .sort((a, b) => a.length - b.length || a.join(' ').localeCompare(b.join(' ')));
  const words = alone[0];
  return words ? { job: best.part.code, words } : null;
}
