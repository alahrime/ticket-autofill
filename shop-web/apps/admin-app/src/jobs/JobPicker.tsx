// A job picker: a labelled search box that looks up parts.csv (GET /api/catalog gives up to 8 matches for the
// text, none for nothing) above a labelled <select> of "ignore", the current pick and the matches.
import { useId, useMemo, useState } from 'react';
import { type Hint, useGetCatalog } from '@shop/api-client';

export const IGNORE = 'ignore';

type Props = {
  /** A parts.csv code, 'ignore', or '' for none yet. */
  value: string;
  onChange(job: string): void;
  disabled?: boolean;
  /** Names the pickers apart on a page of many ("for LABOR PADS"). */
  context: string;
};

export function JobPicker({ value, onChange, disabled, context }: Props) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [known, setKnown] = useState<Record<string, string>>({}); // code -> description, as seen so far
  const text = search.trim() || (value && value !== IGNORE ? value : '');
  const q = useGetCatalog(text ? { q: text } : undefined, { query: { enabled: text !== '' } });
  const reply = q.data?.data as Hint[] | undefined;
  const hints = useMemo(() => (text && reply ? reply : []), [text, reply]);

  const [seen, setSeen] = useState(hints);
  if (seen !== hints) {
    // new matches came in: remember their descriptions, so a pick keeps its description when the search changes
    setSeen(hints);
    if (hints.length) setKnown((k) => ({ ...k, ...Object.fromEntries(hints.map((h) => [h.code, h.description])) }));
  }

  const codes = hints.map((h) => h.code);
  if (value && value !== IGNORE && !codes.includes(value)) codes.unshift(value);
  const label = (code: string): string => (known[code] ? `${code} — ${known[code]}` : code);

  return (
    <div className="picker">
      <div className="field">
        <label htmlFor={`${id}-find`}>Find a job ({context})</label>
        <input
          id={`${id}-find`}
          type="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          value={search}
          disabled={disabled}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-job`}>Job ({context})</label>
        <select id={`${id}-job`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {value === '' && <option value="">Pick a job…</option>}
          <option value={IGNORE}>ignore (not a job)</option>
          {codes.map((c) => (
            <option key={c} value={c}>
              {label(c)}
            </option>
          ))}
        </select>
      </div>
      {q.isError && (
        <p className="error" role="alert">
          Could not look up parts.csv.
        </p>
      )}
    </div>
  );
}
