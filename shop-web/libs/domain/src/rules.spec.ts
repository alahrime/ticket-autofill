import { edit, Invalid, move, MOVES, normalize, Refused, totals, type Ticket } from './index.js';
import { addDays, deposit, isoDay, line, thrown, tk } from './testing.js';

const TODAY = new Date();
const YESTERDAY = isoDay(addDays(TODAY, -1));
const invalid = (t: Ticket, f: Record<string, unknown>, who: 'desk' | 'mechanic'): Invalid => {
  const e = thrown(() => edit(t, f, who));
  expect(e).toBeInstanceOf(Invalid);
  return e as Invalid;
};
const refuses = (t: Ticket, f: Record<string, unknown>, who: 'desk' | 'mechanic'): Refused => {
  const e = thrown(() => edit(t, f, who));
  expect(e).toBeInstanceOf(Refused);
  return e as Refused;
};

describe('move', () => {
  it('happy path', () => {
    const t = tk({ status: 'waiting' });
    move(t, 'working', ' Mike ');
    expect([t.status, t.mechanic]).toEqual(['working', 'Mike']);
    t.lines = [line('oil', { price: 30, labor: 20 })];
    move(t, 'review');
    move(t, 'working', undefined, 'check the brakes too');
    expect([t.status, t.back_note]).toEqual(['working', 'check the brakes too']);
    move(t, 'review');
    expect(t.back_note).toBe('');
    move(t, 'approved');
    move(t, 'filled');
    expect(t.status).toBe('filled');
  });

  const refused = (t: Ticket, to: string, mechanic?: string, note?: string): void => {
    const before = [t.status, t.mechanic, t.back_note];
    const e = thrown(() => move(t, to, mechanic, note));
    expect(e).toBeInstanceOf(Refused);
    expect(e.message).toBeTruthy();
    expect([t.status, t.mechanic, t.back_note]).toEqual(before);
  };

  it('refuses with a reason and changes nothing', () => {
    const one = [line('x', { labor: 1 })];
    refused(tk({ status: 'waiting' }), 'working');
    refused(tk({ status: 'waiting' }), 'working', '  ');
    refused(tk({ status: 'waiting' }), 'review', 'Mike');
    refused(tk({ status: 'working' }), 'review'); // no lines
    refused(tk({ status: 'working', lines: one }), 'approved'); // nobody named as the mechanic
    refused(tk({ status: 'waiting', lines: one, mechanic: '  ' }), 'approved');
    refused(tk({ status: 'waiting', mechanic: 'Mike' }), 'approved'); // no lines: nothing to bill
    refused(tk({ status: 'review', mechanic: 'Mike' }), 'approved');
    refused(tk({ status: 'waiting', mechanic: 'Mike', lines: one }), 'filled');
    refused(tk({ status: 'review', lines: one }), 'working', undefined, ' ');
    refused(tk({ status: 'approved' }), 'waiting');
    refused(tk({ status: 'filled' }), 'approved');
    refused(tk({ status: 'review' }), 'review');
    expect(MOVES.size).toBe(7);
    expect(thrown(() => move(tk({ status: 'approved' }), 'waiting')).message).toBe("can't go from approved to waiting");
    expect(thrown(() => move(tk({ status: 'waiting' }), 'working')).message).toBe('pick a mechanic to accept');
    expect(thrown(() => move(tk({ status: 'working' }), 'review')).message).toBe('add at least one line before finishing');
    expect(thrown(() => move(tk({ status: 'review', lines: one }), 'working')).message).toBe(
      'say what to fix when sending back',
    );
    expect(thrown(() => move(tk({ status: 'working', lines: one }), 'approved')).message).toBe(
      'pick the mechanic before sending to InvoMax',
    );
    expect(thrown(() => move(tk({ status: 'working', mechanic: 'M' }), 'approved')).message).toBe(
      'add at least one line before sending to InvoMax',
    );
  });

  it('the desk sends straight to InvoMax', () => {
    // the desk typed the whole invoice: no Accept / Finish needed
    for (const st of ['waiting', 'working', 'review']) {
      const t = tk({ status: st, mechanic: 'Mike', back_note: 'redo', lines: [line('oil', { price: 30, labor: 20 })] });
      move(t, 'approved', 'Someone Else');
      // who did it is the ticket's, never the move's
      expect([t.status, t.mechanic, t.back_note]).toEqual(['approved', 'Mike', '']);
    }
    const t = tk({ status: 'waiting', first: 'JANE', last: 'DOE', phone: '(555)010-0000' });
    edit(
      t,
      {
        mechanic: 'Mike',
        odometer: '45,120',
        vin: '2t1br32614c809083',
        lines: [
          { desc: 'front brake pads', price: 100, labor: 80 },
          { desc: 'flush', labor: 60 },
        ],
      },
      'desk',
    );
    move(t, 'approved');
    // before tax: InvoMax adds it
    expect(totals(t)).toEqual({ parts: 100, labor: 140, total: 240, deposits: 0 });
    expect([t.mechanic, t.vin, t.lines.length]).toEqual(['Mike', '2T1BR32614C809083', 2]);
  });
});

