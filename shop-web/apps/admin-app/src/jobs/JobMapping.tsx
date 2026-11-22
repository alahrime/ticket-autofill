// /jobs: matching groups of InvoMax bill lines to our job codes (parts.csv), so the shop's own history can
// count them. The unmapped groups come biggest first, each with a proposed job: Accept it, Change it (the job
// and the description words the rule needs) or Ignore the group. "Show mapped" lists the rules, each removable.
// The toggle and the page live in the URL query. After any change the list and the coverage are fetched again.
import { keepPreviousData } from '@tanstack/react-query';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { type JobCoverage, type JobGroup, type ListJobMap200, type ListJobMapParams, useListJobMap } from '@shop/api-client';
import { errorText, money } from '../lib/format';
import { useQueryState } from '../lib/useQueryState';
import { IGNORE, JobPicker } from './JobPicker';
import { groupKey, type JobRuleChanges, parseWords, useJobRuleChanges } from './useJobRuleChanges';

const PER_PAGE = 100; // the API's page size: a shorter page is the last

/** Whole percent; 0 when there is nothing to count (never NaN). */
export const percent = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export const coverageText = (c: JobCoverage): string =>
  `Mapped: ${percent(c.mapped_lines, c.lines)}% of lines, ${percent(c.mapped_dollars, c.dollars)}% of dollars`;

const wordsText = (words: readonly string[]): string => (words.length ? words.join(' ') : 'any description');
const nameOf = (imCode: string, words: readonly string[]): string => (words.length ? `${imCode} ${words.join(' ')}` : imCode);

function Coverage({ c }: { c: JobCoverage }) {
  const id = useId();
  return (
    <section className="coverage" aria-labelledby={id}>
      <h2 id={id}>Coverage</h2>
      <p>{coverageText(c)}</p>
      <progress aria-label="Share of lines mapped" max={100} value={percent(c.mapped_lines, c.lines)} />
    </section>
  );
}

