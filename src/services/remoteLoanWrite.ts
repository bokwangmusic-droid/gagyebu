/**
 * Remote household loan WRITE layer — STEP 16-G2-D4.
 *
 * Five direct writes, no RPC:
 *   - createLoan            : `.insert()` one `public.loans` row (NEVER `paid`)
 *   - updateLoan            : conditional `.update()` of name/lender/principal/
 *                             annual_rate/term_months/start_date/payment_day/
 *                             repay_type — refuses `principal < current paid`
 *   - softDeleteLoan        : `.update({ deleted_at })` — never a hard DELETE,
 *                             never touches loan_payments/transactions
 *   - addLoanPayment        : `.insert()` one `public.loan_payments` row with
 *                             `principal_part` / `interest_part` computed by
 *                             `splitPayment()` from an AUTHORITATIVE re-SELECT
 *                             of the loan done immediately before the INSERT;
 *                             the DB `trg_apply_loan_payment` trigger then
 *                             moves `loans.paid`. The client NEVER reads
 *                             `paid`, adds to it and writes it back — the
 *                             `authenticated` UPDATE grant on `public.loans`
 *                             does not include `paid`.
 *   - softDeleteLoanPayment : `.update({ deleted_at })` on `public.loan_payments`
 *                             — the trigger reverses `loans.paid` by
 *                             `old.principal_part`. Never a hard DELETE,
 *                             never a direct `loans.paid` write.
 *
 * This module writes ONLY `public.loans` and `public.loan_payments`. It
 * NEVER writes `transactions`, never adds a provenance column, never
 * touches an existing loan_payments row on a loan soft-delete.
 *
 * Concurrency (STEP 16-G2-D4 §9): the `paid` cache itself is safe — the
 * trigger does `paid = paid + principal_part` under a row lock. But the
 * interest/principal SPLIT is client-side (`splitPayment`), so two
 * near-simultaneous repayments can each compute their split against a
 * balance the other has not yet reduced — a small `interest_part`
 * inaccuracy in the race window between this module's authoritative
 * re-SELECT and its INSERT. This STEP mitigates (fresh re-SELECT, latest
 * annual_rate, DB `paid <= principal` CHECK, 23514 -> refresh UX) but does
 * NOT fully solve it; a server-side row-locked split (trigger/RPC change =
 * migration) is a future hardening item.
 *
 * Session identity: every write re-checks the live session and refuses if
 * it no longer matches `expectedUserId`.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import { classifyWriteReadError, isTransportError } from '@/lib/transportError';
import {
  buildLoanInsert,
  buildLoanPaymentInsert,
  buildLoanUpdate,
  isValidLoanDraft,
  isValidLoanPaymentDraft,
  type LoanInsertRow,
  type LoanPaymentInsertRow,
  type NewLoanDraft,
  type NewLoanPaymentDraft,
} from '@/lib/remoteLoanWriteMapping';

export type LoanWriteReason =
  | 'identity'
  | 'invalid'
  | 'conflict'
  | 'deleted'
  | 'gone'
  | 'error';

/** updateLoan can additionally fail with `principal_low`. */
export type UpdateLoanReason = LoanWriteReason | 'principal_low';
/** addLoanPayment can additionally fail with `paid_off` or `stale` (23514). */
export type AddLoanPaymentReason = LoanWriteReason | 'paid_off' | 'stale';

/**
 * `transport: true` (STEP 16-H2-D0, mirrors STEP 16-H2-C2-0) marks a
 * NETWORK/TRANSPORT failure of a loan / loan-payment write — the request
 * never reached a server verdict — as opposed to a 23505 / 23503 / 23514, an
 * RLS/PGRST verdict, or a successful-but-empty reconcile read. ONLY a
 * `transport` failure is safe for a future Offline Write Queue to enqueue.
 * Additive/optional; existing callers are unaffected. This D0 step adds the
 * flag ONLY — `principal_low` / `paid_off` / `stale` / `gone` / `deleted` /
 * `conflict` are NEVER `transport`. It does NOT touch the client-side
 * interest/principal split (that replay-idempotency hardening is H2-H3).
 */
