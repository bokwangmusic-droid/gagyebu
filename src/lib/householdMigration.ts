/**
 * Local -> household migration snapshot + readiness check.
 * STEP 16-F1, hardened in STEP 16-F1.5 (blocker/warning reclassification,
 * provenance policy, Goal.saved / Loan.paid consistency checks).
 *
 * READ-ONLY, in-memory only. Nothing here ever writes to AsyncStorage,
 * mutates the passed-in data, or calls Supabase — it only reads the
 * already-hydrated local dataset and reports whether/what could be
 * migrated. Deliberately reuses `BackupData` (src/lib/backup.ts, STEP 8)
 * as the snapshot's data shape instead of a new migration DTO — it is
 * already exactly "the 11 user-data slices", the same set this file needs.
 * The actual upload is STEP 16-F2's job (see supabase/migrations/
 * 20260906000800_household_import.sql for the atomic-import RPC design);
 * nothing in this file performs one.
 *
 * ---- STEP 16-F1.5 policy decisions baked into these checks ----
 *
 * Provenance (from_recurring/from_planned) is ALWAYS dropped on migration
 * — this is no longer a "maybe" (STEP 16-F1 floated it; F1.5 confirmed it
 * with code-level evidence, see the completion report §4):
 *   - from_recurring: the remote schema requires a paired
 *     `recurring_occurrence_date` (supabase/migrations/
 *     20260905000200_household_data.sql's transactions_recurring_fields_
 *     together CHECK) that local data never recorded. Reconstructing it
 *     from `transaction.date` would be a guess, not a fact — app/input.tsx
 *     lets a user freely edit an existing transaction's `date` (including
 *     ones with `fromRecurring` set) with no flag recording whether that
 *     happened, so `date` is not reliably still the original occurrence
 *     date.
 *   - from_planned: `markPlannedDone` (src/store/store.tsx) ALWAYS removes
 *     the source PlannedExpense from local `planned[]` in the same
 *     mutation that sets `fromPlanned` on the new transaction. So every
 *     local transaction with `fromPlanned` set is, by construction, a
 *     100%-guaranteed dangling reference locally — there is no
 *     `planned_expenses` row left to migrate that its composite FK could
 *     ever resolve against.
 * Dropping both loses only the "this was auto-generated" tag; the
 * transaction's own amount/category/memo/date migrate fully intact.
 *
 * Because provenance is always dropped, a merely-dangling
 * fromRecurring/fromPlanned reference is no longer checked for on its own
 * — it's moot once the field itself is never carried over.
 *
 * cardId, by contrast, IS still carried over (transactions keep pointing
 * at their card) — but as of STEP 16-F1.6, a dangling cardId (src/store/
 * store.tsx's deleteCard comment: "Deleting a card never touches
 * transactions... shown as 카드 미지정 until reassigned" — so this is an
 * existing, by-design local state) is a WARNING, not a blocker. The 008
 * RPC (supabase/migrations/20260906000800_household_import.sql) nulls out
 * any transaction.card_id that doesn't resolve among the migrated cards
 * before inserting — the transaction still migrates in full (amount/date/
 * memo/category untouched), it just lands as "카드 미지정", identical to
 * what already happens locally today. Nothing here performs that nulling
 * (this file never mutates data) — it only reports how many transactions
 * will be affected so the owner can see it ahead of time.
 */
import { EXPENSE_CATS, INCOME_CATS, type TxnType } from '@/data/categories';
import type { BackupData } from '@/lib/backup';
import { SCHEMA_VERSION } from '@/lib/migrations';
import type {
  Frequency,
  LoanRepayType,
  PaymentMethod,
  TransactionSplit,
} from '@/store/types';

export interface MigrationCounts {
  transactions: number;
  cards: number;
  budgets: number;
  recurring: number;
  planned: number;
  goals: number;
  loans: number;
  loanPayments: number;
  customCategories: number;
}

export interface MigrationSnapshot {
  /** Local schema version the snapshot was built from (src/lib/migrations.ts). */
  schemaVersion: number;
  createdAt: string;
  data: BackupData;
  counts: MigrationCounts;
}

