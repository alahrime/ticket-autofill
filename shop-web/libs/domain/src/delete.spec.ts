import { holdsDeposits, markDeleted, PURGE_DAYS, PURGED_FROM, purgeable, purgeOn, restore } from './delete.js';
import { nowIso } from './clean.js';
import { edit, move } from './rules.js';
import { Refused } from './ticket.js';
import { deposit, line, thrown, tk } from './testing.js';

const AT = '2026-03-02T10:00:00'; // no DST change in the 14 days after
const at = (s: string): Date => new Date(s); // no offset: local time, as nowIso writes it

describe('delete and restore', () => {
  it('round-trip keeps every other field', () => {
    const t = tk({ id: 7, status: 'working', first: 'JANE', mechanic: 'Al Fixit', lines: [line('diag', { labor: 60, id: 1 })], deposits: [deposit(100, { id: 1 })], version: 3, zz_future: 'x' });
    const before = structuredClone(t);
    expect(markDeleted(t, 'admin#1', AT)).toBe(t);
    expect(t).toEqual({ ...before, status: 'deleted', deleted_from: 'working', deleted_at: AT, deleted_by: 'admin#1' });
    expect(restore(t)).toBe(t);
    expect(t).toEqual(before);
    expect([t.deleted_at, t.deleted_by, t.deleted_from]).toEqual(['', '', '']);
  });

  it('works on every status but deleted', () => {
    for (const st of ['waiting', 'working', 'review', 'approved', 'filled']) {
      const t = markDeleted(tk({ status: st }), 'mechanic#3', AT);
      expect([t.status, t.deleted_from, t.deleted_by]).toEqual(['deleted', st, 'mechanic#3']);
    }
    const t = markDeleted(tk(), 'admin#1', AT);
    const e = thrown(() => markDeleted(t, 'admin#1', AT));
    expect([e instanceof Refused, e.message]).toEqual([true, 'already deleted']);
    expect(t.deleted_by).toBe('admin#1');
  });

  it("restore refuses a ticket that isn't deleted", () => {
    const e = thrown(() => restore(tk({ status: 'working' })));
    expect([e instanceof Refused, e.message]).toEqual([true, "it isn't deleted"]);
  });

  it('a deleted ticket is neither edited nor moved', () => {
    const t = markDeleted(tk({ status: 'approved', mechanic: 'Al Fixit', lines: [line('diag', { labor: 60 })] }), 'admin#1', AT);
    expect(thrown(() => edit(t, { notes: 'x' }, 'desk')).message).toBe("can't change a deleted ticket");
    expect(thrown(() => edit(t, { notes: 'x' }, 'mechanic')).message).toBe("the phone can't change a deleted ticket");
    for (const to of ['waiting', 'working', 'approved', 'filled'])
      expect(thrown(() => move(t, to, 'Al Fixit', 'n')).message).toBe(`can't go from deleted to ${to}`);
    expect(thrown(() => move(tk(), 'deleted', 'Al Fixit')).message).toBe("can't go from waiting to deleted");
    expect(t.status).toBe('deleted');
  });
});

describe('purgeable', () => {
  const del = (from: string, when = AT) => markDeleted(tk({ status: from }), 'admin#1', when);
  const after = (days: number, seconds: number): Date => {
    const d = at(AT);
    d.setDate(d.getDate() + days);
    d.setSeconds(d.getSeconds() + seconds);
    return d;
  };

  it('is 14 days after the delete', () => {
    expect(PURGE_DAYS).toBe(14);
    expect(PURGED_FROM).toEqual(['waiting', 'working', 'review']);
    for (const from of PURGED_FROM) {
      expect(purgeable(del(from), after(14, 1))).toBe(true);
      expect(purgeable(del(from), after(14, 0))).toBe(true);
      expect(purgeable(del(from), after(14, -1))).toBe(false);
    }
    expect(nowIso(after(14, 0))).toBe('2026-03-16T10:00:00');
  });

  it('never an approved or filled one, nor one not deleted', () => {
    for (const from of ['approved', 'filled']) expect(purgeable(del(from), after(400, 0))).toBe(false);
    expect(purgeable(tk({ status: 'waiting', deleted_from: 'waiting', deleted_at: AT }), after(400, 0))).toBe(false);
  });

  it('never one with a deposit (R10: the customer may come back for delayed parts)', () => {
    const paid = markDeleted(tk({ status: 'waiting', deposits: [deposit(100, { id: 1 })] }), 'admin#1', AT);
    expect(purgeable(paid, after(15, 0))).toBe(false);
    expect(purgeOn(paid)).toBeNull();
    const unpaid = del('waiting');
    expect(purgeable(unpaid, after(15, 0))).toBe(true); // no deposit: still purged
    expect(purgeOn(unpaid)).toBe('2026-03-16');
  });

  it('judges the deposits as stored when told: only missing or [] is deposit-free', () => {
    for (const stored of [{ amount: 100 }, null, '100', 0, [deposit(5)]]) expect(holdsDeposits(stored)).toBe(true);
    for (const stored of [undefined, []]) expect(holdsDeposits(stored)).toBe(false);
    const t = del('waiting'); // parsed as deposit-free ([]), but the stored value was damaged
    expect(purgeable(t, after(15, 0), true)).toBe(false);
    expect(purgeOn(t, true)).toBeNull();
    expect(purgeable(t, after(15, 0), false)).toBe(true);
    expect(purgeable(t, after(15, 0))).toBe(true); // by default, from t.deposits
  });

  it('never one whose delete time is missing or not a time', () => {
    for (const when of ['', 'yesterday', '2026-03-02', '2026-03-02T10:00:00Z', ' 2026-03-02T10:00:00'])
      expect(purgeable({ ...del('waiting'), deleted_at: when }, after(400, 0))).toBe(false);
  });
});
