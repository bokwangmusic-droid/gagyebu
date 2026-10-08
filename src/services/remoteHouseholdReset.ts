/**
 * "우리집 가계부 데이터 전체 초기화" — the one RPC call.
 *
 * `public.reset_household_finance_data(p_household_id, p_request_id)`
 * (supabase/migrations/20261008002000_reset_household_finance_data.sql, as
 * replaced by 20261008002100_household_reset_serialized_verdict.sql) is
 * owner-only and atomic on the server: it hard-deletes every finance table
 * of ONE household, resets `household_settings`' content columns, stamps
 * `data_reset_at`, and either does all of that or none of it. This module
 * only calls it and translates the result — no table is ever
 * `.delete()`-ed from the client, and nothing here is retried.
 *
 * When that call's reply is lost, `fetchHouseholdResetVerdict` asks
 * `public.get_household_reset_marker_serialized` what became of it. That
 * RPC waits on the same household row lock the reset holds and closes the
 * request id if it has not run yet, so its answer is final — never a guess
 * based on how long the client waited.
 *
 * The owner check that matters is the server's (`NOT_OWNER`); the screen's
 * own role check is a convenience, not a guard.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import type { ResetVerdictRead } from '@/lib/householdResetMarker';
import { supabase } from '@/lib/supabase';
import { isTransportError } from '@/lib/transportError';
import { fetchHouseholdResetMarker } from '@/services/remoteFinance';

/** Per-table deleted row counts, as returned by the RPC (soft-deleted rows included). */
export interface HouseholdResetCounts {
  transactions: number;
  recurring_rules: number;
  planned_expenses: number;
  cards: number;
  assets: number;
  goal_movements: number;
  goals: number;
  loan_payments: number;
  loans: number;
  budgets: number;
  custom_categories: number;
}

/** The RPC's jsonb result: the counts plus the new `household_settings.data_reset_at`. */
export interface HouseholdResetRpcResult extends HouseholdResetCounts {
  reset_at: string;
}

export type HouseholdResetErrorCode =
  | 'AUTH_REQUIRED'
  | 'NOT_OWNER'
  | 'HOUSEHOLD_NOT_FOUND'
  | 'HOUSEHOLD_SETTINGS_NOT_FOUND'
  | 'RESET_REQUEST_CLOSED'
  | 'NETWORK'
  | 'UNKNOWN';

export type HouseholdResetResult =
  | { ok: true; resetAt: string; counts: HouseholdResetCounts }
  | {
      ok: false;
      code: HouseholdResetErrorCode;
      /** User-facing Korean message. Never the raw DB error text. */
      message: string;
      /**
       * `true`  — the server answered with a verdict, so the transaction was
       *           rolled back: the data is certainly untouched.
       * `false` — the request died in transport (or the reply was unusable):
       *           the reset may or may not have committed. The caller must
       *           verify before telling the user anything about the data.
       */
      definitive: boolean;
    };

export const HOUSEHOLD_RESET_MESSAGES = {
  offline: '인터넷 연결 후 다시 시도해주세요',
  notOwner: '방장만 우리집 데이터를 전체 초기화할 수 있어요',
  failed: '삭제하지 못했어요. 데이터는 그대로예요.',
  unconfirmed:
    '삭제 결과를 확인하지 못했어요. 인터넷에 연결되면 자동으로 다시 확인하고, 그때까지 이 우리집의 미전송 변경사항은 보내지 않아요.',
  refreshFailed: '삭제는 완료됐지만 화면을 새로고침하지 못했어요. 잠시 후 다시 확인해주세요.',
  storage:
    '이 기기에 저장할 수 없어 초기화를 시작하지 않았어요. 데이터는 삭제되지 않았어요. 저장공간을 확인한 뒤 다시 시도해주세요.',
  busy: '이미 초기화가 진행 중이에요. 잠시 후 다시 확인해주세요.',
  notStarted:
    '초기화를 시작하지 못했어요. 데이터는 삭제되지 않았어요. 앱을 최신 버전으로 업데이트한 뒤 다시 시도해주세요.',
  done: '우리집 가계부 데이터를 모두 삭제했어요',
} as const;