describe('edit', () => {
  it('mechanic changes their invoice', () => {
    // still theirs to fix once the desk sent it, until it's filled
    const t = tk({ status: 'approved', mechanic: 'Mike', lines: [line('pads', { price: 100, labor: 80, code: 'FBP', id: 1 })] });
    edit(
      t,
      {
        lines: [{ desc: 'pads', price: 100, labor: 95, code: 'FBP', id: 1 }],
        odometer: '45120',
        notes: 'rear pads at 3 mm',
      },
      'mechanic',
      () => '2026-11-18T10:00:00',
    );
    expect([t.lines[0]?.labor, t.odometer, t.notes, t.status]).toEqual([95, '45120', 'rear pads at 3 mm', 'approved']);
    expect(invalid(t, { lines: [] }, 'mechanic').errors).toHaveProperty('lines'); // never an empty invoice
    for (const bad of [{ first: 'X' }, { mechanic: 'Al' }, { deposits: [] }, { plate: 'X' }]) refuses(t, bad, 'mechanic');
    for (const st of ['waiting', 'review', 'filled']) refuses(tk({ status: st, mechanic: 'Mike' }), { notes: 'x' }, 'mechanic');
    // the desk is told a sent invoice changed on the phone...
    expect(t.mech_edit).toBe('2026-11-18T10:00:00');
    edit(t, { notes: 'seen' }, 'desk');
    expect(t.mech_edit).toBe(''); // ...until the desk saves it
    const zero = { lines: [{ desc: 'pads', id: 1 }] }; // every charge taken off: not from the phone
    expect(invalid(t, zero, 'mechanic').errors).toHaveProperty('lines');
    expect(invalid(t, zero, 'mechanic').errors['lines']).toBe(
      "the phone can't take every charge off a sent invoice; ask the desk",
    );
    expect(t.lines[0]?.price).toBe(100);
    expect(edit(t, zero, 'desk').lines[0]?.price).toBeNull(); // the desk may (warranty work)
    // $0 already: lines still theirs
    expect(edit(t, { lines: [{ desc: 'pads', id: 1 }, { desc: 'note' }] }, 'mechanic').mech_edit).toBeTruthy();
    // a sent invoice keeps its mechanic
    expect(invalid(t, { mechanic: ' ' }, 'desk').errors).toHaveProperty('mechanic');
    const w = tk({ status: 'working', mechanic: 'Mike' });
    expect(edit(w, { notes: 'x' }, 'mechanic').mech_edit).toBe(''); // only after it was sent
  });

  it('desk and mechanic', () => {
    const t = tk({ status: 'waiting', first: 'JANE', last: 'DOE', phone: '(555)010-0000', plate: 'XKS-4827' });
    edit(t, { first: 'janet', notes: 'call first', color: 'red' }, 'desk');
    expect([t.first, t.last, t.plate, t.notes]).toEqual(['JANET', 'DOE', 'XKS-4827', 'call first']);
    expect(t).not.toHaveProperty('color');
    expect(edit(t, { mechanic: 'Mike' }, 'desk').mechanic).toBe('Mike'); // the desk may fix any field
    expect(new Set(Object.keys(invalid(t, { phone: '123', last: '' }, 'desk').errors))).toEqual(new Set(['phone', 'last']));
    expect([t.phone, t.last]).toEqual(['(555)010-0000', 'DOE']);
    refuses(t, { notes: 'x' }, 'mechanic');
    t.status = 'working';
    expect(edit(t, { first: 'janet', odometer: '98,000' }, 'desk').odometer).toBe('98000'); // the desk's until filled
    // the desk can fix prices until the ticket is filled
    const a = tk({ status: 'approved', lines: [line('pads', { price: 100, labor: 100, code: 'FBP', id: 1 })] });
    expect(
      edit(a, { lines: [{ desc: 'pads', price: 90, labor: 80, code: 'FBP', id: 1 }] }, 'desk').lines[0]?.price,
    ).toBe(90);
    expect(invalid(a, { lines: [] }, 'desk').errors).toHaveProperty('lines');
    expect(a.lines[0]?.price).toBe(90);
    refuses(tk({ status: 'filled', lines: [line('pads', { price: 100, id: 1 })] }), { lines: [] }, 'desk');
    edit(t, { lines: [{ desc: 'oil', price: 30 }], odometer: '98,431', status: 'filled' }, 'mechanic');
    expect(t.lines).toEqual([{ desc: 'oil', qty: 1, price: 30, labor: null, code: '', id: 1 }]);
    expect([t.odometer, t.status]).toEqual(['98431', 'working']);
    expect(refuses(t, { first: 'x', notes: 'y' }, 'mechanic').message).toContain('first');
    expect([t.first, t.notes]).toEqual(['JANET', 'call first']);
    t.status = 'review';
    refuses(t, { notes: 'x' }, 'mechanic');
    expect(invalid(t, { lines: [] }, 'desk').errors).toHaveProperty('lines'); // review keeps at least one line
    edit(t, { lines: [{ desc: 'oil', price: 35 }] }, 'desk');
    expect([t.lines[0]?.price, t.odometer]).toEqual([35, '98431']);
  });

  it('refusal messages', () => {
    expect(refuses(tk({ status: 'filled' }), { notes: 'x' }, 'desk').message).toBe("the desk can't change a filled ticket");
    expect(refuses(tk({ status: 'review' }), { notes: 'x' }, 'mechanic').message).toBe("the phone can't change a review ticket");
    expect(refuses(tk({ status: 'working' }), { plate: 'x', first: 'y', notes: 'z' }, 'mechanic').message).toBe(
      "the phone can't change first, plate",
    );
  });

  it('an unknown who is a plain Error', () => {
    const e = thrown(() => edit(tk(), {}, 'customer' as 'desk'));
    expect(e).not.toBeInstanceOf(Refused);
    expect(e.message).toBe("who must be desk or mechanic, not 'customer'");
  });

  it('Invalid joins its errors', () => {
    const e = invalid(tk({ status: 'waiting' }), { phone: '123', last: '' }, 'desk');
    expect(e.message).toBe('phone: phone needs 10 digits; last: last is required');
  });

  it('old stored deposits keep their dates', () => {
    const old = isoDay(addDays(TODAY, -730));
    const t = tk({ status: 'approved', lines: [line('x', { labor: 1 })], deposits: [deposit(100, { date: old, id: 1 })] });
    edit(t, { deposits: [{ amount: 100, method: 'cash', date: old, id: 1 }, { amount: 5 }] }, 'desk'); // add one
    expect(t.deposits.map((x) => [x.id, x.date])).toEqual([
      [1, old],
      [2, isoDay(TODAY)],
    ]);
    edit(t, { deposits: [{ amount: 100, date: old, id: 1 }] }, 'desk'); // remove the new one
    expect(t.deposits.map((x) => x.id)).toEqual([1]);
    for (const bad of [
      { amount: 5, date: old },
      { amount: 5, date: old, id: 9 },
    ]) {
      // new, so the window applies
      const e = invalid(t, { deposits: [{ amount: 100, date: old, id: 1 }, bad] }, 'desk');
      expect(e.errors['deposits']).toContain('within a year');
    }
    expect(invalid(t, { deposits: [{ amount: 100, date: '2024-02-30', id: 1 }] }, 'desk').errors['deposits']).toContain(
      'real day',
    );
    edit(t, { deposits: [] }, 'desk');
    expect(t.deposits).toEqual([]);
  });

  it('deposits are the desk\'s, until filled', () => {
    const dep = { deposits: [{ amount: 200, method: 'cash', date: YESTERDAY }] };
    for (const st of ['waiting', 'working', 'review', 'approved']) {
      const t = tk({ status: st, lines: [line('x', { labor: 1 })] });
      edit(t, dep, 'desk');
      expect(t.deposits).toEqual([deposit(200, { date: YESTERDAY, id: 1 })]);
    }
    let t = tk({ status: 'working', lines: [line('x', { labor: 1 })] });
    expect(refuses(t, dep, 'mechanic').message).toContain('deposits');
    refuses(t, { ...dep, notes: 'x' }, 'mechanic');
    expect([t.deposits, t.notes]).toEqual([[], '']);
    edit(t, { ...dep, version: 3, color: 'red' }, 'desk'); // unknown keys don't count
    expect(t.deposits).toHaveLength(1);
    refuses(tk({ status: 'filled' }), dep, 'desk');
    t = tk({ status: 'review', lines: [line('x', { labor: 1 })], deposits: [deposit(5, { id: 1 }), deposit(6, { id: 2 })] });
    edit(t, { deposits: [{ amount: 6, id: 2 }] }, 'desk'); // removing one
    expect(t.deposits.map((x) => x.id)).toEqual([2]);
    expect(invalid(t, { deposits: [{ amount: 0 }] }, 'desk').errors).toHaveProperty('deposits');
    expect(t.deposits.map((x) => x.id)).toEqual([2]); // nothing half-applied
    expect(normalize({ deposits: [] })).toEqual({ clean: { deposits: [] }, errors: {} });
  });
});