function countOf(data: BackupData): MigrationCounts {
  return {
    transactions: data.transactions.length,
    cards: data.cards.length,
    budgets: Object.keys(data.budgets).length,
    recurring: data.recurring.length,
    planned: data.planned.length,
    goals: data.goals.length,
    loans: data.loans.length,
    loanPayments: data.loans.reduce((sum, l) => sum + l.payments.length, 0),
    customCategories: data.customCats.expense.length + data.customCats.income.length,
  };
}

/** Sum across every migratable slice. 0 = an empty local dataset (STEP 16-F1 §11) — not an error. */
export function totalMigratableCount(counts: MigrationCounts): number {
  return (
    counts.transactions +
    counts.cards +
    counts.budgets +
    counts.recurring +
    counts.planned +
    counts.goals +
    counts.loans +
    counts.loanPayments +
    counts.customCategories
  );
}

/** Builds an in-memory snapshot of the current local dataset. Never persisted, never sent anywhere. */
export function buildLocalMigrationSnapshot(data: BackupData): MigrationSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    data,
    counts: countOf(data),
  };
}

/**
 * Deterministic id for the ONE synthetic goal_movements row that carries a
 * migrated goal's pre-existing `saved` balance forward (STEP 16-F1.5 §2) —
 * same goal always yields the same id, so a retried import upserts/matches
 * the same row instead of double-counting. Distinct in shape from the
 * app's own `uid('gm')`-style ids (src/store/store.tsx), so it can never
 * collide with a normally-created movement.
 */
export function goalSavedMigrationMovementId(goalId: string): string {
  return `migration_goal_saved_${goalId}`;
}

export interface MigrationReadinessContext {
  hasActiveHousehold: boolean;
  isOwner: boolean;
  /**
   * Whether this household already has a completed import
   * (public.household_imports — supabase/migrations/
   * 20260906000800_household_import.sql, not yet deployed). STEP 16-F1.5
   * only defines this field; nothing in this app queries it yet (there is
   * no remote table to query against until that migration is actually
   * applied) — callers pass `false` until STEP 16-F2 wires up the real
   * check. Kept required (not optional) so that wiring can't be
   * forgotten silently.
   */
  alreadyImported: boolean;
}

export interface MigrationReadiness {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  counts: MigrationCounts;
}

/** Every category id this dataset could legitimately reference: built-ins (static, never stored as rows — see supabase/migrations) + this household's custom categories. */
function knownCategoryIds(data: BackupData): { expense: Set<string>; income: Set<string> } {
  return {
    expense: new Set([...EXPENSE_CATS.map((c) => c.id), ...data.customCats.expense.map((c) => c.id)]),
    income: new Set([...INCOME_CATS.map((c) => c.id), ...data.customCats.income.map((c) => c.id)]),
  };
}

/**
 * Read-only checks. Never mutates `snapshot.data` and never auto-fixes a
 * problem it finds locally — every issue is reported as a blocker or a
 * warning, nothing more. `blockers` gate the whole migration: STEP 16-F2
 * must not attempt any upload while `ready` is false. A row that would
 * violate an actual remote CHECK/FK constraint is a blocker (STEP 16-F1.5
 * §1), UNLESS the 008 RPC (supabase/migrations/
 * 20260906000800_household_import.sql) itself already has a defined,
 * documented, non-guessing way to resolve it server-side without altering
 * the user's actual financial data — currently only dangling
 * transaction.cardId qualifies (STEP 16-F1.6 §3: forced to null server-
 * side, identical to the app's own existing "카드 미지정" state). Every
 * other constraint-violating condition stays a hard blocker. `warnings`
 * are for that cardId case plus things the remote schema genuinely has no
 * opinion about (e.g. an unrecognised category id, which has no FK on the
 * server at all).
 */
