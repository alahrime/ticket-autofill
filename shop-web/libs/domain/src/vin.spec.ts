import { edit, newTicket, normalize, Refused, vinValid, vinWarning } from './index.js';
import { thrown, tk } from './testing.js';

// made-up VINs: 2T1BR32614C809083 and 1HGCM82633A004352 pass the check digit
describe('vin', () => {
  it('is empty on a new ticket and normalized as typed', () => {
    expect(newTicket({}, '').vin).toBe('');
    expect(normalize({ vin: ' 2t1br 3261\t4c809083 ' })).toEqual({ clean: { vin: '2T1BR32614C809083' }, errors: {} });
    // wrong: stored as typed, no error
    expect(normalize({ vin: '1hgcm82633a00435' })).toEqual({ clean: { vin: '1HGCM82633A00435' }, errors: {} });
    expect(normalize({ vin: '0O1I' }).clean.vin).toBe('0O1I'); // no lookalike swaps for typing
    expect(normalize({ vin: 'X'.repeat(81) }).errors).toHaveProperty('vin');
    expect(normalize({ vin: '﻿2T1BR32614C809083\x1f' }).clean.vin).toBe('2T1BR32614C809083');
    expect(normalize({ vin: 'ß'.repeat(50) }).errors).toHaveProperty('vin'); // 100 characters once upper-cased
  });

  it('vinValid checks the digit', () => {
    expect(vinValid('2T1BR32614C809083')).toBe(true);
    expect(vinValid('1HGCM82633A004352')).toBe(true);
    expect(vinValid('1HGCM82634A004352')).toBe(false);
    expect(vinValid('1HGCM82633A00435')).toBe(false);
    expect(vinValid('1HGCM82633A0O4352')).toBe(false);
    expect(vinValid('1HGCM82633A00435²')).toBe(false); // ASCII only
    expect(vinValid('')).toBe(false);
    const t0 = performance.now();
    expect(vinValid('1'.repeat(5_000_000))).toBe(false); // wrong length: no scan
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('vinWarning says why', () => {
    expect(vinWarning('')).toBe('');
    expect(vinWarning('2T1BR32614C809083')).toBe('');
    expect(vinWarning('1HGCM82633A004352')).toBe('');
    expect(vinWarning('1HGCM82633A00435')).toBe('VIN has 16 characters, not 17');
    expect(vinWarning('1')).toBe('VIN has 1 character, not 17');
    expect(vinWarning('1HGCM82634A004352')).toBe('VIN check digit fails');
    expect(vinWarning("1HGCM82633A0O4352")).toBe("VIN can't have I, O or Q (1 or 0?)");
    for (const odd of ['1HGCM82633A00435²', '1HGCM82633A00435①', '１HGCM82633A004352', '1HGCM-82633A00435']) {
      // no crash, never valid
      expect(vinWarning(odd)).toBe('VIN has characters other than letters and digits');
    }
  });

  it('is the mechanic\'s own job, and the desk\'s until filled', () => {
    expect(edit(tk({ status: 'working', mechanic: 'Sam' }), { vin: '2t1br32614c809083' }, 'mechanic').vin).toBe(
      '2T1BR32614C809083',
    );
    expect(edit(tk({ status: 'approved', mechanic: 'Sam' }), { vin: '2t1br32614c809083' }, 'mechanic').vin).toBeTruthy();
    for (const st of ['waiting', 'working', 'review', 'approved']) {
      expect(edit(tk({ status: st }), { vin: '1hgcm82633a004352' }, 'desk').vin).toBe('1HGCM82633A004352');
    }
    for (const st of ['waiting', 'review', 'filled']) {
      expect(thrown(() => edit(tk({ status: st }), { vin: 'x' }, 'mechanic'))).toBeInstanceOf(Refused);
    }
    for (const who of ['desk', 'mechanic'] as const) {
      expect(thrown(() => edit(tk({ status: 'filled' }), { vin: '1HGCM82633A004352' }, who))).toBeInstanceOf(Refused);
    }
  });
});
