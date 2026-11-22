// /bills: the tickets that still need their bill, then every bill and filled ticket searched by tag, name,
// phone, VIN and dates, 50 a page. The filters, the page and the open row live in the URL query, so Back,
// reload and a shared link all show the same thing. A row opens beside the table (below it on a phone).
import { keepPreviousData } from '@tanstack/react-query';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { type BillRow, type ListInvoices200, type ListInvoicesParams, useListInvoices } from '@shop/api-client';
import { errorText, money } from '../lib/format';
import { useQueryState } from '../lib/useQueryState';
import { BillDetail } from './BillDetail';
import { NeedsBill } from './NeedsBill';

type Filter = keyof Omit<ListInvoicesParams, 'page'>;

const FILTERS: ReadonlyArray<{ name: Filter; label: string; type: 'text' | 'tel' | 'date'; max?: number; note?: string }> = [
  { name: 'tag', label: 'Tag', type: 'text', max: 20 },
  { name: 'name', label: 'Name', type: 'text', max: 80 },
  { name: 'phone', label: 'Phone', type: 'tel', max: 20 },
  { name: 'vin', label: 'VIN', type: 'text', max: 17, note: 'InvoMax keeps no VIN: this searches our tickets only.' },
  { name: 'from', label: 'From', type: 'date' },
  { name: 'to', label: 'To', type: 'date' },
];
const NAMES = FILTERS.map((f) => f.name);

type Draft = Record<Filter, string>;

const draftOf = (q: URLSearchParams): Draft =>
  Object.fromEntries(NAMES.map((n) => [n, q.get(n) ?? ''])) as Draft;

/** The request's parameters from the URL, in the filters' order, blanks left out. */
function paramsOf(q: URLSearchParams): ListInvoicesParams {
  const p: ListInvoicesParams = {};
  for (const n of NAMES) {
    const v = q.get(n)?.trim();
    if (v) p[n] = v;
  }
  const page = q.get('page');
  if (page && /^[1-9]\d{0,5}$/.test(page) && page !== '1') p.page = page;
  return p;
}

function Filters({ query, onSearch }: { query: URLSearchParams; onSearch(d: Draft | null): void }) {
  const id = useId();
  const fromUrl = useMemo(() => draftOf(query), [query]);
  const [draft, setDraft] = useState<Draft>(fromUrl);
  const [seen, setSeen] = useState(fromUrl);
  if (seen !== fromUrl) {
    // the URL changed under the form (Back, Clear): show what it says now
    setSeen(fromUrl);
    setDraft(fromUrl);
  }

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    onSearch(draft);
  };

  return (
    <form className="filters" role="search" aria-label="Search bills" onSubmit={submit}>
      {FILTERS.map((f) => (
        <div className="field" key={f.name}>
          <label htmlFor={`${id}-${f.name}`}>{f.label}</label>
          <input
            id={`${id}-${f.name}`}
            name={f.name}
            type={f.type}
            maxLength={f.max}
            autoComplete="off"
            spellCheck={false}
            value={draft[f.name]}
            aria-describedby={f.note ? `${id}-${f.name}-note` : undefined}
            onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
          />
          {f.note && (
            <small id={`${id}-${f.name}-note`} className="note">
              {f.note}
            </small>
          )}
        </div>
      ))}
      <div className="actions">
        <button type="submit" className="primary">
          Search
        </button>
        <button type="button" onClick={() => onSearch(null)}>
          Clear
        </button>
      </div>
    </form>
  );
}

function OpenButton({ row, onOpen }: { row: BillRow; onOpen(): void }) {
  const what = row.invoice_no ? `bill ${row.invoice_no}` : `ticket #${row.ticket_id ?? ''}`;
  return (
    <button
      type="button"
      className="link"
      onClick={(e) => {
        e.stopPropagation(); // the row's own click would open it again
        onOpen();
      }}
    >
      <span className="sr-only">Open {what}</span>
      <span aria-hidden="true">{row.invoice_no ?? `Ticket #${row.ticket_id ?? ''}`}</span>
    </button>
  );
}

function Results({
  rows,
  openKey,
  onOpen,
  labelledBy,
}: {
  rows: BillRow[];
  openKey: string | null;
  onOpen(key: string): void;
  labelledBy: string;
}) {
  return (
    <div className="table-wrap">
      <table className="results" aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Invoice</th>
            <th scope="col">Name</th>
            <th scope="col">Vehicle</th>
            <th scope="col">Plate</th>
            <th scope="col" className="num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            // a mouse can click anywhere on the row; the keyboard uses the row's Open button
            <tr key={r.key} className={r.key === openKey ? 'selected' : undefined} onClick={() => onOpen(r.key)}>
              <td>{r.date}</td>
              <td>
                <OpenButton row={r} onOpen={() => onOpen(r.key)} />
              </td>
              <td>{r.name}</td>
              <td>{r.vehicle}</td>
              <td>{r.plate}</td>
              <td className="num">
                {r.total === null ? (
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">no bill yet</span>
                  </>
                ) : (
                  money(r.total)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BillHistory() {
  const resultsId = useId();
  const [query, setQuery] = useQueryState();
  const params = useMemo(() => paramsOf(query), [query]);
  const openKey = query.get('open');
  const [focusDetail, setFocusDetail] = useState(false);
  const q = useListInvoices(params, { query: { placeholderData: keepPreviousData } });
  const list = q.isError ? undefined : (q.data?.data as ListInvoices200 | undefined);
  const page = list?.page ?? 1;
  const pages = list ? Math.max(1, Math.ceil(list.total / list.per_page)) : 1;

  const search = (d: Draft | null): void => {
    const patch: Record<string, string | null> = { page: null };
    for (const n of NAMES) patch[n] = d ? d[n].trim() || null : null;
    setQuery(patch, { push: true });
  };
  const open = (key: string | null, focus = true): void => {
    setFocusDetail(focus);
    setQuery({ open: key });
  };
  const goTo = (n: number): void => setQuery({ page: n > 1 ? String(n) : null }, { push: true });

  return (
    <>
      <NeedsBill onOpen={(key) => open(key)} />
      <section className="search" aria-label="Search">
        <Filters query={query} onSearch={search} />
      </section>
      <div className={openKey ? 'split open' : 'split'}>
        <section className="list" aria-labelledby={resultsId}>
          <h2 id={resultsId}>Bills</h2>
          {q.isPending && <p>Loading…</p>}
          {q.isError && (
            <p className="error" role="alert">
              {errorText(q.error)}
            </p>
          )}
          {list && !list.rows.length && <p className="empty">No bills match these filters.</p>}
          {list && list.rows.length > 0 && (
            <>
              <Results rows={list.rows} openKey={openKey} onOpen={(k) => open(k)} labelledBy={resultsId} />
              <nav className="pager" aria-label="Pages">
                <button type="button" disabled={page <= 1} onClick={() => goTo(page - 1)}>
                  Previous
                </button>
                <span>
                  Page {page} of {pages} ({list.total} {list.total === 1 ? 'row' : 'rows'})
                </span>
                <button type="button" disabled={page >= pages} onClick={() => goTo(page + 1)}>
                  Next
                </button>
              </nav>
            </>
          )}
        </section>
        {openKey && (
          <BillDetail
            key={openKey} // another bill: a fresh detail (no open form, typed values or alert from the last one)
            billKey={openKey}
            focus={focusDetail}
            onKeyChange={(k) => open(k, false)}
            onClose={() => open(null, false)}
          />
        )}
      </div>
    </>
  );
}
