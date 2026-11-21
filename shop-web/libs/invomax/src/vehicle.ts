// Vehicle text ("2019 Honda HR-V EX") and the keys the importer matches on.

/** The shape of the repo's vehicles.json: make -> model -> [first year, last year]. */
export type Vehicles = Record<string, Record<string, [number, number]>>;

export type ParsedVehicle = { year: number | null; make: string; model: string; trim: string };

const ALIASES: Record<string, string> = { CHEVY: 'CHEVROLET', VW: 'VOLKSWAGEN', MERCEDES: 'MERCEDES-BENZ' };

const squash = (s: string): string => s.toUpperCase().replace(/[\s-]+/g, '');

export function normalPlate(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function phoneDigits(s: string): string {
  return s.replace(/\D/g, '');
}

export function parseVehicle(text: string, v: Vehicles): ParsedVehicle {
  let words = text.trim().split(/\s+/).filter(Boolean);
  let year: number | null = null;
  if (words.length > 0 && /^\d{4}$/.test(words[0])) {
    year = Number(words[0]);
    words = words.slice(1);
  } else if (words.length > 0 && /^\d{2}$/.test(words[0])) {
    const yy = Number(words[0]);
    year = yy <= 40 ? 2000 + yy : 1900 + yy;
    words = words.slice(1);
  }

  const makes = new Map<string, string>(); // squashed name -> make
  for (const make of Object.keys(v)) makes.set(squash(make), make);
  for (const [alias, make] of Object.entries(ALIASES)) if (v[make]) makes.set(squash(alias), make);

  let make = '';
  let used = 0;
  for (let n = Math.min(3, words.length); n >= 1 && !make; n--) {
    const hit = makes.get(squash(words.slice(0, n).join(' ')));
    if (hit) {
      make = hit;
      used = n;
    }
  }
  if (!make) return { year, make: '', model: '', trim: words.join(' ') };

  const rest = words.slice(used);
  const models = new Map<string, string>();
  for (const m of Object.keys(v[make])) models.set(squash(m), m);
  let model = '';
  let modelWords = 0;
  for (let n = Math.min(4, rest.length); n >= 1 && !model; n--) {
    const hit = models.get(squash(rest.slice(0, n).join(' ')));
    if (hit) {
      model = hit;
      modelWords = n;
    }
  }
  return { year, make, model, trim: rest.slice(modelWords).join(' ') };
}
