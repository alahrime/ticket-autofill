// Job mapping (admin): InvoMax's line groups with their proposals and rules, how much is mapped, and adding or
// dropping a rule. Money out is dollars.
import { type Response, Router } from 'express';
import { BadInput } from '../errors';
import { validRequest } from '../http/contract';
import { depsOf } from '../http/deps';
import { jsonBody } from '../http/security';
import { checkWords, IGNORE } from '../jobs/jobmap';
import { queryValues, sessionIn, signedIn } from '../view';
import { loadParts } from './catalog';

export const GROUPS_PER_PAGE = 100;
export const MAX_CODE = 8;
export const MAX_WORDS = 10;
const WORD = /^[A-Z0-9]{1,40}$/; // checkWords then wants a letter in each

type Body = Record<string, unknown>;

const byOf = (res: Response): string => `admin#${sessionIn(res).user_id ?? ''}`;

function imCode(v: unknown): string {
  if (typeof v === 'string' && v.length >= 1 && v.length <= MAX_CODE) return v;
  throw new BadInput(`im_code must be 1 to ${MAX_CODE} characters`);
}

/** Up to MAX_WORDS words that checkWords keeps as sent (so delete finds exactly what put stored). */
function words(code: string, v: unknown): string[] {
  if (Array.isArray(v) && v.length <= MAX_WORDS && v.every((w) => typeof w === 'string' && WORD.test(w)))
    return checkWords(code, v as string[]);
  throw new BadInput(`words must be up to ${MAX_WORDS} upper-case letters-and-digits words`);
}

export function jobMapRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const admin = signedIn('admin');

  r.get('/api/job-map', admin, validRequest, (req, res) => {
    const url = req.originalUrl;
    const page = queryValues(url, 'page')[0] ?? '1';
    if (!/^[1-9]\d{0,5}$/.test(page)) throw new BadInput('page must be 1 or more');
    const unmapped = queryValues(url, 'unmapped')[0] ?? '0';
    if (unmapped !== '0' && unmapped !== '1') throw new BadInput('unmapped must be 0 or 1');
    const n = Number(page);
    const jobs = depsOf(req).jobs;
    const groups = jobs.groups({ unmappedOnly: unmapped === '1' }).slice((n - 1) * GROUPS_PER_PAGE, n * GROUPS_PER_PAGE);
    res.json({ groups, coverage: jobs.coverage(), page: n });
  });

  r.post('/api/job-map', admin, jsonBody, validRequest, (req, res) => {
    const d = req.body as Body;
    const code = imCode(d['im_code']);
    const w = words(code, d['words']);
    const job = d['job'];
    let codes: string[];
    try {
      codes = loadParts(depsOf(req).config.catalog).map((p) => p.code);
    } catch {
      codes = []; // parts.csv missing or malformed: only ignore
    }
    if (typeof job !== 'string' || (job !== IGNORE && !codes.includes(job)))
      throw new BadInput('job must be a parts.csv code or ignore');
    res.json({ rule: depsOf(req).jobs.map.put({ im_code: code, words: w, job }, byOf(res)) });
  });

  r.post('/api/job-map/delete', admin, jsonBody, validRequest, (req, res) => {
    const d = req.body as Body;
    const code = imCode(d['im_code']);
    res.json({ deleted: depsOf(req).jobs.map.remove(code, words(code, d['words'])) });
  });
  return r;
}
