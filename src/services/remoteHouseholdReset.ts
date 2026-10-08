/**
 * "우리집 가계부 데이터 전체 초기화" — the one RPC call.
 *
 * `public.reset_household_finance_data(p_household_id)`
 * (supabase/migrations/20261008002000_reset_household_finance_data.sql) is
 * owner-only and atomic on the server: it hard-deletes every finance table
 * of ONE household, resets `household_settings`' content columns, stamps
 * `data_reset_at`, and either does all of that or none of it. This module
 * only calls it and translates the result — no table is ever
 * `.delete()`-ed from the client, and nothing here is retried.
 *
 * The owner check that matters is the server's (`NOT_OWNER`); the screen's
 * own role check is a convenience, not a guard.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import { isTransportError } from '@/lib/transportError';

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
  unconfirmed: '삭제 결과를 확인하지 못했어요. 인터넷 연결 후 다시 확인해주세요.',
  refreshFailed: '삭제는 완료됐지만 화면을 새로고침하지 못했어요. 잠시 후 다시 확인해주세요.',
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
};

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
      return { ok: false, code, message: SERVER_ERROR_MESSAGES[code], definitive: true };
    }
  }
  if (isTransportError(error)) {
    return { ok: false, code: 'NETWORK', message: HOUSEHOLD_RESET_MESSAGES.offline, definitive: false };
  }
  // Any other server verdict (e.g. a statement timeout): the function call
  // was aborted, and with it every DELETE it had performed.
  return { ok: false, code: 'UNKNOWN', message: HOUSEHOLD_RESET_MESSAGES.failed, definitive: true };
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

export async function resetHouseholdFinanceData(householdId: string): Promise<HouseholdResetResult> {
  try {
    const { data, error } = await supabase.rpc('reset_household_finance_data', {
      p_household_id: householdId,
    });
    if (error) return describeHouseholdResetError(error);
    return parseHouseholdResetResult(data);
  } catch (e) {
    return describeHouseholdResetError(e);
  }
}
