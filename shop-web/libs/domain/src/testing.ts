// Test helpers shared by the spec files (not exported from the library).
import { type Deposit, type Line, newTicket, type Ticket } from './ticket.js';

export const line = (desc: string, o: Partial<Line> = {}): Line => ({
  desc,
  qty: 1,
  price: null,
  labor: null,
  code: '',
  id: 0,
  ...o,
});

export const deposit = (amount: number, o: Partial<Deposit> = {}): Deposit => ({
  amount,
  method: 'cash',
  date: '',
  note: '',
  id: 0,
  ...o,
});

export const tk = (o: Partial<Ticket> = {}): Ticket => newTicket(o, '');

/** The error a call throws (fails the test when it doesn't throw). */
export function thrown(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error('did not throw');
}

const pad = (n: number): string => String(n).padStart(2, '0');
export const isoDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
