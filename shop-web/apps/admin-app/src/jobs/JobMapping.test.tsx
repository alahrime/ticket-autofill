import type { JobGroup } from '@shop/api-client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Call, callsTo, mockFetch, renderWithClient } from '../test-utils';
import { coverageText, JobMapping, percent } from './JobMapping';

const PADS: JobGroup = {
  im_code: 'LABOR',
  words: ['FRONT', 'PADS'],
  lines: 12,
  dollars: 1080.5,
  samples: ['REPLACE FRONT PADS', 'FRONT PADS AND ROTORS'],
  proposed: { job: 'FBP', words: ['FRONT', 'PADS'] },
  rule: null,
};
const OIL: JobGroup = {
  im_code: 'OIL',
  words: [],
  lines: 5,
  dollars: 200,
  samples: ['OIL CHANGE'],
  proposed: { job: 'OIL', words: [] },
  rule: null,
};
const NOPE: JobGroup = { ...OIL, im_code: 'ZZZ', proposed: null, samples: [] };

const GEN: JobGroup = {
  im_code: 'LABOR',
  words: ['BRAKE', 'PADS', 'REAR', 'REPLACE'],
  lines: 4,
  dollars: 100,
  samples: ['REPLACE REAR BRAKE PADS'],
  proposed: { job: 'RBP', words: ['REAR'] }, // fewer words than the group's own
  rule: null,
};

type Stored = { im_code: string; words: string[]; job: string; made_by: string; made_at: string };
type Held = { body: { im_code: string; words: string[]; job?: string }; release(): void };

let calls: Call[];
let groups: JobGroup[];
let rules: Stored[];
let putAnswer: [number, unknown] | null;
let held: Held[]; // POSTs held until a test releases them
let hold: boolean;

const sameWords = (a: string[], b: string[]): boolean => a.length === b.length && a.every((w) => b.includes(w));
const stored = (im_code: string, words: string[], job: string): Stored => ({
  im_code,
  words,
  job,
  made_by: 'admin#1',
  made_at: '2026-11-21T10:00:00',
});
/** A rule maps a group when it has the group's code and each of the rule's words is in the group's. */
const mapsGroup = (r: Stored, g: JobGroup): boolean => r.im_code === g.im_code && r.words.every((w) => g.words.includes(w));
const mappedLines = (): number => groups.filter((g) => rules.some((r) => mapsGroup(r, g))).reduce((n, g) => n + g.lines, 0);

beforeEach(() => {
  window.history.replaceState(null, '', '/jobs');
  groups = [PADS, OIL, NOPE, GEN];
  rules = [];
  putAnswer = null;
  held = [];
  hold = false;
  calls = mockFetch((method, url, body) => {
    const path = url.split('?')[0];
    if (method === 'GET' && path === '/api/job-map') {
      const open = groups.filter((g) => !rules.some((r) => mapsGroup(r, g)));
      const lines = groups.reduce((n, g) => n + g.lines, 0);
      const dollars = groups.reduce((n, g) => n + g.dollars, 0);
      const done = groups.filter((g) => rules.some((r) => mapsGroup(r, g)));
      return [
        200,
        {
          groups: open,
          coverage: { lines, mapped_lines: mappedLines(), dollars, mapped_dollars: done.reduce((n, g) => n + g.dollars, 0) },
          page: 1,
        },
      ];
    }
    if (method === 'GET' && path === '/api/job-map/rules') return [200, { rules }];
    if (method === 'GET' && path === '/api/catalog') {
      const q = new URL(url, 'http://x').searchParams.get('q') ?? '';
      const all = [
        { code: 'FBP', description: 'FRONT BRAKE PADS', part_price: 50, labor_price: 90 },
        { code: 'RBP', description: 'REAR BRAKE PADS', part_price: 50, labor_price: 90 },
      ];
      return [200, all.filter((h) => `${h.code} ${h.description}`.includes(q.toUpperCase()))];
    }
    if (method === 'POST' && path === '/api/job-map') {
      if (putAnswer) return putAnswer;
      const b = body as { im_code: string; words: string[]; job: string };
      rules = [...rules.filter((r) => !(r.im_code === b.im_code && sameWords(r.words, b.words))), stored(b.im_code, b.words, b.job)];
      return [200, { rule: { id: 1, ...stored(b.im_code, b.words, b.job) } }];
    }
    if (method === 'POST' && path === '/api/job-map/delete') {
      const b = body as { im_code: string; words: string[] };
      const had = rules.length;
      rules = rules.filter((r) => !(r.im_code === b.im_code && sameWords(r.words, b.words)));
      return [200, { deleted: rules.length < had }];
    }
    return undefined;
  });
  // POSTs wait here while `hold` is on, so a test sees the page mid-request
  const inner = fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (!hold || init?.method !== 'POST') return inner(input, init);
    return new Promise<Response>((done) => {
      const body = JSON.parse(String(init.body)) as Held['body'];
      held.push({ body, release: () => done(inner(input, init)) });
    });
  });
});
afterEach(() => vi.unstubAllGlobals());

