// JobIndex: every InvoMax bill line (invomax.db) with its job under the rules (tickets.db's job_map), kept in
// memory per server process. Checked on each use with two cheap queries: the lines are read again when the
// newest im_imports.id changes, and the rules applied again (no reading of lines) when the rule count, the newest
// made_at or this process's rule writes change. Building only reads: no write lock on tickets.db is held.
// Money out is dollars; Sample.unit is cents.
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { GENERIC_CODES } from '@shop/invomax';
import { loadParts, type Part } from '../routes/catalog';
import { IGNORE, type JobMap, matchPrepared, normalDesc, type Prepared, prepareRules } from './jobmap';
import { propose, type Proposal } from './propose';

export type Sample = { unit: number; date: string; year: number | null; make: string; model: string };

export type Group = {
  im_code: string;
  words: string[];
  lines: number;
  dollars: number;
  samples: string[];
  proposed: Proposal | null;
  rule: { job: string; words: string[] } | null;
};

export type Coverage = { lines: number; mapped_lines: number; dollars: number; mapped_dollars: number };

type Kind = 'part' | 'labor';
const KIND = { other: 0, part: 1, labor: 2 } as const;

type LineRow = {
  invoice_no: string;
  line_no: number;
  code: string;
  description: string;
  kind: string;
  unit: number;
  amount: number;
  year: number | null;
  make: string;
  model: string;
  date: string | null;
  gone_at: string | null;
};

/** A group as the lines make it (rules don't change it). */
type StaticGroup = { im_code: string; words: string[]; lines: number; cents: number; samples: string[] };

/** All lines, column by column, read once per import. */
type Lines = {
  key: string;
  count: number;
  at: Map<string, number>; // "invoice|line" -> line index
  pair: Int32Array; // line -> its (code, description words) pair
  pairs: { code: string; words: string[] }[];
  group: Int32Array; // line -> its group, -1: not counted (not part / labor, or not on a live bill)
  groups: StaticGroup[]; // biggest first
  kind: Uint8Array;
  unit: Float64Array;
  amount: Float64Array;
  date: string[];
  year: (number | null)[];
  make: string[];
  model: string[];
  proposals: { key: string; list: (Proposal | null)[] } | null; // by group, for one parts.csv
};

/** The rules applied to the lines. */
type Mapped = {
  key: string;
  byCode: Map<string, Prepared[]>;
  pairJob: (string | null)[];
  groupMapped: Int32Array;
  coverage: Coverage;
  samples: Map<string, Sample[]>; // "job|kind", worked out on first ask
};

const SAMPLE_DESCS = 3;
const lineKey = (inv: string, line: number): string => `${inv}|${line}`;
type At = { date: string; inv: string; line: number };
const newer = (a: At, b: At): boolean => a.date > b.date || (a.date === b.date && (a.inv < b.inv || (a.inv === b.inv && a.line < b.line)));

export class JobIndex {
  /** How many times the lines were read / the rules applied (tests check neither runs when nothing changed). */
  builds = 0;
  applies = 0;
  private lines: Lines | null = null;
  private mapped: Mapped | null = null;

  constructor(
    readonly map: JobMap,
    private readonly im: DatabaseSync,
    private readonly catalog: string,
  ) {}

  /** Brings the index and its proposals up to date now (the nightly run calls it after an import). */
  refresh(): void {
    this.proposals(this.current().l);
  }

  private current(): { l: Lines; m: Mapped } {
    const r = this.im.prepare('SELECT MAX(id) AS id FROM im_imports WHERE ok = 1').get() as { id: number | null };
    const linesKey = String(r.id ?? 0);
    if (this.lines?.key !== linesKey) {
      this.lines = this.readLines(linesKey);
      this.mapped = null;
    }
    const rulesKey = this.map.version();
    if (this.mapped?.key !== rulesKey) this.mapped = this.apply(this.lines, rulesKey);
    return { l: this.lines, m: this.mapped };
  }

  /** One read transaction: the count and the rows are one snapshot even while an import writes (WAL). */
  private readLines(key: string): Lines {
    const own = !this.im.isTransaction;
    if (own) this.im.exec('BEGIN');
    try {
      return this.readSnapshot(key);
    } finally {
      if (own && this.im.isTransaction) this.im.exec('COMMIT');
    }
  }

