// The page's URL query as React state: read with useQueryState(), change with its setter (which keeps the path
// and the #hash, and replaces the history entry unless asked to push one). Back and Forward update it too.
import { useCallback, useMemo, useSyncExternalStore } from 'react';

const CHANGED = 'shop:query-changed'; // our own pushState/replaceState: the browser sends no event for them

export type QueryPatch = Record<string, string | null | undefined>;
export type SetQuery = (patch: QueryPatch, opts?: { push?: boolean }) => void;

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

const search = (): string => window.location.search;
const pathname = (): string => window.location.pathname;

/** The URL as it would be with `patch` applied: '' or null drops a key. */
export function withQuery(patch: QueryPatch): string {
  const next = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === '') next.delete(k);
    else next.set(k, v);
  }
  const q = next.toString();
  return `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash}`;
}

export function useQueryState(): [URLSearchParams, SetQuery] {
  const text = useSyncExternalStore(subscribe, search, search);
  const params = useMemo(() => new URLSearchParams(text), [text]);
  const set = useCallback<SetQuery>((patch, opts = {}) => {
    const url = withQuery(patch);
    if (opts.push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return [params, set];
}

/** location.pathname, kept up to date across Back and Forward. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, pathname, pathname);
}