const SERVER_ERROR_MESSAGES: Record<
  Exclude<HouseholdResetErrorCode, 'NETWORK' | 'UNKNOWN'>,
  string
> = {
  AUTH_REQUIRED: '다시 로그인해 주세요.',
  NOT_OWNER: HOUSEHOLD_RESET_MESSAGES.notOwner,
  HOUSEHOLD_NOT_FOUND: '우리집 가계부를 찾을 수 없어요.',
  HOUSEHOLD_SETTINGS_NOT_FOUND: '우리집 설정을 확인하지 못했어요.',
  // A request id that already has an outcome on the server. THIS call deleted
  // nothing — but an earlier delivery of the same request may have.
  RESET_REQUEST_CLOSED: '이 초기화 요청은 더 이상 실행할 수 없어요. 다시 시도해주세요.',
};

/**
 * Server codes that are an answer about THIS call only, not about the
 * attempt. RESET_REQUEST_CLOSED means "a row for this request id exists":
 * the serialized check closed it, or the same request was delivered twice
 * and the first delivery COMMITTED. Only the check can tell which.
 */
const NOT_A_VERDICT: ReadonlySet<string> = new Set(['RESET_REQUEST_CLOSED']);

const rawMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === 'object' && error && 'message' in error
      ? String((error as PostgrestError).message)
      : String(error ?? '');

/**
 * RPC error -> machine code + friendly copy. Same message-matching approach
 * as src/services/householdImport.ts's `describeImportError`: the RPC's
 * exceptions are distinguished by their literal message text, not SQLSTATE.
 * Pure — exported for the `.cases.ts` runner.
 */
export function describeHouseholdResetError(
  error: unknown,
): Extract<HouseholdResetResult, { ok: false }> {
  const raw = rawMessage(error);
  for (const code of Object.keys(SERVER_ERROR_MESSAGES) as (keyof typeof SERVER_ERROR_MESSAGES)[]) {
    if (raw.includes(code)) {
      return { ok: false, code, message: SERVER_ERROR_MESSAGES[code], definitive: !NOT_A_VERDICT.has(code) };
    }
  }
  if (isTransportError(error)) {
    return { ok: false, code: 'NETWORK', message: HOUSEHOLD_RESET_MESSAGES.offline, definitive: false };
  }
  // Any other server verdict (e.g. a statement timeout): the function call
  // was aborted, and with it every DELETE it had performed. Only an error
  // carrying a Postgres / PostgREST code IS such a verdict — a code-less one
  // (a gateway 502/504 page, an unparseable body) says nothing about whether
  // the call is still running, so the caller has to verify it.
  const code = typeof error === 'object' && error ? (error as { code?: unknown }).code : undefined;
  const definitive = typeof code === 'string' && code.trim() !== '';
  return { ok: false, code: 'UNKNOWN', message: HOUSEHOLD_RESET_MESSAGES.failed, definitive };
}

const COUNT_KEYS: (keyof HouseholdResetCounts)[] = [
  'transactions',
  'recurring_rules',
  'planned_expenses',
  'cards',
  'assets',
  'goal_movements',
  'goals',
  'loan_payments',
  'loans',
  'budgets',
  'custom_categories',
];

/**
 * Validates the RPC's jsonb. A reply without a usable `reset_at` is NOT a
 * success: without it the caller cannot move this device's reset marker, so
 * it is reported as an unconfirmed outcome instead. Pure — exported for the
 * `.cases.ts` runner.
 */
export function parseHouseholdResetResult(data: unknown): HouseholdResetResult {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'UNKNOWN', message: HOUSEHOLD_RESET_MESSAGES.unconfirmed, definitive: false };
  }
  const row = data as Record<string, unknown>;
  if (typeof row.reset_at !== 'string' || row.reset_at.trim() === '') {
    return { ok: false, code: 'UNKNOWN', message: HOUSEHOLD_RESET_MESSAGES.unconfirmed, definitive: false };
  }
  const counts = {} as HouseholdResetCounts;
  for (const key of COUNT_KEYS) {
    const n = row[key];
    counts[key] = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  }
  return { ok: true, resetAt: row.reset_at, counts };
}

