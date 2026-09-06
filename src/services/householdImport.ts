/**
 * Household import service — STEP 16-F2.
 *
 * The ONLY place in the app that calls `public.import_household_snapshot`
 * (supabase/migrations/20260906000800_household_import.sql) or reads
 * `public.household_imports`. No `service_role`/extra API key — everything
 * here rides the same `authenticated` session `src/lib/supabase.ts` already
 * holds, exactly like `src/store/household.tsx`'s existing RPC calls
 * (`create_household_invite` / `redeem_household_invite`). No financial
 * table is ever `.insert()`/`.update()`/`.delete()`/`.upsert()`-ed directly
 * from here or anywhere else in the client — the 008 RPC is the single
 * write path, running as its own SECURITY DEFINER transaction.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import type { HouseholdImportPayload } from '@/lib/householdMigration';
import { supabase } from '@/lib/supabase';

/* ------------------------------------------------------------------ *
 * Import id
 * ------------------------------------------------------------------ */

/**
 * One fresh id per real import ATTEMPT (not per household) — audit/support
 * correlation only on the server side (household_imports.import_id), never
 * used for idempotency logic there. Same shape as store.tsx's local `uid()`
 * helper; never contains email/name/financial data. Comfortably under the
 * 008 RPC's 128-character INVALID_SNAPSHOT limit.
 */
export function generateImportId(): string {
  return `import-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ *
 * Error mapping — STEP 16-F2 §11. Never surfaces a raw Postgres/PostgREST
 * message to the user, and never logs the payload or the raw error
 * (financial data never appears in what a PostgrestError carries here, but
 * this module still avoids logging anything at all, defensively).
 * ------------------------------------------------------------------ */

const IMPORT_ERROR_MESSAGES: Record<string, string> = {
  ALREADY_IMPORTED: '이미 기존 데이터 가져오기가 완료됐어요.',
  REMOTE_DATA_NOT_EMPTY: '우리집 가계부에 이미 데이터가 있어 기존 데이터를 자동으로 합칠 수 없어요.',
  NOT_OWNER: '기존 데이터 가져오기는 방장만 할 수 있어요.',
  UNSUPPORTED_SCHEMA_VERSION: '이 데이터 버전은 아직 가져올 수 없어요.',
  SNAPSHOT_TOO_LARGE: '데이터 양이 너무 많아 한 번에 가져올 수 없어요.',
  INVALID_SNAPSHOT: '기존 데이터 형식을 확인할 수 없어요.',
  HOUSEHOLD_SETTINGS_NOT_FOUND: '우리집 설정을 확인하지 못했어요.',
  AUTH_REQUIRED: '다시 로그인해 주세요.',
  HOUSEHOLD_NOT_FOUND: '우리집 가계부를 찾을 수 없어요.',
};

export interface ImportErrorInfo {
  /** Machine code — one of IMPORT_ERROR_MESSAGES' keys, 'NETWORK', or 'UNKNOWN'. */
  code: string;
  /** User-facing Korean message. Never the raw DB error text. */
  message: string;
}

/** Postgres/RPC errors -> a machine code + friendly Korean copy. Mirrors
 *  src/store/household.tsx's describeHouseholdError() message-matching
 *  approach — every 008 exception uses errcode P0001/P0002/28000/42501, so
 *  the exception's own literal message text (e.g. "ALREADY_IMPORTED") is
 *  what actually distinguishes them, not the SQLSTATE. */
export function describeImportError(error: unknown): ImportErrorInfo {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as PostgrestError).message)
        : String(error);

  for (const code of Object.keys(IMPORT_ERROR_MESSAGES)) {
    if (raw.includes(code)) return { code, message: IMPORT_ERROR_MESSAGES[code] };
  }
  const m = raw.toLowerCase();
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) {
    return { code: 'NETWORK', message: '네트워크 연결을 확인한 뒤 다시 시도해주세요.' };
  }
  return { code: 'UNKNOWN', message: '문제가 발생했어요. 잠시 후 다시 시도해주세요.' };
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export interface HouseholdImportStatus {
  imported: boolean;
  /** RPC-returned row counts (household_imports.counts), or null if not imported. */
  counts: Record<string, number> | null;
  completedAt: string | null;
}

export type HouseholdImportStatusResult =
  | { ok: true; status: HouseholdImportStatus }
  | { ok: false; message: string };

/**
 * SELECTs `public.household_imports` for this household — the same table
 * any member (not just the owner) may read under its RLS policy. A missing
 * row means "not imported yet", not an error.
 */
export async function getHouseholdImportStatus(
  householdId: string,
): Promise<HouseholdImportStatusResult> {
  const { data, error } = await supabase
    .from('household_imports')
    .select('counts, completed_at')
    .eq('household_id', householdId)
    .maybeSingle();

  if (error) return { ok: false, message: describeImportError(error).message };
  if (!data) return { ok: true, status: { imported: false, counts: null, completedAt: null } };

  return {
    ok: true,
    status: {
      imported: true,
      counts: (data.counts as Record<string, number> | null) ?? null,
      completedAt: (data.completed_at as string | null) ?? null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

export interface ImportSuccess {
  ok: true;
  counts: Record<string, number> | null;
  /**
   * true when this success was determined by re-checking the completion
   * marker AFTER an ambiguous RPC error (network drop / client timeout /
   * app backgrounded mid-request), rather than from a direct RPC response
   * — STEP 16-F2 §10. import_household_snapshot is one atomic transaction,
   * so an error reaching this client does not prove the import didn't
   * happen on the server; the marker is the authoritative source of truth.
   */
  recovered: boolean;
}
export interface ImportFailure {
  ok: false;
  code: string;
  message: string;
}
export type ImportOutcome = ImportSuccess | ImportFailure;

export interface ImportHouseholdSnapshotParams {
  householdId: string;
  importId: string;
  schemaVersion: number;
  payload: HouseholdImportPayload;
}

/**
 * Calls the 008 RPC exactly once per invocation — callers are responsible
 * for every precondition (owner, fresh snapshot, safety backup, re-checked
 * readiness) BEFORE calling this; it performs none of those checks itself,
 * only the call + the post-error marker re-check described above.
 */
export async function importHouseholdSnapshot(
  params: ImportHouseholdSnapshotParams,
): Promise<ImportOutcome> {
  const { data, error } = await supabase.rpc('import_household_snapshot', {
    p_household_id: params.householdId,
    p_import_id: params.importId,
    p_schema_version: params.schemaVersion,
    p_snapshot: params.payload,
  });

  if (!error) {
    return { ok: true, counts: (data as Record<string, number> | null) ?? null, recovered: false };
  }

  const recheck = await getHouseholdImportStatus(params.householdId);
  if (recheck.ok && recheck.status.imported) {
    return { ok: true, counts: recheck.status.counts, recovered: true };
  }

  const { code, message } = describeImportError(error);
  return { ok: false, code, message };
}