describe('totals', () => {
  it('rounds each line half-up to cents', () => {
    const t = tk({
      lines: [
        line('pads', { qty: 2, price: 45.555, labor: 80 }),
        line('diag', { labor: 60.1 }),
        line('wiper', { qty: 3, price: 0.1 }),
      ],
    });
    // no tax: InvoMax adds it
    expect(totals(t)).toEqual({ parts: 91.41, labor: 140.1, total: 231.51, deposits: 0 });
    expect(Object.keys(totals(t))).toEqual(['parts', 'labor', 'total', 'deposits']); // shown in this order
    expect(totals(tk())).toEqual({ parts: 0, labor: 0, total: 0, deposits: 0 });
    expect(totals(tk({ lines: [line('x', { qty: 1.5, price: 3.33 }), line('y', { labor: 1.005 })] })).total).toBe(6.01);
    // each line is rounded first: 0.015 -> 0.02 twice, not 0.03 -> 0.03
    expect(
      totals(tk({ lines: [line('a', { qty: 1.5, price: 0.01 }), line('b', { qty: 1.5, price: 0.01 })] })).parts,
    ).toBe(0.04);
  });

  it('qty 1.5 at 33.33 is 50.00 of parts', () => {
    expect(totals(tk({ lines: [line('x', { qty: 1.5, price: 33.33 })] })).parts).toBe(50);
  });

  it('keeps tiny and huge numbers exact', () => {
    expect(totals(tk({ lines: [line('x', { qty: 1e-7, price: 1 })] })).parts).toBe(0);
    expect(totals(tk({ lines: [line('x', { qty: 10000, price: 1e6 })] })).parts).toBe(1e10);
  });

  it('adds deposits in cents', () => {
    const t = tk({
      lines: [line('x', { labor: 100 })],
      deposits: [deposit(80, { date: '2026-11-01' }), deposit(20.5, { method: 'card', date: '2026-11-02' })],
    });
    // paying past the total is kept as is
    expect(totals(t)).toEqual({ parts: 0, labor: 100, total: 100, deposits: 100.5 });
    t.deposits.push(deposit(0.1));
    expect(totals(t).deposits).toBe(100.6); // in cents, no float drift
  });
});
