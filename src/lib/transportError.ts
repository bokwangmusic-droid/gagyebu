/**
 * Transport-failure classifier — STEP 16-H2-A1 §1.
 *
 * "Did the request fail to reach a verdict?" (network down, DNS, timeout,
 * connection dropped) — as opposed to "the server produced an answer, and it
 * was an error" (HTTP 4xx/5xx, a Postgres error, an RLS denial, a 23505, a
 * reconcile-read server error).
 *
 * ONLY transport failures may be enqueued by the Offline Write Queue. Every
 * other failure is terminal and must surface to the user exactly as it does
 * today.
 *
 * `@supabase/postgrest-js` v2.115 offline shape (dist/index.cjs ~L448): a
 * rejected `fetch` becomes
 *   { message: `${name}: ${msg}`   // e.g. "TypeError: Network request failed"
 *   , details: <stack / "FetchError: …\n\nCaused by: …">
 *   , hint: "" | "Request was aborted (timeout or manual cancellation)"
 *   , code: ""                     // <- ALWAYS empty for transport failures
 *   }
 * A server-produced error always carries a non-empty `code`
 * (`'23505'` / `'42501'` / `'PGRST116'` / …) and, at the fetch layer, a real
 * HTTP `status`.
 *
 * Pure. No Supabase, no React, no I/O.
 */

const SERVER_VERDICT_MARKERS = [
  'row-level security',
  'permission denied',
  'violates',
  'duplicate key',
  'jwt',
  'pgrst',
];

const TRANSPORT_MARKERS = [
  'network request failed',
  'failed to fetch',
  'fetcherror',
  'networkerror',
  'network error',
  'load failed', // WebKit offline fetch
  'unable to resolve host',
  'the internet connection appears to be offline',
  'timeout',
  'timed out',
  'request was aborted',
  'connection refused',
  'connection reset',
  'connection closed',
  'socket hang up',
  'econnrefused',
  'econnreset',
  'enotfound',
  'etimedout',
  'err_network',
  'err_internet_disconnected',
];

export function isTransportError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
    name?: unknown;
    status?: unknown;
  };

  // A Postgres / PostgREST error code means the server returned a verdict.
  if (typeof e.code === 'string' && e.code.trim() !== '') return false;
  if (typeof e.code === 'number' && Number.isFinite(e.code)) return false;

  // postgrest-js transport failures use status 0; a real HTTP status is a verdict.
  if (typeof e.status === 'number' && e.status >= 100) return false;

  const text = [e.message, e.details, e.hint, e.name]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  if (text === '') return false;

  // Server-verdict phrases that could otherwise co-occur with "fetch"/"network".
  if (SERVER_VERDICT_MARKERS.some((m) => text.includes(m))) return false;

  return TRANSPORT_MARKERS.some((m) => text.includes(m));
}