export function checkMigrationReadiness(
  snapshot: MigrationSnapshot,
  context: MigrationReadinessContext,
): MigrationReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const { data } = snapshot;

  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    blockers.push(`지원하지 않는 로컬 데이터 버전이에요 (schemaVersion ${snapshot.schemaVersion})`);
  }
  if (!context.hasActiveHousehold) {
    blockers.push('연결된 우리집 가계부가 없어요');
  } else if (!context.isOwner) {
    blockers.push('기존 데이터 가져오기는 방장만 진행할 수 있어요');
  }
  if (context.alreadyImported) {
    blockers.push('이 우리집 가계부는 이미 기존 데이터를 가져왔어요');
  }

  const cardIds = new Set(data.cards.map((c) => c.id));
  const cats = knownCategoryIds(data);

  let danglingCard = 0;
  let nonPositiveTxnAmount = 0;
  let badInstallment = 0;
  let unknownTxnCategory = 0;
  let provenanceCount = 0;

  for (const t of data.transactions) {
    if (t.cardId && !cardIds.has(t.cardId)) danglingCard++;
    if (!(t.amount > 0)) nonPositiveTxnAmount++;
    if (t.installment && t.installment.months < 2) badInstallment++;
    // Not a dangling-reference check — from_recurring/from_planned are
    // unconditionally dropped on migration (see file header), so whether
    // they'd still resolve locally is irrelevant. This only counts how
    // many transactions lose that provenance tag, for the info note below.
    if (t.fromRecurring || t.fromPlanned) provenanceCount++;

    const known = t.type === 'income' ? cats.income : cats.expense;
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) if (!known.has(s.category)) unknownTxnCategory++;
    } else if (!known.has(t.category)) {
      unknownTxnCategory++;
    }
  }

  // Blockers: would violate the remote composite FK / CHECK constraint outright.
  if (nonPositiveTxnAmount > 0) blockers.push(`${nonPositiveTxnAmount}건의 거래 금액이 0 이하예요`);
  if (badInstallment > 0) blockers.push(`${badInstallment}건의 할부 개월 수가 올바르지 않아요 (2개월 이상이어야 해요)`);

  // Warning: category has no FK on the remote side at all (built-in
  // categories aren't rows; custom ones are, but the column itself is
  // plain text with no constraint) — informational only.
  if (unknownTxnCategory > 0)
    warnings.push(`${unknownTxnCategory}건의 거래가 존재하지 않는 카테고리를 참조하고 있어요`);
  // STEP 16-F1.6 §3: dangling cardId is a warning, not a blocker — the 008
  // RPC nulls card_id for these on import (see file header). Transaction
  // amount/date/memo/category are unaffected either way.
  if (danglingCard > 0) {
    warnings.push(`삭제된 카드와 연결된 거래 ${danglingCard}건은 '카드 미지정'으로 이전돼요`);
  }
  if (provenanceCount > 0) {
    warnings.push(
      `${provenanceCount}건은 반복/예정 지출에서 자동 생성된 거래예요 — 옮긴 뒤에는 이 연결 정보 없이 일반 거래로 저장돼요`,
    );
  }

  // ---- budgets: category reference (warning, no remote FK) + positivity (blocker, real CHECK) ----
  let budgetUnknownCategory = 0;
  let budgetNonPositive = 0;
  for (const [catId, amount] of Object.entries(data.budgets)) {
    if (!cats.expense.has(catId) && !cats.income.has(catId)) budgetUnknownCategory++;
    if (!(amount > 0)) budgetNonPositive++;
  }
  if (budgetUnknownCategory > 0)
    warnings.push(`${budgetUnknownCategory}개의 예산이 존재하지 않는 카테고리를 참조하고 있어요`);
  if (budgetNonPositive > 0) blockers.push(`${budgetNonPositive}개의 예산 금액이 0 이하예요`);

  // ---- goals: target positivity + saved consistency (all real CHECK
  // constraints once saved is applied via the synthetic-movement path —
  // STEP 16-F1.5 §2) ----
  let nonPositiveGoalTarget = 0;
  let negativeGoalSaved = 0;
  for (const g of data.goals) {
    if (!(g.target > 0)) nonPositiveGoalTarget++;
    if (g.saved < 0) negativeGoalSaved++;
  }
  if (nonPositiveGoalTarget > 0) blockers.push(`${nonPositiveGoalTarget}개의 목표 금액이 0 이하예요`);
  if (negativeGoalSaved > 0) blockers.push(`${negativeGoalSaved}개의 목표 저축액이 음수예요`);

  // ---- loans: principal positivity + paid/principal bound (real CHECK)
  // + local paid vs. sum(payments[].principalPart) consistency (STEP
  // 16-F1.5 §3). addLoanPayment/deleteLoanPayment (src/store/store.tsx)
  // always keep these in lockstep in the same mutation, so a mismatch
  // here means either historical data predating that invariant or a
  // restored backup from an inconsistent state — never auto-corrected.
  let nonPositiveLoanPrincipal = 0;
  let loanPaidExceedsPrincipal = 0;
  let negativeLoanPaid = 0;
  let loanPaidMismatch = 0;
  let loanPaidWithNoPayments = 0;
  for (const l of data.loans) {
    if (!(l.principal > 0)) nonPositiveLoanPrincipal++;
    if (l.paid < 0) negativeLoanPaid++;
    if (l.paid > l.principal) loanPaidExceedsPrincipal++;
    const sumPrincipalPart = l.payments.reduce((sum, p) => sum + p.principalPart, 0);
    if (l.payments.length === 0 && l.paid > 0) {
      loanPaidWithNoPayments++;
    } else if (l.paid !== sumPrincipalPart) {
      loanPaidMismatch++;
    }
  }
  if (nonPositiveLoanPrincipal > 0) blockers.push(`${nonPositiveLoanPrincipal}건의 대출 원금이 0 이하예요`);
  if (negativeLoanPaid > 0) blockers.push(`${negativeLoanPaid}건의 대출 상환액이 음수예요`);
  if (loanPaidExceedsPrincipal > 0)
    blockers.push(`${loanPaidExceedsPrincipal}건의 대출 상환액이 원금을 초과해요`);
  if (loanPaidWithNoPayments > 0)
    blockers.push(
      `${loanPaidWithNoPayments}건의 대출에 상환 기록 없이 상환액만 남아있어요 — 옮기면 상환 내역이 사라질 수 있어요`,
    );
  if (loanPaidMismatch > 0)
    blockers.push(`${loanPaidMismatch}건의 대출 상환액이 상환 기록 합계와 달라요`);

  return { ready: blockers.length === 0, blockers, warnings, counts: snapshot.counts };
}

