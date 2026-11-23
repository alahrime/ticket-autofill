import { billAmounts, billRows } from './bill.js';
import type { Line } from './ticket.js';
import { deposit, line } from './testing.js';

const ln = (desc: string, qty: number, price: number | null, labor: number | null): Line =>
  line(desc, { qty, price, labor });
const dep = (amount: number) => deposit(amount);

describe('billAmounts', () => {
  it('caps supplies at 20.00', () => {
    expect(billAmounts({ lines: [ln('BRAKE PADS', 1, 322, 195)], deposits: [] })).toEqual({
      parts: 32200, labor: 19500, supplies: 2000, tax: 2052, total: 55752, deposit: 0, balance: 55752,
    });
  });
  it('second checked bill', () => {
    const a = billAmounts({ lines: [ln('ROTORS', 1, 362, 586)], deposits: [] });
    expect([a.supplies, a.tax, a.total]).toEqual([2000, 2292, 99092]);
  });
  it('rounds supplies half-up below the cap', () => {
    const lines = [ln('OIL FILTER', 6, 12.99, null), ln('WIPERS', 1, 19.99, null), ln('BATTERY', 1, 50, null), ln('DIAGNOSTIC', 1, null, 135)];
    const a = billAmounts({ lines, deposits: [] });
    expect([a.parts, a.labor, a.supplies, a.tax, a.total]).toEqual([14793, 13500, 1415, 972, 30680]);
  });
  it('fourth bill with a deposit', () => {
    const a = billAmounts({ lines: [ln('BRAKE PADS', 1, 219, 345)], deposits: [dep(100)] });
    expect([a.supplies, a.tax, a.total, a.deposit, a.balance]).toEqual([2000, 1434, 59834, 10000, 49834]);
  });
  it('no lines gives zeros', () => {
    expect(billAmounts({ lines: [], deposits: [] })).toEqual({
      parts: 0, labor: 0, supplies: 0, tax: 0, total: 0, deposit: 0, balance: 0,
    });
  });
});

describe('billRows', () => {
  it('names part+labor lines Remove & Install and keeps order', () => {
    const r = billRows([ln('BRAKE PADS', 1, 50, 80), ln('DIAGNOSTIC', 1, null, 40), ln('OIL FILTER', 1, 9, null)]);
    expect(r.labor).toEqual([
      { desc: 'Remove & Install: BRAKE PADS', amount: 8000 },
      { desc: 'DIAGNOSTIC', amount: 4000 },
    ]);
    expect(r.parts.map((p) => p.desc)).toEqual(['BRAKE PADS', 'OIL FILTER']);
  });
  it('totals qty x price', () => {
    expect(billRows([ln('OIL FILTER', 6, 12.99, null)]).parts).toEqual([
      { desc: 'OIL FILTER', qty: 6, price: 1299, total: 7794 },
    ]);
  });
  it('a line with neither gives nothing', () => {
    expect(billRows([ln('NOTE', 1, null, null)])).toEqual({ labor: [], parts: [] });
  });
});
