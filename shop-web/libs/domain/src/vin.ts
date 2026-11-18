// VIN check digit (read.vin_valid) and the warning text (tickets.vin_warning).

// transliteration and weights (49 CFR 565)
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 7, 9, 2, 3, 4, 5, 6, 7, 8, 9];
const T = new Map([...LETTERS].map((c, i) => [c, VALUES[i] as number]));
const W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const DIGITS = '0123456789';

export function vinValid(v: string): boolean {
  const cs = [...v]; // code points, as Python counts them
  if (cs.length !== 17 || cs.some((c) => !T.has(c) && !DIGITS.includes(c))) return false;
  const sum = cs.reduce((n, c, i) => n + (DIGITS.includes(c) ? Number(c) : (T.get(c) as number)) * (W[i] as number), 0);
  const s = sum % 11;
  return cs[8] === (s === 10 ? 'X' : String(s));
}

/** Why a VIN looks wrong ("" when empty or valid). Only ever a warning: the VIN is stored as typed. */
export function vinWarning(vin: string): string {
  if (!vin || vinValid(vin)) return '';
  if (!/^[A-Z0-9]+$/.test(vin)) return 'VIN has characters other than letters and digits';
  if (vin.length !== 17) return `VIN has ${vin.length} character${vin.length !== 1 ? 's' : ''}, not 17`;
  if (/[IOQ]/.test(vin)) return "VIN can't have I, O or Q (1 or 0?)";
  return 'VIN check digit fails';
}