  private readSnapshot(key: string): Lines {
    const n = (this.im.prepare('SELECT COUNT(*) AS n FROM im_lines').get() as { n: number }).n;
    const rows = this.im
      .prepare(
        `SELECT l.invoice_no, l.line_no, l.code, l.description, l.kind, l.unit, l.amount, l.year, l.make, l.model,
                i."date" AS date, i.gone_at
         FROM im_lines l LEFT JOIN im_invoices i ON i.invoice_no = l.invoice_no`,
      )
      .iterate() as IterableIterator<LineRow>;
    const strings = new Map<string, string>(); // one copy of each repeated date / make / model
    const one = (v: string): string => {
      const had = strings.get(v);
      if (had !== undefined) return had;
      strings.set(v, v);
      return v;
    };
    const words = new Map<string, string[]>(); // description -> normalDesc
    const pairAt = new Map<string, number>();
    const pairs: Lines['pairs'] = [];
    const groupAt = new Map<string, number>();
    const acc: (StaticGroup & { descs: Map<string, At & { n: number }> })[] = [];
    const out: Lines = {
      key,
      count: n,
      at: new Map(),
      pair: new Int32Array(n),
      pairs,
      group: new Int32Array(n).fill(-1),
      groups: [],
      kind: new Uint8Array(n),
      unit: new Float64Array(n),
      amount: new Float64Array(n),
      date: new Array<string>(n),
      year: new Array<number | null>(n),
      make: new Array<string>(n),
      model: new Array<string>(n),
      proposals: null,
    };
    let i = 0;
    for (const l of rows) {
      if (i >= n) break; // cannot happen inside the snapshot
      let w = words.get(l.description);
      if (!w) {
        w = normalDesc(l.description);
        words.set(l.description, w);
      }
      const generic = GENERIC_CODES.includes(l.code);
      const pk = `${l.code}\u0000${w.join(' ')}`;
      let p = pairAt.get(pk);
      if (p === undefined) {
        p = pairs.length;
        pairs.push({ code: l.code, words: w });
        pairAt.set(pk, p);
      }
      out.at.set(lineKey(l.invoice_no, l.line_no), i);
      out.pair[i] = p;
      out.kind[i] = l.kind === 'part' ? KIND.part : l.kind === 'labor' ? KIND.labor : KIND.other;
      out.unit[i] = l.unit;
      out.amount[i] = l.amount;
      out.date[i] = one(l.date ?? '');
      out.year[i] = l.year;
      out.make[i] = one(l.make);
      out.model[i] = one(l.model);
      const live = l.date !== null && !l.gone_at; // a line on a bill InvoMax no longer has (or never had) counts for nothing
      if (!live || out.kind[i] === KIND.other) {
        i++;
        continue;
      }
      const gk = generic ? pk : l.code;
      let g = groupAt.get(gk);
      if (g === undefined) {
        g = acc.length;
        acc.push({ im_code: l.code, words: generic ? w : [], lines: 0, cents: 0, samples: [], descs: new Map() });
        groupAt.set(gk, g);
      }
      out.group[i] = g;
      const a = acc[g] as (typeof acc)[number];
      a.lines++;
      a.cents += l.amount;
      const at = { date: l.date as string, inv: l.invoice_no, line: l.line_no };
      const d = a.descs.get(l.description);
      if (!d) a.descs.set(l.description, { n: 1, ...at });
      else {
        d.n++;
        if (newer(at, d)) Object.assign(d, at);
      }
      i++;
    }
    out.count = i;
    // biggest first; out.group is renumbered to match
    const order = acc
      .map((_, i) => i)
      .sort((x, y) => {
        const a = acc[x] as StaticGroup;
        const b = acc[y] as StaticGroup;
        return b.lines - a.lines || b.cents - a.cents || a.im_code.localeCompare(b.im_code) || a.words.join(' ').localeCompare(b.words.join(' '));
      });
    const rank = new Int32Array(acc.length);
    order.forEach((g, r) => (rank[g] = r));
    for (let j = 0; j < i; j++) {
      const g = out.group[j] as number;
      if (g >= 0) out.group[j] = rank[g] as number;
    }
    out.groups = order.map((g) => {
      const { descs, ...rest } = acc[g] as (typeof acc)[number];
      const samples = [...descs]
        .sort(([, x], [, y]) => y.n - x.n || (newer(x, y) ? -1 : newer(y, x) ? 1 : 0))
        .slice(0, SAMPLE_DESCS)
        .map(([desc]) => desc);
      return { ...rest, samples };
    });
    this.builds++;
    return out;
  }

