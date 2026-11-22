// Price suggestions: from what the job charged before (InvoMax samples plus the shop's own filled tickets), the
// median of the closest group of 3 or more. Samples are cents per unit; the pick is whole cents.
import type { Ticket } from '@shop/domain';
import type { LinkStore } from '../history/links';
import type { TicketStore } from '../store';
import type { Sample } from './index';

export type Basis = {
  level: 'model_years' | 'model' | 'make' | 'all';
  years: [number, number] | null;
  make: string;
  model: string;
  recent: boolean;
};
export type Pick = { unit: number; count: number; low: number; high: number; basis: Basis };
export type Car = { year: number | null; make: string; model: string };

export const MIN_SAMPLES = 3;
export const YEARS_AROUND = 2;
export const RECENT_MONTHS = 24;

const ymd = (d: Date): string =>
  `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The local calendar day `months` before `now` (the 31st lands on the last day of a shorter month). */
function monthsBefore(now: Date, months: number): string {
  const first = new Date(now.getFullYear(), now.getMonth() - months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return ymd(new Date(first.getFullYear(), first.getMonth(), Math.min(now.getDate(), last)));
}

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toUpperCase();

/** Linear interpolation between ranks (numpy's default) over sorted values. */
function percentile(sorted: number[], p: number): number {
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (at - lo);
}

const cents = (x: number): number => Math.floor(x + 0.5);

function summary(list: Sample[], basis: Basis): Pick {
  const u = list.map((x) => x.unit).sort((a, b) => a - b);
  return { unit: cents(percentile(u, 0.5)), count: u.length, low: cents(percentile(u, 0.25)), high: cents(percentile(u, 0.75)), basis };
}

/**
 * Levels in order (same model within 2 years, same model, same make, any car), each over the last 24 months and
 * then over all time, the first with 3 or more samples. When no level has 3, all the samples together answer
 * (so a job seen once still suggests its price); null when there are none.
 */
export function suggest(samples: Sample[], car: Car, now: Date): Pick | null {
  if (samples.length === 0) return null;
  const make = norm(car.make);
  const model = norm(car.model);
  const cutoff = monthsBefore(now, RECENT_MONTHS);
  const recent = samples.filter((x) => x.date >= cutoff);
  const levels: { level: Basis['level']; keep: (x: Sample) => boolean }[] = [];
  const years: [number, number] | null = car.year === null ? null : [car.year - YEARS_AROUND, car.year + YEARS_AROUND];
  const sameModel = (x: Sample): boolean => norm(x.make) === make && norm(x.model) === model;
  // a blank model (or make) says nothing about the car: it must not match the samples with no vehicle either
  if (model !== '') {
    if (years && car.year !== null)
      levels.push({ level: 'model_years', keep: (x) => sameModel(x) && x.year !== null && Math.abs(x.year - (car.year as number)) <= YEARS_AROUND });
    levels.push({ level: 'model', keep: sameModel });
  }
  if (make !== '') levels.push({ level: 'make', keep: (x) => norm(x.make) === make });
  levels.push({ level: 'all', keep: () => true });
  const basisOf = (level: Basis['level'], isRecent: boolean): Basis => ({
    level,
    years: level === 'model_years' ? years : null,
    make: level === 'all' ? '' : make,
    model: level === 'model_years' || level === 'model' ? model : '',
    recent: isRecent,
  });
  for (const [pool, isRecent] of [[recent, true], [samples, false]] as const)
    for (const { level, keep } of levels) {
      const list = pool.filter(keep);
      if (list.length >= MIN_SAMPLES) return summary(list, basisOf(level, isRecent));
    }
  return summary(samples, basisOf('all', false));
}

const filledDay = (t: Ticket): string => t.updated.slice(0, 10);

/** The year as a whole number, or null when it is blank or not one. */
function yearOf(s: string): number | null {
  const y = /^\d{4}$/.test(s.trim()) ? Number(s) : null;
  return y !== null && y >= 1900 && y <= 2100 ? y : null;
}

type Cached = { key: string; byJob: Map<string, Sample[]> };
const cache = new WeakMap<TicketStore, Cached>();

/** Filled tickets' lines by "job|kind", the InvoMax-linked tickets left out: one scan, kept until a marker changes. */
function index(store: TicketStore, links: LinkStore): Map<string, Sample[]> {
  const key = `${store.filledMarker()}#${links.invomaxMarker()}`; // from the database: Python's writes count too
  const had = cache.get(store);
  if (had?.key === key) return had.byJob;
  const billed = links.invomaxLinked();
  const byJob = new Map<string, Sample[]>();
  const add = (job: string, kind: string, s: Sample): void => {
    const k = `${job}|${kind}`;
    const list = byJob.get(k);
    if (list) list.push(s);
    else byJob.set(k, [s]);
  };
  for (const t of store.list(['filled'])) {
    if (billed.has(t.id)) continue;
    const at = { date: filledDay(t), year: yearOf(t.year), make: t.make, model: t.model };
    for (const line of t.lines) {
      if (!line.code) continue;
      if (line.price !== null && line.price > 0) add(line.code, 'part', { unit: line.price * 100, ...at });
      if (line.labor !== null && line.labor > 0) add(line.code, 'labor', { unit: (line.labor / Math.max(line.qty, 1)) * 100, ...at });
    }
  }
  cache.set(store, { key, byJob });
  return byJob;
}

/**
 * What the shop's own filled tickets charged for the job (cents per unit). One scan of the filled tickets feeds
 * every job and both kinds; it is kept until the tickets or the InvoMax links change. Tickets tied to an
 * InvoMax bill are left out: that bill's lines are already in the InvoMax samples.
 */
export function ourSamples(store: TicketStore, links: LinkStore, job: string, kind: 'part' | 'labor'): Sample[] {
  return (index(store, links).get(`${job}|${kind}`) ?? []).map((s) => ({ ...s }));
}
