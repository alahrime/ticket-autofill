// The fetch every generated hook uses (Orval's mutator): the session cookie (same origin only), JSON in and
// out, and a reply of 400 or more thrown as ApiError so TanStack Query shows it as the query's error.

/** The JSON of a refused request: {error}, and for bad fields {error, errors} (field -> message). */
export type ErrorBody = { error?: string; errors?: Record<string, string> };

/** A reply the server refused: its status and its JSON (undefined when it wasn't JSON). */
export class ApiError<T = ErrorBody> extends Error {
  readonly status: number;
  readonly data: T | undefined;
  constructor(status: number, data: T | undefined) {
    const error = (data as ErrorBody | undefined)?.error;
    super(typeof error === 'string' ? error : `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/** What Orval's generated hooks see as an error: T is the refused replies' JSON the spec gives. */
export type ErrorType<T> = ApiError<T>;
/** A request body, as the generated hooks pass it. */
export type BodyType<T> = T;

/**
 * Orval's fetch mutator: resolves with { data, status, headers } (the generated reply types) for any status
 * below 400 (304 included, with no data); throws ApiError otherwise.
 */
export async function shopFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'same-origin' });
  const text = res.status === 204 || res.status === 304 ? '' : await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined; // not JSON (a proxy's error page): the status says enough
  }
  if (res.status >= 400) throw new ApiError(res.status, data as ErrorBody | undefined);
  return { data, status: res.status, headers: res.headers } as T;
}