function ChangeForm({ group, changes, onDone }: { group: JobGroup; changes: JobRuleChanges; onDone(): void }) {
  const id = useId();
  const [words, setWords] = useState((group.proposed?.words ?? group.words).join(' '));
  const [job, setJob] = useState(group.proposed?.job ?? '');
  const [missing, setMissing] = useState(false);
  const key = groupKey(group.im_code, group.words);
  const name = nameOf(group.im_code, group.words);
  const busy = changes.busy === key;

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (!job) {
      setMissing(true);
      return;
    }
    setMissing(false);
    if (await changes.save(group.im_code, parseWords(words), job)) onDone();
  };

  return (
    <form className="change-form" aria-label={`Change the job for ${name}`} onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor={`${id}-words`}>Words (separate with spaces or commas)</label>
        <input
          id={`${id}-words`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={words}
          disabled={busy}
          onChange={(e) => setWords(e.target.value)}
        />
      </div>
      <JobPicker value={job} onChange={setJob} disabled={busy} context={name} />
      {missing && (
        <p className="error" role="alert">
          Pick a job, or ignore.
        </p>
      )}
      <div className="card-actions">
        <button type="submit" className="primary" disabled={busy}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function GroupFacts({ g }: { g: JobGroup }) {
  return (
    <>
      <p className="meta">
        {g.lines} {g.lines === 1 ? 'line' : 'lines'} · {money(g.dollars)}
      </p>
      {g.samples.length > 0 && (
        <ul className="samples" aria-label="Sample descriptions">
          {g.samples.map((s, i) => (
            <li key={`${i}-${s}`}>{s}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function UnmappedCard({ g, changes }: { g: JobGroup; changes: JobRuleChanges }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const key = groupKey(g.im_code, g.words);
  const busy = changes.busy === key;
  const p = g.proposed;

  return (
    <li>
      <div className="card" role="group" aria-labelledby={id}>
        <h3 id={id}>
          {g.im_code} — {wordsText(g.words)}
        </h3>
        <GroupFacts g={g} />
        <p className="proposal">
          {p ? (
            <>
              Proposed job: <strong>{p.job}</strong>
              {p.words.length > 0 && <> (words {p.words.join(' ')})</>}
            </>
          ) : (
            'No proposal: change it to pick a job, or ignore it.'
          )}
        </p>
        {changes.errorKey === key && changes.error && (
          <p className="error" role="alert">
            {changes.error}
          </p>
        )}
        {editing ? (
          <ChangeForm group={g} changes={changes} onDone={() => setEditing(false)} />
        ) : (
          <div className="card-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !p}
              onClick={() => p && void changes.save(g.im_code, p.words, p.job)}
            >
              Accept
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              Change
            </button>
            <button type="button" disabled={busy} onClick={() => void changes.save(g.im_code, g.words, IGNORE)}>
              Ignore
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function MappedCard({ g, changes }: { g: JobGroup; changes: JobRuleChanges }) {
  const id = useId();
  const rule = g.rule;
  if (!rule) return null;
  const key = groupKey(g.im_code, rule.words);
  return (
    <li>
      <div className="card" role="group" aria-labelledby={id}>
        <h3 id={id}>
          {g.im_code} — {wordsText(g.words)}
        </h3>
        <GroupFacts g={g} />
        <p className="proposal">
          Job: <strong>{rule.job}</strong>
          {rule.words.length > 0 && <> (rule words {rule.words.join(' ')})</>}
        </p>
        {changes.errorKey === key && changes.error && (
          <p className="error" role="alert">
            {changes.error}
          </p>
        )}
        <div className="card-actions">
          <button type="button" disabled={changes.busy === key} onClick={() => void changes.remove(g.im_code, rule.words)}>
            Remove
          </button>
        </div>
      </div>
    </li>
  );
}

export function JobMapping() {
  const listId = useId();
  const [query, setQuery] = useQueryState();
  const mapped = query.get('mapped') === '1';
  const pageText = query.get('page');
  const page = pageText && /^[1-9]\d{0,5}$/.test(pageText) ? Number(pageText) : 1;
  const params = useMemo<ListJobMapParams>(
    () => ({ unmapped: mapped ? '0' : '1', ...(page > 1 ? { page: String(page) } : {}) }),
    [mapped, page],
  );
  const q = useListJobMap(params, { query: { placeholderData: keepPreviousData } });
  const changes = useJobRuleChanges();
  const data = q.isError ? undefined : (q.data?.data as ListJobMap200 | undefined);
  // a page of all groups: the ones a rule maps are the mapped ones
  const shown = data ? (mapped ? data.groups.filter((g) => g.rule !== null) : data.groups) : [];
  const last = data ? data.groups.length < PER_PAGE : true;

  const goTo = (n: number): void => setQuery({ page: n > 1 ? String(n) : null }, { push: true });

  return (
    <>
      {data && <Coverage c={data.coverage} />}
      <section className="list" aria-labelledby={listId}>
        <div className="list-head">
          <h2 id={listId}>{mapped ? 'Mapped groups' : 'Unmapped groups'}</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={mapped}
              onChange={(e) => setQuery({ mapped: e.target.checked ? '1' : null, page: null }, { push: true })}
            />
            Show mapped
          </label>
        </div>
        {q.isPending && <p>Loading…</p>}
        {q.isError && (
          <p className="error" role="alert">
            {errorText(q.error)}
          </p>
        )}
        {data && !shown.length && (
          <p className="empty">
            {mapped
              ? page > 1
                ? 'No mapped groups on this page.'
                : 'No group is mapped yet.'
              : page > 1
                ? 'No groups on this page.'
                : 'Every group is mapped.'}
          </p>
        )}
        {shown.length > 0 && (
          <ul className="cards">
            {shown.map((g) =>
              mapped ? (
                <MappedCard key={groupKey(g.im_code, g.words)} g={g} changes={changes} />
              ) : (
                <UnmappedCard key={groupKey(g.im_code, g.words)} g={g} changes={changes} />
              ),
            )}
          </ul>
        )}
        {data && (page > 1 || !last) && (
          <nav className="pager" aria-label="Pages">
            <button type="button" disabled={page <= 1} onClick={() => goTo(page - 1)}>
              Previous
            </button>
            <span>Page {page}</span>
            <button type="button" disabled={last} onClick={() => goTo(page + 1)}>
              Next
            </button>
          </nav>
        )}
      </section>
    </>
  );
}
