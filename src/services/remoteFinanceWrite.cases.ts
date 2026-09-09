/**
 * Static verification for STEP 16-H2-B1.1: the reconcile-read error
 * classification (`classifyReconcileReadError`) that
 * `createTransaction` (23505 path) / `updateTransaction` /
 * `softDeleteTransaction` (0-row paths) now route through, so the durable
 * offline queue can tell a retryable transport failure from a business
 * verdict.
 *
 * The full write flows call `supabase` directly and can't run here; the
 * ordering branches (`!existing` -> gone, `deleted_at` -> deleted/idempotent,
 * fields match -> idempotent success, else -> conflict) are UNCHANGED from
 * STEP 16-G2-B and covered by that step's contract + the STEP 16-G3-B4
 * two-device device tests. What changed — and is verified here — is the
 * `readErr` sub-branch.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { classifyReconcileReadError } from '@/services/remoteFinanceWrite';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const pgErr = (over: Partial<PostgrestError>): PostgrestError =>
  ({ message: '', details: '', hint: '', code: '', ...over } as PostgrestError);

// Shapes matching the H2-A1 transportError analysis.
const TRANSPORT_READ = pgErr({ message: 'TypeError: Network request failed', code: '' });
const TIMEOUT_READ = pgErr({ message: 'AbortError', hint: 'Request was aborted (timeout or manual cancellation)', code: '' });
const RLS_READ = pgErr({ message: 'permission denied for table transactions', code: '42501' });
const HTTP500_READ = pgErr({ message: 'Internal Server Error', code: '', details: '' });
const PGRST_READ = pgErr({ message: 'JWT expired', code: 'PGRST301' });

export async function runRemoteWriteReconcileCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // 1 — no read error -> undefined (fall through to the ordering branches)
  {
    const c = classifyReconcileReadError(null);
    check('CASE 1 null readErr -> undefined (ordering branches unaffected)', c === undefined, `${c}`);
  }

  // 2 — transport read error -> { reason:'error', transport:true }
  {
    const c = classifyReconcileReadError(TRANSPORT_READ);
    check(
      'CASE 2 transport readErr -> reason:error, transport:true',
      !!c && c.reason === 'error' && c.transport === true && typeof c.message === 'string',
      JSON.stringify(c),
    );
  }

  // 3 — timeout/abort read error -> transport:true
  {
    const c = classifyReconcileReadError(TIMEOUT_READ);
    check('CASE 3 timeout/abort readErr -> transport:true', !!c && c.transport === true, JSON.stringify(c));
  }

  // 4 — RLS (42501) read error -> reason:'error' but NOT transport
  {
    const c = classifyReconcileReadError(RLS_READ);
    check(
      'CASE 4 RLS readErr -> reason:error, transport:false (server verdict, not retryable)',
      !!c && c.reason === 'error' && c.transport === false,
      JSON.stringify(c),
    );
  }

  // 5 — HTTP 500 with empty code -> reason:'error', NOT transport
  {
    const c = classifyReconcileReadError(HTTP500_READ);
    check(
      'CASE 5 HTTP 500 readErr -> reason:error, transport:false',
      !!c && c.transport === false,
      JSON.stringify(c),
    );
  }

  // 6 — a PostgREST/auth verdict (PGRST301) -> NOT transport
  {
    const c = classifyReconcileReadError(PGRST_READ);
    check('CASE 6 PGRST readErr -> transport:false', !!c && c.transport === false, JSON.stringify(c));
  }

  // 7 — message is friendly, never raw (mirrors describeWriteError)
  {
    const c = classifyReconcileReadError(TRANSPORT_READ);
    check(
      'CASE 7 message is friendly network copy, not the raw error string',
      !!c && c.message === '네트워크 연결을 확인한 뒤 다시 시도해주세요.',
      JSON.stringify(c),
    );
  }
  {
    const c = classifyReconcileReadError(HTTP500_READ);
    check(
      'CASE 7b non-network readErr -> generic friendly copy',
      !!c && c.message === '거래를 저장하지 못했어요. 잠시 후 다시 시도해주세요.',
      JSON.stringify(c),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