const card = (name: RegExp) => screen.findByRole('group', { name });
const puts = () => callsTo(calls, 'POST', '/api/job-map');

describe('coverage text', () => {
  it('rounds to whole percents', () => {
    expect(coverageText({ lines: 3, mapped_lines: 2, dollars: 1000, mapped_dollars: 740 })).toBe(
      'Mapped: 67% of lines, 74% of dollars',
    );
  });
  it('is 0% with nothing to count, never NaN', () => {
    expect(percent(0, 0)).toBe(0);
    expect(coverageText({ lines: 0, mapped_lines: 0, dollars: 0, mapped_dollars: 0 })).toBe(
      'Mapped: 0% of lines, 0% of dollars',
    );
  });
});

describe('JobMapping', () => {
  it('shows the coverage and each unmapped group with its facts and proposal', async () => {
    renderWithClient(<JobMapping />);
    expect(await screen.findByText('Mapped: 0% of lines, 0% of dollars')).toBeInTheDocument();
    const c = await card(/LABOR — FRONT PADS/);
    expect(c).toHaveTextContent('12 lines');
    expect(c).toHaveTextContent('$1,080.50');
    expect(c).toHaveTextContent('REPLACE FRONT PADS');
    expect(c).toHaveTextContent('Proposed job: FBP');
    expect(callsTo(calls, 'GET', '/api/job-map')[0]?.url).toContain('unmapped=1');
  });

  it('Accept posts the proposal, and the group leaves the list while the coverage goes up', async () => {
    const user = userEvent.setup();
    renderWithClient(<JobMapping />);
    await user.click(within(await card(/LABOR — FRONT PADS/)).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({ im_code: 'LABOR', words: ['FRONT', 'PADS'], job: 'FBP' });
    await waitFor(() => expect(screen.queryByRole('group', { name: /LABOR — FRONT PADS/ })).not.toBeInTheDocument());
    expect(await screen.findByText('Mapped: 46% of lines, 68% of dollars')).toBeInTheDocument();
  });

  it('a group with no proposal cannot be accepted', async () => {
    renderWithClient(<JobMapping />);
    const c = await card(/ZZZ/);
    expect(within(c).getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(c).toHaveTextContent('No proposal');
  });

  it('Ignore posts job ignore', async () => {
    const user = userEvent.setup();
    renderWithClient(<JobMapping />);
    await user.click(within(await card(/OIL/)).getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({ im_code: 'OIL', words: [], job: 'ignore' });
  });

  it('Change then Save posts the edited words, upper-cased, split on spaces and commas, each once', async () => {
    const user = userEvent.setup();
    renderWithClient(<JobMapping />);
    const c = await card(/LABOR — FRONT PADS/);
    await user.click(within(c).getByRole('button', { name: 'Change' }));
    const words = within(c).getByLabelText(/^Words/);
    expect(words).toHaveValue('FRONT PADS');
    await user.clear(words);
    await user.type(words, 'rear, pads  Rear,brake');
    await user.selectOptions(within(c).getByLabelText(/^Job/), 'ignore');
    await user.click(within(c).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({ im_code: 'LABOR', words: ['REAR', 'PADS', 'BRAKE'], job: 'ignore' });
  });

  it('the picker finds parts.csv codes with their descriptions', async () => {
    const user = userEvent.setup();
    renderWithClient(<JobMapping />);
    const c = await card(/LABOR — FRONT PADS/);
    await user.click(within(c).getByRole('button', { name: 'Change' }));
    expect(within(c).getByLabelText(/^Job/)).toHaveValue('FBP'); // pre-picked
    await user.type(within(c).getByLabelText(/^Find a job/), 'rear');
    await user.selectOptions(within(c).getByLabelText(/^Job/), 'RBP');
    await user.click(within(c).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toMatchObject({ job: 'RBP' });
  });

  it('shows the server refusal and keeps the form open', async () => {
    const user = userEvent.setup();
    putAnswer = [400, { error: 'too many rules' }];
    renderWithClient(<JobMapping />);
    const c = await card(/OIL/);
    await user.click(within(c).getByRole('button', { name: 'Change' }));
    await user.click(within(c).getByRole('button', { name: 'Save' }));
    expect(await within(c).findByRole('alert')).toHaveTextContent('too many rules');
    expect(within(c).getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('Accept on a group whose proposal has fewer words: that card is busy mid-request, and a refusal shows on it', async () => {
    const user = userEvent.setup();
    hold = true;
    renderWithClient(<JobMapping />);
    const c = await card(/LABOR — BRAKE PADS REAR REPLACE/);
    await user.click(within(c).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(held).toHaveLength(1));
    expect(held[0]?.body).toEqual({ im_code: 'LABOR', words: ['REAR'], job: 'RBP' }); // not the group's own words
    for (const name of ['Accept', 'Change', 'Ignore']) expect(within(c).getByRole('button', { name })).toBeDisabled();
    // another card is not held up by it
    expect(within(await card(/OIL/)).getByRole('button', { name: 'Accept' })).toBeEnabled();
    putAnswer = [400, { error: 'too many rules' }];
    held[0]?.release();
    expect(await within(c).findByRole('alert')).toHaveTextContent('too many rules');
    expect(within(c).getByRole('button', { name: 'Accept' })).toBeEnabled();
  });

  it('Change on a generic group with edited words: busy mid-request, and a refusal shows on the card', async () => {
    const user = userEvent.setup();
    renderWithClient(<JobMapping />);
    const c = await card(/LABOR — BRAKE PADS REAR REPLACE/);
    await user.click(within(c).getByRole('button', { name: 'Change' }));
    const words = within(c).getByLabelText(/^Words/);
    await user.clear(words);
    await user.type(words, 'rear, pads');
    hold = true;
    await user.click(within(c).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(held).toHaveLength(1));
    expect(held[0]?.body).toEqual({ im_code: 'LABOR', words: ['REAR', 'PADS'], job: 'RBP' });
    expect(within(c).getByRole('button', { name: 'Save' })).toBeDisabled();
    putAnswer = [400, { error: 'words must be up to 10 upper-case letters-and-digits words, each with a letter' }];
    held[0]?.release();
    expect(await within(c).findByRole('alert')).toHaveTextContent('words must be up to 10');
    expect(within(c).getByRole('button', { name: 'Save' })).toBeEnabled(); // the form stays open
  });

  it('two cards can be in flight at once: one finishing does not re-enable the other', async () => {
    const user = userEvent.setup();
    hold = true;
    renderWithClient(<JobMapping />);
    const gen = await card(/LABOR — BRAKE PADS REAR REPLACE/);
    const oil = await card(/OIL/);
    await user.click(within(gen).getByRole('button', { name: 'Accept' }));
    await user.click(within(oil).getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(held).toHaveLength(2));
    expect(within(gen).getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(within(oil).getByRole('button', { name: 'Accept' })).toBeDisabled();
    held.find((h) => h.body.im_code === 'OIL')?.release();
    await waitFor(() => expect(screen.queryByRole('group', { name: /OIL/ })).not.toBeInTheDocument());
    expect(within(gen).getByRole('button', { name: 'Accept' })).toBeDisabled(); // still running
    held.find((h) => h.body.im_code === 'LABOR')?.release();
    await waitFor(() => expect(screen.queryByRole('group', { name: /BRAKE PADS REAR REPLACE/ })).not.toBeInTheDocument());
  });

  it('Show mapped lists every rule, even with no live group or on an ordinary code, and Remove posts that rule', async () => {
    const user = userEvent.setup();
    rules = [
      stored('OLD', ['GONE'], 'FBP'), // no line has it any more
      stored('OIL', ['SYNTHETIC'], 'ignore'), // a word rule on an ordinary code
      stored('LABOR', ['FRONT', 'PADS'], 'FBP'),
    ];
    renderWithClient(<JobMapping />);
    await user.click(await screen.findByRole('checkbox', { name: 'Show mapped' }));
    expect(window.location.search).toBe('?mapped=1');
    const old = await card(/Rule OLD GONE/);
    expect(old).toHaveTextContent('Job: FBP');
    expect(old).toHaveTextContent('admin#1');
    expect(old).toHaveTextContent('2026-11-21 10:00:00');
    const oil = await card(/Rule OIL SYNTHETIC/);
    expect(oil).toHaveTextContent('Job: ignore');
    expect(screen.getAllByRole('group')).toHaveLength(3);
    await user.click(within(oil).getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/job-map/delete')).toHaveLength(1));
    expect(callsTo(calls, 'POST', '/api/job-map/delete')[0]?.body).toEqual({ im_code: 'OIL', words: ['SYNTHETIC'] });
    await waitFor(() => expect(screen.queryByRole('group', { name: /Rule OIL/ })).not.toBeInTheDocument());
    expect(screen.getAllByRole('group')).toHaveLength(2);
    // the rules, the groups and the coverage were fetched again
    expect(callsTo(calls, 'GET', '/api/job-map/rules').length).toBeGreaterThan(1);
    expect(callsTo(calls, 'GET', '/api/job-map').length).toBeGreaterThan(1);
  });

  it('the rule filter narrows by code or job', async () => {
    const user = userEvent.setup();
    rules = [stored('OLD', ['GONE'], 'FBP'), stored('OIL', [], 'ignore')];
    window.history.replaceState(null, '', '/jobs?mapped=1');
    renderWithClient(<JobMapping />);
    await user.type(await screen.findByLabelText('Filter by code or job'), 'fbp');
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.getByRole('group', { name: /Rule OLD/ })).toBeInTheDocument();
  });

  it('pages with Previous and Next when a page is full', async () => {
    const user = userEvent.setup();
    groups = Array.from({ length: 100 }, (_, i) => ({ ...OIL, im_code: `C${i}` }));
    renderWithClient(<JobMapping />);
    await screen.findByRole('group', { name: /C0/ });
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(callsTo(calls, 'GET', '/api/job-map').some((c) => c.url.includes('page=2'))).toBe(true));
    expect(window.location.search).toBe('?page=2');
  });
});