export type CreateLoanResult =
  | { ok: true; id: string }
  | { ok: false; reason: LoanWriteReason; message: string; transport?: boolean };

export type UpdateLoanResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: UpdateLoanReason; message: string; transport?: boolean };

export type SoftDeleteLoanResult =
  | { ok: true }
  | {
      ok: false;
      reason: Exclude<LoanWriteReason, 'invalid' | 'deleted'>;
      message: string;
      transport?: boolean;
    };

export type AddLoanPaymentResult =
  | { ok: true }
  | { ok: false; reason: AddLoanPaymentReason; message: string; transport?: boolean };

export type SoftDeleteLoanPaymentResult =
  | { ok: true }
  | {
      ok: false;
      reason: Exclude<LoanWriteReason, 'invalid' | 'deleted'>;
      message: string;
      transport?: boolean;
    };

const GENERIC_ERROR = '대출을 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const PAYMENT_ERROR = '상환 기록을 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';
const RELOGIN = '다시 로그인해 주세요.';
const INVALID = '대출 정보를 확인해 주세요.';
const INVALID_PAYMENT = '상환 금액을 확인해 주세요.';
const EDIT_CONFLICT = '다른 곳에서 변경됐거나 삭제된 대출이에요. 최신 내용을 불러올게요.';
const LOAN_GONE = '삭제됐거나 찾을 수 없는 대출이에요. 최신 내용을 불러올게요.';
const PRINCIPAL_LOW = '이미 상환한 원금보다 대출 원금을 낮출 수 없어요.';
const PAID_OFF = '이미 모두 상환한 대출이에요.';
const PAYMENT_STALE = '상환 상태가 변경됐어요. 최신 잔액을 불러왔으니 다시 확인해주세요.';
const PAYMENT_DELETE_CONFLICT = '다른 곳에서 이미 변경된 상환 기록이에요. 최신 내용을 불러올게요.';

/** Never surfaces raw Postgres/PostgREST internals (mirrors remoteCardWrite.ts). */
function describeWriteError(error: PostgrestError, fallback = GENERIC_ERROR): string {
  const m = (error.message ?? '').toLowerCase();
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) {
    return '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
  }
  return fallback;
}

async function assertLiveUser(
  expectedUserId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const liveUserId = sessionData.session?.user?.id ?? null;
  if (!liveUserId) return { ok: false, message: RELOGIN };
  if (liveUserId !== expectedUserId) return { ok: false, message: IDENTITY_CHANGED };
  return { ok: true };
}

/** Does a loan row read back after a 23505 represent the SAME create, by the
 *  SAME user, still active? A soft-deleted row is an id collision, never an
 *  idempotent success — never revived (STEP 16-G2-D4 §5). */
function isSameLoanCreate(
  existing: Record<string, unknown>,
  row: LoanInsertRow,
  expectedUserId: string,
): boolean {
  return (
    existing.deleted_at == null &&
    existing.created_by === expectedUserId &&
    existing.household_id === row.household_id &&
    existing.name === row.name &&
    existing.lender === row.lender &&
    existing.principal === row.principal &&
    existing.annual_rate === row.annual_rate &&
    existing.term_months === row.term_months &&
    existing.start_date === row.start_date &&
    existing.payment_day === row.payment_day &&
    existing.repay_type === row.repay_type
  );
}

/**
 * STEP 16-H2-L1.1 — does an existing `loan_payments` row represent the SAME
 * requested repayment, by STABLE REQUEST INTENT only: household, loan,
 * requesting user, and the user-entered `date`/`amount` — the fields that
 * are fixed for one repayment sheet and can never legitimately differ
 * between the original attempt and any replay of it.
 *
 * Deliberately NEVER compares `principal_part`/`interest_part` — those are
 * DERIVED at INSERT time from `splitPayment(remaining, annualRate, amount)`,
 * where `remaining = principal - paid`. If the original INSERT actually
 * succeeded, `paid` has already moved, so a lost-response REPLAY recomputes
 * a *different* (but not wrong) split — comparing derived fields here used
 * to make a genuinely-idempotent replay look like a content conflict (the
 * H2-L1 false-negative this fixes). `amount` (the raw total the user typed)
 * IS its own real column on `loan_payments` and is what actually identifies
 * the request; the split is bookkeeping the server derives from it, not
 * part of the request.
 *
 * A soft-deleted row is a genuine id collision, never an idempotent success
 * — never revived.
 */
