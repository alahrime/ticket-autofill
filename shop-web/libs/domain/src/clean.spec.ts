import { money, normalize, nowIso, squash, text } from './index.js';
import { addDays, deposit, isoDay, line, thrown } from './testing.js';

const DESK = {
  first: ' jane ',
  last: 'doe',
  phone: '555 010 0000',
  year: '2019',
  make: 'cadillac',
  model: ' cts   v ',
  plate: 'xks-4827',
  request: 'oil change, brakes squeak',
  color: 'red',
};
const TODAY = new Date();
const YESTERDAY = isoDay(addDays(TODAY, -1));
const lines = (...ls: unknown[]) => ({ lines: ls });
const errs = (f: Record<string, unknown>) => normalize(f).errors;

describe('money', () => {
  it('rounds half-up on the typed digits', () => {
    expect(money('$1,200.005', 'price')).toBe(1200.01);
    expect(money('12.5', 'price')).toBe(12.5);
    expect(money(3, 'price')).toBe(3);
    expect(money('.5', 'price')).toBe(0.5);
    expect(money('5.', 'price')).toBe(5);
    expect(money('+3', 'price')).toBe(3);
    expect(money('1e6', 'price')).toBe(1000000);
    expect(money('1e-999', 'price')).toBe(0);
    expect(money('-0', 'price')).toBe(0);
    expect(money('45.555', 'price')).toBe(45.56);
  });

  it('is null when empty', () => {
    expect(money('', 'price')).toBeNull();
    expect(money(null, 'price')).toBeNull();
    expect(money(' ', 'price')).toBeNull();
    expect(money('$ ', 'price')).toBeNull();
  });

  it('says what is wrong, as Python does', () => {
    expect(thrown(() => money('NaN', 'price')).message).toBe('price must be a number');
    expect(thrown(() => money('Infinity', 'price')).message).toBe('price must be a number');
    expect(thrown(() => money('abc', 'price')).message).toBe('price must be a number');
    expect(thrown(() => money('-1', 'price')).message).toBe("price can't be negative");
    expect(thrown(() => money('-0.001', 'price')).message).toBe("price can't be negative");
    expect(thrown(() => money('1000000.01', 'price')).message).toBe('price must be 1e+06 or less');
    // Python: Decimal('1e400') is finite, so it is "too big", not "not a number"
    expect(thrown(() => money('1e400', 'price')).message).toBe('price must be 1e+06 or less');
    expect(thrown(() => money(1e21, 'p')).message).toBe('p must be 1e+06 or less');
    expect(thrown(() => money(10001, 'qty', 1e4)).message).toBe('qty must be 10000 or less');
    expect(thrown(() => money('1e4001', 'qty', 1e4)).message).toBe('qty must be 10000 or less');
    expect(thrown(() => money(true, 'p')).message).toBe('p must be text');
    expect(thrown(() => money(['x'], 'p')).message).toBe('p must be text');
    expect(thrown(() => money('x'.repeat(41), 'p')).message).toBe('p is too long (max 40)');
  });
});

