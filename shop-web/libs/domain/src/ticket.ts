// Types and constants of a shop ticket. Field names are exactly tickets.py's: the JSON is shared with Python.

export type Line = {
  desc: string;
  qty: number;
  price: number | null; // part price each; null = labor-only line
  labor: number | null; // labor charge
  code: string; // catalog code when matched
  id: number;
};

export type Deposit = {
  amount: number;
  method: 'cash' | 'card' | 'check' | 'other';
  date: string; // ISO YYYY-MM-DD
  note: string;
  id: number;
};

export type Ticket = {
  id: number;
  status: string;
  first: string;
  last: string;
  phone: string;
  year: string;
  make: string;
  model: string;
  plate: string;
  request: string;
  mechanic: string;
  odometer: string;
  vin: string;
  notes: string;
  lines: Line[];
  deposits: Deposit[];
  back_note: string;
  mech_edit: string;
  created: string;
  updated: string;
  version: number;
  deleted_at: string; // when it was deleted (as updated); '' = not deleted
  deleted_by: string; // who deleted it, "role#id"
  deleted_from: string; // the status it had, which restore puts back
  // unknown JSON keys read from the database ride along untouched
  [extra: string]: unknown;
};

/** A save with an old version; .ticket is the stored one. */
export class Stale extends Error {
  readonly ticket: Ticket;
  constructor(ticket: Ticket) {
    super('changed on another device');
    this.name = 'Stale';
    this.ticket = ticket;
  }
}

/** A status move or edit not allowed now; the message says why. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refused';
  }
}

/** Bad fields; .errors is field -> message. */
export class Invalid extends Error {
  readonly errors: Record<string, string>;
  constructor(errors: Record<string, string>) {
    super(
      Object.entries(errors)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; '),
    );
    this.name = 'Invalid';
    this.errors = errors;
  }
}

export const REQUIRED = ['first', 'last', 'phone', 'year', 'make', 'model'] as const;
export const UPPER = ['first', 'last', 'make', 'model', 'plate'] as const;
export const TEXT = ['request', 'mechanic', 'odometer', 'vin', 'notes'] as const;
export const LONG: readonly string[] = ['request', 'notes']; // up to 2000 chars; other text fields 80
export const MECHANIC_KEYS: ReadonlySet<string> = new Set(['lines', 'odometer', 'vin', 'notes']);
export const MAX_LINES = 100;
export const MAX_MONEY = 1e6;
export const MAX_QTY = 1e4;
export const MAX_DEPOSITS = 50;
export const METHODS = ['cash', 'card', 'check', 'other'] as const; // how a deposit was paid
export const DEPOSIT_DAYS = 366; // a deposit's date is at most about a year from today, either way
// "from>to"; the desk enters the whole invoice and sends it itself
export const MOVES: ReadonlySet<string> = new Set([
  'waiting>working',
  'working>review',
  'review>working',
  'review>approved',
  'approved>filled',
  'waiting>approved',
  'working>approved',
]);
// a mechanic changes their own job, and their invoice until it's filled
export const MECHANIC_EDITS = ['working', 'approved'] as const;

/** A ticket with the dataclass defaults, then `clean` on top. */
export function newTicket(clean: Partial<Ticket>, now: string): Ticket {
  return {
    id: 0,
    status: 'waiting',
    first: '',
    last: '',
    phone: '',
    year: '',
    make: '',
    model: '',
    plate: '',
    request: '',
    mechanic: '',
    odometer: '',
    vin: '',
    notes: '',
    lines: [],
    deposits: [],
    back_note: '',
    mech_edit: '',
    created: now,
    updated: now,
    version: 1,
    deleted_at: '',
    deleted_by: '',
    deleted_from: '',
    ...clean,
  };
}