export function isSamePaymentRequest(
  existing: Record<string, unknown>,
  args: {
    householdId: string;
    loanId: string;
    expectedUserId: string;
    draft: NewLoanPaymentDraft;
  },
): boolean {
  return (
    existing.deleted_at == null &&
    existing.household_id === args.householdId &&
    existing.loan_id === args.loanId &&
    existing.created_by === args.expectedUserId &&
    existing.date === args.draft.date &&
    existing.amount === args.draft.amount
  );
}

/**
 * Does the stored loan already hold exactly what this edit would write?
 *
 * STEP 16-H2-L2.3 — `principal` / `annual_rate` are Postgres `numeric`
 * columns (see supabase/migrations/20260905000200_household_data.sql), which
 * PostgREST always serializes as JSON STRINGS (e.g. `"1000000"`), never
 * numbers — unlike `term_months` / `payment_day` (`int`), which come back as
 * genuine numbers. `existing` here is a RAW select result, so
 * `existing.principal` / `existing.annual_rate` are strings at runtime
 * despite `row` (built from the draft) holding JS numbers for the SAME
 * fields. The old raw `===` compare therefore NEVER matched even when the
 * value was semantically identical, misreporting a genuinely-landed,
 * idempotent lost-response retry as a `conflict`. Wrapped in `Number()` for
 * all four numeric-ish fields, mirroring `serverLoanConfirmsUpdate`'s
 * already-safe pattern (the coordinator's separate ack comparison, which
 * this bug did not affect).
 */
export function loanFieldsMatch(
  existing: Record<string, unknown>,
  row: ReturnType<typeof buildLoanUpdate>,
): boolean {
  return (
    existing.name === row.name &&
    existing.lender === row.lender &&
    Number(existing.principal) === Number(row.principal) &&
    Number(existing.annual_rate) === Number(row.annual_rate) &&
    Number(existing.term_months) === Number(row.term_months) &&
    existing.start_date === row.start_date &&
    Number(existing.payment_day) === Number(row.payment_day) &&
    existing.repay_type === row.repay_type
  );
}

/* ================================================================== *
 * CREATE
 * ================================================================== */

export async function createLoan(args: {
  /** Client-generated `loan-...` id, stable across retries of ONE form mount. */
  id: string;
  householdId: string;
  expectedUserId: string;
  draft: NewLoanDraft;
}): Promise<CreateLoanResult> {
  if (!isValidLoanDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const row = buildLoanInsert(args.draft, { id: args.id, householdId: args.householdId });

  const { data, error } = await supabase
    .from('loans')
    .insert(row) // `paid` omitted -> DB default 0; `created_by` set by trigger
    .select('id')
    .single();

  if (!error && data?.id) return { ok: true, id: data.id as string };

  if (error?.code === '23505') {
    const { data: existing, error: readErr } = await supabase
      .from('loans')
      .select(
        'id,household_id,created_by,name,lender,principal,annual_rate,term_months,start_date,payment_day,repay_type,deleted_at',
      )
      .eq('household_id', args.householdId)
      .eq('id', args.id)
      .maybeSingle();

    // STEP 16-H2-D0: transport failure during the 23505 reconcile read is
    // retryable; a non-transport read error / successful empty read stay terminal.
    const readClass = classifyWriteReadError(readErr, describeWriteError);
    if (readClass) {
      return {
        ok: false,
        reason: 'error',
        message: readClass.message,
        ...(readClass.transport ? { transport: true } : {}),
      };
    }
    if (!existing) return { ok: false, reason: 'error', message: GENERIC_ERROR };
    if (isSameLoanCreate(existing as Record<string, unknown>, row, args.expectedUserId)) {
      return { ok: true, id: args.id };
    }
    return { ok: false, reason: 'conflict', message: GENERIC_ERROR };
  }

  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: describeWriteError(error),
      ...(isTransportError(error) ? { transport: true } : {}),
    };
  }
  return { ok: false, reason: 'error', message: GENERIC_ERROR };
}