/* ------------------------------------------------------------------ *
 * STEP 16-F2: local snapshot -> public.import_household_snapshot payload
 *
 * Pure transform, `snapshot.data` -> the exact snake_case JSON shape the
 * 008 RPC (supabase/migrations/20260906000800_household_import.sql)
 * destructures via `jsonb_to_recordset`. Field names/types below were
 * copied directly from that file's `x(...)` column lists, not guessed.
 * Never mutates `snapshot.data` — every entity is rebuilt via `.map()`/
 * `.flatMap()` into new arrays/objects. Only call this once
 * `checkMigrationReadiness(...).ready` is true; it does not re-validate
 * anything itself.
 * ------------------------------------------------------------------ */

export interface HouseholdImportPayload {
  custom_categories: {
    id: string;
    type: TxnType;
    name: string;
    bg: string;
    color: string;
    icon: string;
  }[];
  cards: {
    id: string;
    name: string;
    color_bg: string | null;
    color_fg: string | null;
    payment_day: number | null;
    closing_day: number | null;
  }[];
  recurring_rules: {
    id: string;
    type: TxnType;
    name: string;
    amount: number;
    category: string;
    frequency: Frequency;
    day_of_month: number | null;
    day_of_week: number | null;
    active: boolean;
    last_run: string | null;
  }[];
  planned_expenses: {
    id: string;
    name: string;
    amount: number;
    category: string;
    date: string;
    memo: string;
    type: TxnType;
  }[];
  goals: {
    id: string;
    name: string;
    target: number;
    /** Not written directly to goals.saved by the RPC — seeds exactly one
     * synthetic goal_movements row (id = goalSavedMigrationMovementId(id)),
     * skipped when 0. See this file's header / STEP 16-F1.5 §2. */
    saved: number;
    deadline: string | null;
    icon: string;
  }[];
  loans: {
    id: string;
    name: string;
    lender: string;
    principal: number;
    annual_rate: number;
    term_months: number;
    start_date: string;
    payment_day: number;
    repay_type: LoanRepayType;
    /* `paid` deliberately absent — reconstructed remotely from
     * loan_payments by the existing trg_apply_loan_payment trigger. */
  }[];
  loan_payments: {
    id: string;
    loan_id: string;
    date: string;
    amount: number;
    principal_part: number;
    interest_part: number;
    memo: string | null;
  }[];
  transactions: {
    id: string;
    type: TxnType;
    category: string;
    amount: number;
    memo: string;
    date: string;
    payment_method: PaymentMethod | null;
    card_id: string | null;
    installment_months: number | null;
    splits: TransactionSplit[] | null;
    tags: string[] | null;
    /* from_recurring / from_planned / recurring_occurrence_date are never
     * included — STEP 16-F1.5 §4 policy C/D, see this file's header. */
  }[];
  budgets: { category_id: string; amount: number }[];
  household_settings: {
    notes: string;
    cat_order_expense: string[];
    cat_order_income: string[];
  };
}

