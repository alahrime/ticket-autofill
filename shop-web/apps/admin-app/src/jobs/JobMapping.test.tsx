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

let calls: Call[];
let groups: JobGroup[];
let putAnswer: [number, unknown] | null;

/** A group's rule, as the list sends it: the job and the words, no code. */
const rule = (words: string[], job: string): NonNullable<JobGroup['rule']> => ({ job, words });

beforeEach(() => {
  window.history.replaceState(null, '', '/jobs');
  groups = [PADS, OIL, NOPE];
  putAnswer = null;
  calls = mockFetch((method, url, body) => {
    const path = url.split('?')[0];
    if (method === 'GET' && path === '/api/job-map') {
      const unmapped = new URL(url, 'http://x').searchParams.get('unmapped') === '1';
      const mapped = groups.filter((g) => g.rule);
      const lines = groups.reduce((n, g) => n + g.lines, 0);
      const dollars = groups.reduce((n, g) => n + g.dollars, 0);
      return [
        200,
        {
          groups: unmapped ? groups.filter((g) => !g.rule) : groups,
          coverage: {
            lines,
            mapped_lines: mapped.reduce((n, g) => n + g.lines, 0),
            dollars,
            mapped_dollars: mapped.reduce((n, g) => n + g.dollars, 0),
          },
          page: 1,
        },
      ];
    }
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
      groups = groups.map((g) => (g.im_code === b.im_code ? { ...g, rule: rule(b.words, b.job) } : g));
      return [200, { rule: { id: 1, im_code: b.im_code, words: b.words, job: b.job, made_by: 'admin#1', made_at: '2026-11-21T10:00:00' } }];
    }
    if (method === 'POST' && path === '/api/job-map/delete') {
      const b = body as { im_code: string };
      groups = groups.map((g) => (g.im_code === b.im_code ? { ...g, rule: null } : g));
      return [200, { deleted: true }];
    }
    return undefined;
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
    await waitFor(() => expect(screen.queryByRole('group', { name: /LABOR/ })).not.toBeInTheDocument());
    expect(await screen.findByText('Mapped: 55% of lines, 73% of dollars')).toBeInTheDocument();
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

  it('Show mapped lists the rules, and Remove drops one', async () => {
    const user = userEvent.setup();
    groups = [{ ...PADS, rule: rule(['FRONT', 'PADS'], 'FBP') }, OIL];
    renderWithClient(<JobMapping />);
    await user.click(await screen.findByRole('checkbox', { name: 'Show mapped' }));
    const c = await card(/LABOR — FRONT PADS/);
    expect(c).toHaveTextContent('Job: FBP');
    expect(screen.queryByRole('group', { name: /OIL/ })).not.toBeInTheDocument();
    expect(window.location.search).toBe('?mapped=1');
    await user.click(within(c).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/job-map/delete')).toHaveLength(1));
    expect(callsTo(calls, 'POST', '/api/job-map/delete')[0]?.body).toEqual({ im_code: 'LABOR', words: ['FRONT', 'PADS'] });
    await waitFor(() => expect(screen.queryByRole('group', { name: /LABOR/ })).not.toBeInTheDocument());
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