/* ================================================================== *
 * UPDATE (loan conditions — NEVER paid; refuses principal < current paid)
 * ================================================================== */

export async function updateLoan(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured at form MOUNT — never re-parsed. */
  expectedUpdatedAt: string;
  draft: NewLoanDraft;
}): Promise<UpdateLoanResult> {
  if (!isValidLoanDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  // Authoritative check (STEP 16-G2-D4 §6): the new principal may not drop
  // below the amount already repaid. The DB `loans_paid_within_principal`
  // CHECK is the final authority; this is the friendly early message.
  const { data: current, error: curErr } = await supabase
    .from('loans')
    .select('paid, deleted_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // STEP 16-H2-D0: a transport failure on the principal/paid precheck read is
  // retryable (transport:true); it must NOT fall through to gone / deleted /
  // principal_low.
  const curClass = classifyWriteReadError(curErr, describeWriteError);
  if (curClass) {
    return {
      ok: false,
      reason: 'error',
      message: curClass.message,
      ...(curClass.transport ? { transport: true } : {}),
    };
  }
  if (!current) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };
  const cur = current as Record<string, unknown>;
  if (cur.deleted_at != null) return { ok: false, reason: 'deleted', message: EDIT_CONFLICT };
  if (typeof cur.paid === 'number' && args.draft.principal < cur.paid) {
    return { ok: false, reason: 'principal_low', message: PRINCIPAL_LOW };
  }

  const row = buildLoanUpdate(args.draft); // editable fields only — no paid, no identity

  const { data, error } = await supabase
    .from('loans')
    .update(row)
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, updated_at')
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: describeWriteError(error),
      ...(isTransportError(error) ? { transport: true } : {}),
    };
  }
  if (data?.updated_at) return { ok: true, updatedAt: data.updated_at as string };

  // 0 rows — reconcile against the authoritative row.
  const { data: existing, error: readErr } = await supabase
    .from('loans')
    .select(
      'name,lender,principal,annual_rate,term_months,start_date,payment_day,repay_type,deleted_at,updated_at',
    )
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // STEP 16-H2-D0: transport read failure -> retryable (transport:true);
  // non-transport -> plain server error; only a successful empty reselect is 'gone'.
  const readClass = classifyWriteReadError(readErr, describeWriteError);
  if (readClass) {
    return {
      ok: false,
      reason: 'error',
      message: readClass.message,
      ...(readClass.transport ? { transport: true } : {}),
    };
  }
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };

  const existingRow = existing as Record<string, unknown>;
  if (existingRow.deleted_at != null) {
    return { ok: false, reason: 'deleted', message: EDIT_CONFLICT };
  }
  if (loanFieldsMatch(existingRow, row)) {
    // Our earlier edit already landed; the response was lost.
    return { ok: true, updatedAt: existingRow.updated_at as string };
  }
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

/* ================================================================== *
 * SOFT DELETE (loan_payments + transactions untouched)
 * ================================================================== */

export async function softDeleteLoan(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured BEFORE the confirm Alert — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<SoftDeleteLoanResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const { data, error } = await supabase
    .from('loans')
    .update({ deleted_at: new Date().toISOString() })
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, deleted_at, updated_at')
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: describeWriteError(error),
      ...(isTransportError(error) ? { transport: true } : {}),
    };
  }
  if (data?.id) return { ok: true };

  // 0 rows — reconcile.
  const { data: existing, error: readErr } = await supabase
    .from('loans')
    .select('deleted_at, updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // STEP 16-H2-D0: transport read failure -> retryable (transport:true).
  const readClass = classifyWriteReadError(readErr, describeWriteError);
  if (readClass) {
    return {
      ok: false,
      reason: 'error',
      message: readClass.message,
      ...(readClass.transport ? { transport: true } : {}),
    };
  }
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };
  if ((existing as Record<string, unknown>).deleted_at != null) {
    // Already soft-deleted — our earlier delete landed, response was lost.
    return { ok: true };
  }
  // Still active but our updated_at no longer matches — someone edited it first.
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