  private apply(l: Lines, key: string): Mapped {
    const byCode = prepareRules(this.map.rules()); // each rule's word set once
    const pairJob = l.pairs.map((p) => {
      const codeRules = byCode.get(p.code);
      return codeRules ? (matchPrepared(new Set(p.words), codeRules)?.job ?? null) : null;
    });
    const groupMapped = new Int32Array(l.groups.length);
    const coverage: Coverage = { lines: 0, mapped_lines: 0, dollars: 0, mapped_dollars: 0 };
    for (let i = 0; i < l.count; i++) {
      const g = l.group[i] as number;
      if (g < 0) continue;
      const amount = l.amount[i] as number;
      coverage.lines++;
      coverage.dollars += amount;
      if (pairJob[l.pair[i] as number] === null) continue;
      groupMapped[g]++;
      coverage.mapped_lines++;
      coverage.mapped_dollars += amount;
    }
    coverage.dollars /= 100;
    coverage.mapped_dollars /= 100;
    this.applies++;
    return { key, byCode, pairJob, groupMapped, coverage, samples: new Map() };
  }

  /** The line's job ('ignore' included), or null: no rule, or no such line. */
  job(invoiceNo: string, lineNo: number): string | null {
    const { l, m } = this.current();
    const i = l.at.get(lineKey(invoiceNo, lineNo));
    return i === undefined ? null : (m.pairJob[l.pair[i] as number] ?? null);
  }

  /** What the job's lines of this kind charged each, newest first: bills InvoMax still has, unit > 0. */
  samples(job: string, kind: Kind): Sample[] {
    if (job === IGNORE) return [];
    const { l, m } = this.current();
    const sk = `${job}|${kind}`;
    let list = m.samples.get(sk);
    if (!list) {
      list = [];
      const want = KIND[kind];
      for (let i = 0; i < l.count; i++) {
        if ((l.group[i] as number) < 0 || l.kind[i] !== want || m.pairJob[l.pair[i] as number] !== job) continue;
        const unit = l.unit[i] as number;
        if (unit <= 0) continue;
        list.push({ unit, date: l.date[i] as string, year: l.year[i] ?? null, make: l.make[i] as string, model: l.model[i] as string });
      }
      list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      m.samples.set(sk, list);
    }
    return list.map((x) => ({ ...x }));
  }

  /** Proposals by group for parts.csv as it is now (worked out again when the file changes). */
  private proposals(l: Lines): (Proposal | null)[] {
    let key = 'none';
    try {
      const st = statSync(this.catalog);
      key = `${st.mtimeMs}|${st.size}`;
    } catch {
      // missing: no proposals
    }
    if (l.proposals?.key !== key) {
      let parts: Part[];
      try {
        parts = key === 'none' ? [] : loadParts(this.catalog);
      } catch {
        parts = []; // malformed: no proposals
      }
      l.proposals = { key, list: l.groups.map((g) => propose(g, parts)) };
    }
    return l.proposals.list;
  }

  /**
   * Part and labor lines on bills InvoMax still has, grouped: one group per code, but one per description words
   * for a generic code. Biggest first. unmappedOnly: only groups with a line no rule maps.
   */
  groups(opts: { unmappedOnly: boolean }): Group[] {
    const { l, m } = this.current();
    const proposed = this.proposals(l);
    const out: Group[] = [];
    l.groups.forEach((g, i) => {
      if (opts.unmappedOnly && (m.groupMapped[i] as number) >= g.lines) return;
      const codeRules = m.byCode.get(g.im_code);
      const rule = codeRules ? matchPrepared(new Set(g.words), codeRules) : null;
      out.push({
        im_code: g.im_code,
        words: [...g.words],
        lines: g.lines,
        dollars: g.cents / 100,
        samples: [...g.samples],
        proposed: proposed[i] ?? null,
        rule: rule ? { job: rule.job, words: rule.words } : null,
      });
    });
    return out;
  }

  coverage(): Coverage {
    return { ...this.current().m.coverage };
  }
}