describe('text helpers', () => {
  it('squash and text follow Python whitespace', () => {
    expect(squash('  a   b\x1fc ')).toBe('a b c');
    expect(squash(null)).toBe('');
    expect(squash(0)).toBe('');
    expect(text('\ufeffx', 'f')).toBe('\ufeffx'); // not whitespace in Python
    expect(text(null, 'f')).toBe('');
  });

  it('nowIso is local time, seconds, no offset', () => {
    expect(nowIso(new Date(2026, 10, 18, 14, 3, 9))).toBe('2026-11-18T14:03:09');
    expect(nowIso()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
  });
});

describe('normalize', () => {
  it('desk fields', () => {
    const { clean: out, errors } = normalize(DESK, { create: true });
    expect(errors).toEqual({});
    expect([out.first, out.last, out.make, out.model, out.plate]).toEqual(['JANE', 'DOE', 'CADILLAC', 'CTS V', 'XKS-4827']);
    expect(out.phone).toBe('(555)010-0000');
    expect(out.year).toBe('2019');
    expect(out).not.toHaveProperty('color');
  });

  it('required and bad values', () => {
    expect(new Set(Object.keys(normalize({}, { create: true }).errors))).toEqual(
      new Set(['first', 'last', 'phone', 'year', 'make', 'model']),
    );
    expect(errs({ plate: 'abc' })).toEqual({});
    expect(Object.keys(errs({ first: '  ' }))).toEqual(['first']);
    expect(new Set(Object.keys(errs({ phone: '555-0100', year: '19', odometer: '98k' })))).toEqual(
      new Set(['phone', 'year', 'odometer']),
    );
    const nxt = TODAY.getFullYear() + 1;
    expect(errs({ year: String(nxt) })).toEqual({});
    expect(errs({ year: String(nxt + 1) })).toHaveProperty('year');
    expect(errs({ year: '1949' })).toHaveProperty('year');
    expect(errs({ year: 1950 })).toEqual({});
    expect(normalize({ odometer: '98,431' }).clean.odometer).toBe('98431');
    expect(normalize({ odometer: 0 }).clean.odometer).toBe('0');
  });

  it('year range and deposit dates use the injected today', () => {
    const today = new Date(2026, 10, 18);
    expect(normalize({ year: '2027' }, { today }).errors).toEqual({});
    expect(normalize({ year: '2028' }, { today }).errors).toEqual({ year: 'year must be 1950 to 2027' });
    expect(normalize({ deposits: [{ amount: 5 }] }, { today }).clean.deposits).toEqual([
      deposit(5, { date: '2026-11-18', id: 1 }),
    ]);
    expect(normalize({ deposits: [{ amount: 5, date: '2025-11-17' }] }, { today }).errors).toEqual({}); // 366 days
    expect(normalize({ deposits: [{ amount: 5, date: '2025-11-16' }] }, { today }).errors).toHaveProperty('deposits');
  });

  it('types and lengths', () => {
    expect(normalize({ first: ['JANE'], notes: { a: 1 }, phone: [5550100000], lines: 5 }).errors).toEqual({
      first: 'first must be text',
      notes: 'notes must be text',
      phone: 'phone must be text',
      lines: 'lines must be a list',
    });
    expect(errs({ odometer: '12345678' })).toHaveProperty('odometer');
    expect(errs({ odometer: '1234567' })).toEqual({});
    expect(errs({ plate: 'X'.repeat(81) })).toHaveProperty('plate');
    expect(errs({ plate: 'X'.repeat(80) })).toEqual({});
    expect(errs({ request: 'x'.repeat(2001) })).toHaveProperty('request');
    expect(errs({ notes: 'x'.repeat(2000) })).toEqual({});
    expect(errs(lines({ desc: 'x'.repeat(201) })).lines).toContain('description');
    expect(errs(lines(...Array(101).fill({ desc: 'x' })))).toEqual({ lines: 'at most 100 lines' });
    expect(errs(lines(...Array(100).fill({ desc: 'x' })))).toEqual({});
  });

  it('lines', () => {
    const { clean: out, errors } = normalize(
      lines(
        { desc: ' brake  pads ', qty: '2', price: '$45.555', labor: '80' },
        { desc: 'diag', labor: 60, id: 7 },
        line('wiper', { price: 12.5 }),
      ),
    );
    expect(errors).toEqual({});
    const [a, b, c] = out.lines ?? [];
    expect([a?.desc, a?.qty, a?.price, a?.labor, a?.id]).toEqual(['brake pads', 2, 45.56, 80, 8]);
    expect([b?.price, b?.labor, b?.id]).toEqual([null, 60, 7]);
    expect(c?.id).toBe(9);
    expect(c?.qty).toBe(1);
    const bads: [unknown, string][] = [
      [{ desc: 'x', qty: 0 }, 'qty'],
      [{ desc: 'x', price: -1 }, 'price'],
      [{ desc: 'x', labor: 'abc' }, 'labor'],
      [{ desc: ' ' }, 'description'],
      [{ desc: 'x', qty: -2 }, 'qty'],
      [{ desc: 'x', price: '1e30' }, 'price'],
      [{ desc: 'x', price: 1000000.01 }, 'price'],
      [{ desc: 'x', qty: '1e30' }, 'qty'],
      [{ desc: 'x', qty: 10001 }, 'qty'],
      [{ desc: 'x', labor: 'nan' }, 'labor'],
      ['x', 'bad'],
    ];
    for (const [bad, msg] of bads) {
      const e = errs(lines({ desc: 'ok' }, bad)).lines as string;
      expect(e.startsWith('line 2:')).toBe(true);
      expect(e).toContain(msg);
    }
    expect(errs(lines({ desc: 'x', qty: 10000, price: 1e6 }))).toEqual({});
  });

  it('line ids: negative and duplicate ones are renumbered', () => {
    const out = normalize(lines({ desc: 'a', id: -5 }, { desc: 'b', id: 3 }, { desc: 'c', id: 3 }, { desc: 'd', id: 'x' }));
    expect(out.clean.lines?.map((x) => x.id)).toEqual([4, 3, 5, 6]);
    const big = normalize(lines({ desc: 'a', id: 1e9 }, { desc: 'b', id: 1e9 + 1 }, { desc: 'c', id: 1e308 }));
    expect(big.clean.lines?.map((x) => x.id)).toEqual([1e9, 1e9 + 1, 1e9 + 2]);
  });

  it('deposits', () => {
    const { clean: out, errors } = normalize({
      deposits: [{ amount: '$1,200.005', method: ' Card ', date: YESTERDAY, note: ' half ' }, { amount: 5, id: 7 }],
    });
    expect(errors).toEqual({});
    // defaults; new ids follow the top one
    expect(out.deposits).toEqual([
      deposit(1200.01, { method: 'card', date: YESTERDAY, note: 'half', id: 8 }),
      deposit(5, { method: 'cash', date: isoDay(TODAY), id: 7 }),
    ]);
    const ids = (d: unknown[]) => normalize({ deposits: d }).clean.deposits?.map((x) => x.id);
    // kept, new and repeated ones get the next free id
    expect(ids([{ amount: 1, id: 3 }, { amount: 2 }, { amount: 3, id: 3 }, { amount: 4, id: -1 }])).toEqual([3, 4, 5, 6]);
    const bads: unknown[] = [
      [{ amount: 0 }],
      [{ amount: '' }],
      [{ amount: '-5' }],
      [{ amount: 'ten' }],
      [{ amount: 1000000.01 }],
      [{ amount: 5, method: 'venmo' }],
      [{ amount: 5, date: '11/02/2026' }],
      [{ amount: 5, date: '2026-02-30' }],
      [{ amount: 5, date: '2026-1-2' }],
      [{ amount: 5, date: isoDay(addDays(TODAY, 367)) }],
      [{ amount: 5, date: isoDay(addDays(TODAY, -367)) }],
      [{ amount: 5, date: '1926-11-02' }],
      [{ amount: 5, note: 'x'.repeat(201) }],
      [{ amount: 5, note: ['x'] }],
      ['5'],
      [null],
      { amount: 5 },
      '5',
      Array(51).fill({ amount: 1 }),
    ];
    for (const bad of bads) expect(errs({ deposits: bad })).toHaveProperty('deposits');
    expect(errs({ deposits: [{ amount: 1000000, note: 'x'.repeat(200) }] })).toEqual({});
    for (const days of [-365, 365]) {
      // a year either way is fine: a late entry, a post-dated check
      expect(errs({ deposits: [{ amount: 1, date: isoDay(addDays(TODAY, days)) }] })).toEqual({});
    }
    expect(errs({ deposits: [{ amount: 1, date: isoDay(addDays(TODAY, 400)) }] }).deposits).toContain('within a year');
    expect(errs({ deposits: [{ amount: 5, method: 'venmo' }] }).deposits).toBe(
      'deposit 1: method must be cash, card, check, other',
    );
    expect(normalize({ deposits: [] })).toEqual({ clean: { deposits: [] }, errors: {} });
  });
});