/* ================================================================== *
 * ADD PAYMENT (repayment) — loan_payments INSERT only
 * ================================================================== */

export async function addLoanPayment(args: {
  /** Client-generated `lp-...` id, STABLE across every save retry of one sheet. */
  paymentId: string;
  householdId: string;
  loanId: string;
  expectedUserId: string;
  draft: NewLoanPaymentDraft;
}): Promise<AddLoanPaymentResult> {
  if (!isValidLoanPaymentDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID_PAYMENT };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  // STEP 16-H2-L1.1 — idempotency pre-check: does a payment with THIS id
  // already exist? Checked BEFORE the loan re-SELECT / split computation
  // below, so a lost-response replay of an ALREADY-APPLIED payment never
  // recomputes a split at all (the split would legitimately differ once
  // `paid` has moved — see `isSamePaymentRequest`'s doc) and never
  // re-evaluates `remaining <= 0` against a balance THIS SAME payment
  // already reduced to zero (which would otherwise misreport `paid_off` on
  // a plain retry). A race with a concurrent INSERT of the same id is still
  // safe — it falls through to the 23505 branch below, which reconciles
  // with the SAME `isSamePaymentRequest` helper.
  const { data: preExisting, error: preErr } = await supabase
    .from('loan_payments')
    .select('household_id, loan_id, created_by, date, amount, deleted_at')
    .eq('id', args.paymentId)
    .maybeSingle();

  const preClass = classifyWriteReadError(preErr, (e) => describeWriteError(e, PAYMENT_ERROR));
  if (preClass) {
    return {
      ok: false,
      reason: 'error',
      message: preClass.message,
      ...(preClass.transport ? { transport: true } : {}),
    };
  }
  if (preExisting) {
    if (isSamePaymentRequest(preExisting as Record<string, unknown>, args)) {
      // Our earlier payment already landed and was already applied.
      return { ok: true };
    }
    // Same id, but NOT our request (different loan/household/user/date/
    // amount, or a soft-deleted collision) — never silently treated as
    // success.
    return { ok: false, reason: 'conflict', message: PAYMENT_ERROR };
  }

  // Authoritative precheck (STEP 16-G2-D4 §8-2). `remaining` AND the
  // `annual_rate` used by splitPayment come from THIS re-SELECT, never the
  // UI/domain value.
  const { data: loan, error: loanErr } = await supabase
    .from('loans')
    .select('id, principal, paid, annual_rate, deleted_at')
    .eq('household_id', args.householdId)
    .eq('id', args.loanId)
    .maybeSingle();

  // STEP 16-H2-D0: a transport failure on the authoritative loan re-SELECT is
  // retryable (transport:true); it must NOT fall through to gone / deleted /
  // paid_off.
  const loanClass = classifyWriteReadError(loanErr, (e) => describeWriteError(e, PAYMENT_ERROR));
  if (loanClass) {
    return {
      ok: false,
      reason: 'error',
      message: loanClass.message,
      ...(loanClass.transport ? { transport: true } : {}),
    };
  }
  if (!loan) return { ok: false, reason: 'gone', message: LOAN_GONE };
  const lr = loan as Record<string, unknown>;
  if (lr.deleted_at != null) return { ok: false, reason: 'deleted', message: LOAN_GONE };

  const principal = typeof lr.principal === 'number' ? lr.principal : 0;
  const paid = typeof lr.paid === 'number' ? lr.paid : 0;
  const annualRate = typeof lr.annual_rate === 'number' ? lr.annual_rate : 0;
  const remaining = principal - paid;
  if (remaining <= 0) {
    return { ok: false, reason: 'paid_off', message: PAID_OFF };
  }

  const row = buildLoanPaymentInsert(args.draft, {
    id: args.paymentId,
    householdId: args.householdId,
    loanId: args.loanId,
    remaining,
    annualRate,
  });

  const { data, error } = await supabase
    .from('loan_payments')
    .insert(row) // `created_by` set by trigger; `trg_apply_loan_payment` moves loans.paid
    .select('id')
    .single();

  if (!error && data?.id) return { ok: true };

  // `loans_paid_within_principal (paid <= principal)` CHECK aborted the
  // whole statement. This is NOT necessarily "user typed too much" — a
  // concurrent repayment on another device may have raised `paid` after our
  // precheck. Ask for a refresh (STEP 16-G2-D4 §8-6).
  if (error?.code === '23514') {
    return { ok: false, reason: 'stale', message: PAYMENT_STALE };
  }

  // Parent loan vanished in the precheck->insert window (impossible via a
  // normal client path — no hard delete — but the composite FK raises 23503).
  if (error?.code === '23503') {
    return { ok: false, reason: 'gone', message: LOAN_GONE };
  }

  // Same payment id already exists — a lost-response retry. NEVER retry with
  // a fresh id (the trigger would move `paid` twice). Verify it is OUR
  // payment before reporting idempotent success.
  if (error?.code === '23505') {
    const { data: existing, error: readErr } = await supabase
      .from('loan_payments')
      .select('household_id,loan_id,created_by,date,amount,deleted_at')
      .eq('id', args.paymentId)
      .maybeSingle();

    // STEP 16-H2-D0: transport failure during the 23505 reconcile read is
    // retryable; a non-transport read error / successful empty read stay terminal.
    const readClass = classifyWriteReadError(readErr, (e) => describeWriteError(e, PAYMENT_ERROR));
    if (readClass) {
      return {
        ok: false,
        reason: 'error',
        message: readClass.message,
        ...(readClass.transport ? { transport: true } : {}),
      };
    }
    if (!existing) return { ok: false, reason: 'error', message: PAYMENT_ERROR };
    // STEP 16-H2-L1.1 — reconcile by STABLE REQUEST INTENT only (same helper
    // as the pre-check above), NEVER by comparing `principal_part`/
    // `interest_part` against this attempt's freshly-recomputed `row` — see
    // `isSamePaymentRequest`'s doc for why that used to false-negative a
    // genuinely idempotent replay.
    if (isSamePaymentRequest(existing as Record<string, unknown>, args)) {
      // Our earlier payment already landed and was already applied.
      return { ok: true };
    }
    return { ok: false, reason: 'conflict', message: PAYMENT_ERROR };
  }

  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: describeWriteError(error, PAYMENT_ERROR),
      ...(isTransportError(error) ? { transport: true } : {}),
    };
  }
  return { ok: false, reason: 'error', message: PAYMENT_ERROR };
}

