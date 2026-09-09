/**
 * Static verification for `isTransportError` + `classifyWriteReadError`
 * (src/lib/transportError.ts). Plain data + runner, same convention as the
 * other *.cases.ts files.
 */
import { classifyWriteReadError, isTransportError } from '@/lib/transportError';

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

  /* ---- classifyWriteReadError (STEP 16-H2-C2-0) ---- */
  // The shared helper the card / custom-category / budget write services now
  // route every reconcile-read (and, via isTransportError, every primary
  // error) through. `describe` stands in for each service's own
  // `describeWriteError` (entity-specific copy).
  const describe = (e: { message?: string }) =>
    /network|fetch|timeout/i.test(e.message ?? '')
      ? '네트워크 연결을 확인한 뒤 다시 시도해주세요.'
      : '저장하지 못했어요. 잠시 후 다시 시도해주세요.';
  const NET = { message: 'TypeError: Network request failed', code: '' };
  const ABORT = { message: 'AbortError', hint: 'Request was aborted (timeout or manual cancellation)', code: '' };
  const RLS = { message: 'permission denied', code: '42501' };
  const HTTP500 = { message: 'Internal Server Error', code: '', status: 500 };
  const PGRST = { message: 'JWT expired', code: 'PGRST301' };
  const DUP = { message: 'duplicate key value violates unique constraint', code: '23505' };

  check(
    'CASE 14 classifyWriteReadError(null) -> undefined (fall through to gone/idempotent branches)',
    classifyWriteReadError(null, describe) === undefined &&
      classifyWriteReadError(undefined, describe) === undefined,
    '',
  );
  check(
    'CASE 15 transport readErr -> { transport:true } + friendly network copy',
    (() => {
      const c = classifyWriteReadError(NET, describe);
      return !!c && c.transport === true && c.message === '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
    })(),
    '',
  );
  check(
    'CASE 16 abort/timeout readErr -> transport:true',
    classifyWriteReadError(ABORT, describe)?.transport === true,
    '',
  );
  check(
    'CASE 17 RLS (42501) readErr -> transport:false (server verdict)',
    classifyWriteReadError(RLS, describe)?.transport === false,
    '',
  );
  check(
    'CASE 18 HTTP 500 readErr -> transport:false',
    classifyWriteReadError(HTTP500, describe)?.transport === false,
    '',
  );
  check(
    'CASE 19 PGRST auth readErr -> transport:false',
    classifyWriteReadError(PGRST, describe)?.transport === false,
    '',
  );
  check(
    'CASE 20 a 23505 is a server verdict -> transport:false (never queue-retried as transport)',
    classifyWriteReadError(DUP, describe)?.transport === false && isTransportError(DUP) === false,
    '',
  );
  check(
    'CASE 21 message is always the caller-provided friendly copy, never the raw error',
    classifyWriteReadError(HTTP500, describe)?.message === '저장하지 못했어요. 잠시 후 다시 시도해주세요.',
    '',
  );

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
