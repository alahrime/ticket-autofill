// Our own bill: supplies, tax, total and balance, and the labor/part rows. Pure: no storage. Cents inside.
import { dec, mulCents, totals } from './rules.js';
import type { Line, Ticket } from './ticket.js';

export type BillAmounts = {
  parts: number;
  labor: number;
  supplies: number;
  tax: number;
  total: number;
  deposit: number;
  balance: number;
};
export type LaborRow = { desc: string; amount: number };
export type PartRow = { desc: string; qty: number; price: number; total: number };

const SUPPLIES_CAP = 2000n;
const cents = (dollars: number): bigint => dec(dollars.toFixed(2));

/**
 * Supplies = min(20.00, 5% of parts + labor); tax = 6% of parts + supplies; each rounded half-up to the cent.
 * No tax-free option and no discount. Balance = total less deposits.
 */
export function billAmounts(t: Pick<Ticket, 'lines' | 'deposits'>): BillAmounts {
  const s = totals(t);
  const parts = cents(s.parts);
  const labor = cents(s.labor);
  const deposit = cents(s.deposits);
  const raw = ((parts + labor) * 5n + 50n) / 100n;
  const supplies = raw > SUPPLIES_CAP ? SUPPLIES_CAP : raw;
  const tax = ((parts + supplies) * 6n + 50n) / 100n;
  const total = parts + labor + supplies + tax;
  const n = (c: bigint): number => Number(c);
  return {
    parts: n(parts),
    labor: n(labor),
    supplies: n(supplies),
    tax: n(tax),
    total: n(total),
    deposit: n(deposit),
    balance: n(total - deposit),
  };
}

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;

/** The bill's labor rows and part rows, in line order. A line with neither gives nothing. */
export function billRows(lines: Line[]): { labor: LaborRow[]; parts: PartRow[] } {
  const labor: LaborRow[] = [];
  const parts: PartRow[] = [];
  for (const ln of lines) {
    if (has(ln.labor)) {
      labor.push({ desc: has(ln.price) ? `Remove & Install: ${ln.desc}` : ln.desc, amount: Number(dec(ln.labor)) });
    }
    if (has(ln.price)) {
      parts.push({ desc: ln.desc, qty: ln.qty, price: Number(dec(ln.price)), total: Number(mulCents(ln.qty, ln.price)) });
    }
  }
  return { labor, parts };
}