/* ================================================================== *
 * SOFT DELETE PAYMENT — loan_payments deleted_at UPDATE only
 * ================================================================== */

export async function softDeleteLoanPayment(args: {
  paymentId: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured BEFORE the confirm Alert — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<SoftDeleteLoanPaymentResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const { data, error } = await supabase
    .from('loan_payments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('household_id', args.householdId)
    .eq('id', args.paymentId)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, deleted_at, updated_at')
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: describeWriteError(error, PAYMENT_ERROR),
      ...(isTransportError(error) ? { transport: true } : {}),
    };
  }
  if (data?.id) return { ok: true }; // trigger reversed loans.paid by old.principal_part

  // 0 rows — reconcile.
  const { data: existing, error: readErr } = await supabase
    .from('loan_payments')
    .select('deleted_at, updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.paymentId)
    .maybeSingle();

  // STEP 16-H2-D0: transport read failure -> retryable (transport:true).
  const readClass = classifyWriteReadError(readErr, (e) => describeWriteError(e, PAYMENT_ERROR));
  if (readClass) {
    return {
      ok: false,
      reason: 'error',
      message: readClass.message,
      ...(readClass.transport ? { transport: true } : {}),
    };
  }
  if (!existing) return { ok: false, reason: 'gone', message: PAYMENT_DELETE_CONFLICT };
  if ((existing as Record<string, unknown>).deleted_at != null) {
    // Already soft-deleted — our earlier delete landed, response was lost.
    return { ok: true };
  }
  return { ok: false, reason: 'conflict', message: PAYMENT_DELETE_CONFLICT };
}