/**
 * Builds the RPC payload from a (presumed-ready) snapshot. `created_by` /
 * `imported_by` are never included anywhere in this shape — the RPC always
 * derives that from its own server-side `auth.uid()` (STEP 16-F1.6 §1); the
 * client cannot set it even if it tried.
 */
export function buildHouseholdImportPayload(snapshot: MigrationSnapshot): HouseholdImportPayload {
  const { data } = snapshot;
  // STEP 16-F2 §2 policy E: mirrors the readiness checker's own dangling-
  // cardId test above — a transaction pointing at a card id that isn't
  // (any longer) among this device's local cards is sent with card_id
  // null rather than a stale id. The 008 RPC re-checks this itself against
  // the cards it just inserted (belt-and-braces, not a trust boundary —
  // that server-side check is what actually matters); this keeps the
  // payload internally consistent with what the preview screen already
  // told the owner would happen.
  const localCardIds = new Set(data.cards.map((c) => c.id));

  return {
    custom_categories: [
      ...data.customCats.expense.map((c) => ({
        id: c.id,
        type: 'expense' as const,
        name: c.name,
        bg: c.bg,
        color: c.color,
        icon: c.icon as string,
      })),
      ...data.customCats.income.map((c) => ({
        id: c.id,
        type: 'income' as const,
        name: c.name,
        bg: c.bg,
        color: c.color,
        icon: c.icon as string,
      })),
    ],
    cards: data.cards.map((c) => ({
      id: c.id,
      name: c.name,
      color_bg: c.color?.bg ?? null,
      color_fg: c.color?.color ?? null,
      payment_day: c.paymentDay ?? null,
      closing_day: c.closingDay ?? null,
    })),
    recurring_rules: data.recurring.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      amount: r.amount,
      category: r.category,
      frequency: r.frequency,
      day_of_month: r.dayOfMonth ?? null,
      day_of_week: r.dayOfWeek ?? null,
      active: r.active,
      last_run: r.lastRun ?? null,
    })),
    planned_expenses: data.planned.map((p) => ({
      id: p.id,
      name: p.name,
      amount: p.amount,
      category: p.category,
      date: p.date,
      memo: p.memo,
      type: p.type,
    })),
    goals: data.goals.map((g) => ({
      id: g.id,
      name: g.name,
      target: g.target,
      saved: g.saved,
      deadline: g.deadline,
      icon: g.icon,
    })),
    loans: data.loans.map((l) => ({
      id: l.id,
      name: l.name,
      lender: l.lender,
      principal: l.principal,
      annual_rate: l.annualRate,
      term_months: l.termMonths,
      start_date: l.startDate,
      payment_day: l.paymentDay,
      repay_type: l.repayType,
    })),
    loan_payments: data.loans.flatMap((l) =>
      l.payments.map((p) => ({
        id: p.id,
        loan_id: l.id,
        date: p.date,
        amount: p.amount,
        principal_part: p.principalPart,
        interest_part: p.interestPart,
        memo: p.memo ?? null,
      })),
    ),
    transactions: data.transactions.map((t) => ({
      id: t.id,
      type: t.type,
      category: t.category,
      amount: t.amount,
      memo: t.memo,
      date: t.date,
      payment_method: t.paymentMethod ?? null,
      card_id: t.cardId && localCardIds.has(t.cardId) ? t.cardId : null,
      installment_months: t.installment?.months ?? null,
      splits: t.splits && t.splits.length > 0 ? t.splits : null,
      tags: t.tags && t.tags.length > 0 ? t.tags : null,
    })),
    budgets: Object.entries(data.budgets).map(([category_id, amount]) => ({ category_id, amount })),
    household_settings: {
      notes: data.notes,
      cat_order_expense: data.catOrder.expense,
      cat_order_income: data.catOrder.income,
    },
  };
}
