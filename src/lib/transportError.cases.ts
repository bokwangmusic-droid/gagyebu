/**
 * Static verification for `isTransportError` (src/lib/transportError.ts).
 * Plain data + runner, same convention as the other *.cases.ts files.
 */
import { isTransportError } from '@/lib/transportError';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runTransportErrorCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // --- SHOULD be transport ---
  check(
    'CASE 1 postgrest offline (code "" + Network request failed)',
    isTransportError({
      message: 'TypeError: Network request failed',
      details: 'TypeError: Network request failed',
      hint: '',
      code: '',
    }) === true,
    '',
  );
  check(
    'CASE 2 fetch failed',
    isTransportError({ message: 'FetchError: request to https://x failed', code: '' }) === true,
    '',
  );
  check(
    'CASE 3 abort / timeout',
    isTransportError({ message: 'AbortError: The operation was aborted', hint: 'Request was aborted (timeout or manual cancellation)', code: '' }) === true,
    '',
  );
  check(
    'CASE 4 node econnrefused',
    isTransportError({ message: 'FetchError: connect ECONNREFUSED 127.0.0.1:443', code: '' }) === true,
    '',
  );
  check(
    'CASE 5 status 0 + network error',
    isTransportError({ message: 'Network Error', code: '', status: 0 }) === true,
    '',
  );

  // --- should NOT be transport ---
  check(
    'CASE 6 23505 unique violation',
    isTransportError({ message: 'duplicate key value violates unique constraint', code: '23505', details: 'Key (id)=(txn-1) already exists.' }) === false,
    '',
  );
  check(
    'CASE 7 RLS denial (42501)',
    isTransportError({ message: 'new row violates row-level security policy', code: '42501' }) === false,
    '',
  );
  check(
    'CASE 8 PostgREST no-rows (PGRST116)',
    isTransportError({ message: 'Results contain 0 rows', code: 'PGRST116' }) === false,
    '',
  );
  check(
    'CASE 9 real HTTP 500 with empty code',
    isTransportError({ message: 'Internal Server Error', code: '', status: 500 }) === false,
    '',
  );
  check(
    'CASE 10 server verdict mentioning "fetch" in text but has code',
    isTransportError({ message: 'could not fetch relation', code: '42P01' }) === false,
    '',
  );
  check(
    'CASE 11 null / non-object',
    isTransportError(null) === false && isTransportError('network') === false && isTransportError(undefined) === false,
    '',
  );
  check(
    'CASE 12 empty error object',
    isTransportError({ code: '', message: '', details: '', hint: '' }) === false,
    '',
  );
  check(
    'CASE 13 jwt expired (auth verdict, not transport)',
    isTransportError({ message: 'JWT expired', code: 'PGRST301' }) === false,
    '',
  );

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