/** What the server accepts as `p_request_id` (migration 20261008002100). */
export const isResetRequestId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 8 && value.length <= 64;

/**
 * A fresh id for ONE reset attempt: a UUIDv4 from `expo-crypto`
 * (cryptographically secure — never `Math.random`, the id is what keeps
 * anyone else from closing or replaying the request). `null` when it cannot
 * be produced; the caller must not start the reset then.
 *
 * Imported lazily for the same reason as in src/store/auth.tsx:
 * `expo-crypto` resolves its native module at import time, and a binary
 * that predates the module can still receive this JS as an OTA update.
 */
export async function createResetRequestId(): Promise<string | null> {
  try {
    const Crypto = await import('expo-crypto');
    const id = Crypto.randomUUID();
    return isResetRequestId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * `requestId` names this attempt on the server: it is what
 * `fetchHouseholdResetVerdict` asks about (and closes) if the reply is lost.
 * One id per attempt (`createResetRequestId`), the SAME one for every call
 * that belongs to it.
 */
export async function resetHouseholdFinanceData(
  householdId: string,
  requestId: string,
): Promise<HouseholdResetResult> {
  try {
    const { data, error } = await supabase.rpc('reset_household_finance_data', {
      p_household_id: householdId,
      p_request_id: requestId,
    });
    if (error) return describeHouseholdResetError(error);
    return parseHouseholdResetResult(data);
  } catch (e) {
    return describeHouseholdResetError(e);
  }
}

const isMarker = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.trim() !== '');

/**
 * Validates `get_household_reset_marker_serialized`'s jsonb. Anything that
 * is not exactly the documented shape is "no answer" — a malformed reply
 * must never be read as "the reset did not happen". Pure — exported for the
 * `.cases.ts` runner.
 */
export function parseHouseholdResetVerdict(data: unknown): ResetVerdictRead {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return { ok: false };
  const row = data as Record<string, unknown>;
  if (typeof row.committed !== 'boolean') return { ok: false };
  if (!('data_reset_at' in row) || !isMarker(row.data_reset_at)) return { ok: false };
  const resetAt = row.reset_at ?? null;
  if (!isMarker(resetAt)) return { ok: false };
  // "committed" without the marker it wrote cannot be acted on.
  if (row.committed && resetAt === null) return { ok: false };
  return { ok: true, committed: row.committed, resetAt, marker: row.data_reset_at };
}

/**
 * The check is owner-only. NOT_OWNER for a request this account itself sent
 * means ownership was transferred since — and the transfer takes the same
 * household lock, so by then the request has either committed or can never
 * run (see the migration header). Whether it committed is what the plain
 * marker says: the caller compares it with what it knew before. An
 * unreadable marker is still no answer. Pure — exported for the `.cases.ts`
 * runner.
 */
export function verdictAfterOwnerLoss(
  marker: { ok: true; value: string | null } | { ok: false },
): ResetVerdictRead {
  return marker.ok ? { ok: true, committed: false, resetAt: null, marker: marker.value } : { ok: false };
}

/**
 * What became of the reset sent with `requestId`? Resolves only after any
 * reset holding this household's lock has finished. Any error other than
 * NOT_OWNER — transport, a statement timeout while waiting for that lock —
 * is `ok: false`: no answer, to be asked again.
 */
export async function fetchHouseholdResetVerdict(
  householdId: string,
  requestId: string,
): Promise<ResetVerdictRead> {
  try {
    const { data, error } = await supabase.rpc('get_household_reset_marker_serialized', {
      p_household_id: householdId,
      p_request_id: requestId,
    });
    if (error) {
      if (!rawMessage(error).includes('NOT_OWNER')) return { ok: false };
      return verdictAfterOwnerLoss(await fetchHouseholdResetMarker(householdId));
    }
    return parseHouseholdResetVerdict(data);
  } catch {
    return { ok: false };
  }
}
