/**
 * Remote household finance data -> local domain types — STEP 16-G1A.
 *
 * Pure transform, mirroring src/lib/householdMigration.ts's shape but in
 * the OPPOSITE direction (that file goes local -> remote payload for the
 * one-time import; this one goes remote -> local read model for display).
 * Never touches Supabase, AsyncStorage, or React state — takes a
 * `RemoteFinanceRaw` (src/services/remoteFinance.ts) and returns plain
 * data reusing the app's EXISTING local domain types (Transaction,
 * CreditCard, Goal, RecurringRule, PlannedExpense, Loan, LoanPayment,
 * CustomCatMap, CatOrderMap, BudgetMap) — no new parallel type hierarchy.
 *
 * Deliberately excludes:
 *   - `settings` (profileName/profileEmail/quickPaste/...) — per-device
 *     local preferences, never household financial data. Not part of this
 *     read model at all (STEP 16-G1A §6).
 *   - household_id/created_by/created_at-for-tables-with-no-local-
 *     equivalent/updated_at/deleted_at/goal_movements content — remote
 *     sync/ownership metadata with no 1:1 local-domain field (STEP 16-G1A
 *     §7). `created_at` IS mapped to `createdAt` for cards/recurring/
 *     planned/goals/loans specifically, because those local types already
 *     have a required `createdAt` field that means the same thing — that
 *     is a genuine domain overlap, not sync-only bookkeeping.
 *
 * Dangling transaction.card_id (STEP 16-G1A, same reasoning as the F1.6
 * outbound direction in householdMigration.ts): if a transaction's
 * card_id doesn't resolve among the household's own (non-deleted) cards —
 * e.g. the card was soft-deleted after the transaction was made — it is
 * mapped to `undefined` ("카드 미지정"), matching src/store/store.tsx's
 * deleteCard comment: this is already the app's own established local
 * semantics for that state, not a new one invented here.
 */
import type { CatOrderMap, CustomCatMap, IconKey } from '@/data/categories';
import type { RemoteFinanceRaw } from '@/services/remoteFinance';
import type {
  BudgetMap,
  CreditCard,
  Goal,
  Loan,
  LoanPayment,
  PaymentMethod,
  PlannedExpense,
  RecurringRule,
  Transaction,
  TransactionSplit,
} from '@/store/types';

/**
 * Remote-only bookkeeping for one transaction — STEP 16-G2-B, extended in
 * STEP 16-G2-C2 (`rawCardId`).
 *
 * Kept OUT of the `Transaction` domain type on purpose (G1A §7): `updatedAt`
 * / `createdBy` are sync/ownership metadata, not user-facing ledger data.
 * `updatedAt` is the optimistic-concurrency token for edit / soft-delete —
 * it is the RAW string PostgREST returned and MUST be passed straight back
 * into `.eq('updated_at', …)` with no Date/toISOString round-trip, or the
 * exact-match compare silently never matches.
 *
 * `rawCardId` is the transaction's ORIGINAL `public.transactions.card_id`
 * exactly as stored, WITHOUT the read-model's "dangling card_id ->
 * undefined" collapse applied to `Transaction.cardId`. It exists so a
 * transaction whose card was soft-deleted (DB `card_id` still points at
 * the deleted card, but the read model shows "카드 미지정") can be edited
 * for memo/amount/etc. WITHOUT `buildTransactionUpdate` null-ing that real
 * DB link (STEP 16-G2-C2 §5). The UI read model (`Transaction.cardId`) and
 * this raw DB reference are deliberately separate.
 */
export interface RemoteTransactionMeta {
  updatedAt: string;
  createdBy: string | null;
  rawCardId: string | null;
}

/**
 * Remote-only bookkeeping for one card — STEP 16-G2-C2.
 *
 * Exact mirror of `RemoteTransactionMeta`'s rationale: the `CreditCard`
 * domain type stays free of sync metadata, so `updatedAt` (opaque
 * optimistic-concurrency token — never re-serialised) and `createdBy`
 * (author bookkeeping, never an edit/delete permission input) live here,
 * keyed by card id, parallel to `RemoteFinanceData.cards`.
 */
export interface RemoteCardMeta {
  updatedAt: string;
  createdBy: string | null;
}

/**
 * Remote-only bookkeeping for one budget — STEP 16-G2-C3-B.
 *
 * `public.budgets` has no surrogate id — its natural PK is
 * `(household_id, category_id)` — so this map is keyed by `category_id`,
 * parallel to `RemoteFinanceData.budgets` (a plain category->amount
 * record). Only ACTIVE budgets appear here (the SELECT filters
 * `deleted_at IS NULL`); a category with no live budget simply has no
 * entry. `updatedAt` is the opaque optimistic-concurrency token — never
 * re-serialised; `createdBy` is author bookkeeping only.
 */
export interface RemoteBudgetMeta {
  updatedAt: string;
  createdBy: string | null;
}

/**
 * Remote-only bookkeeping for one CUSTOM category — STEP 16-G2-C4-B.
 *
 * Keyed by the custom category id, parallel to the custom entries inside
 * `RemoteFinanceData.customCats`. Only ACTIVE custom categories appear
 * here (the SELECT filters `deleted_at IS NULL`); built-in categories are
 * not rows and therefore never have an entry — consumers must treat a
 * missing entry for a built-in id as normal, not an error. `updatedAt` is
 * the opaque optimistic-concurrency token — never re-serialised;
 * `createdBy` is author bookkeeping only. The `Category` domain type stays
 * free of this metadata.
 */
export interface RemoteCategoryMeta {
  updatedAt: string;
  createdBy: string | null;
}

/**
 * Remote-only bookkeeping for one PLANNED EXPENSE — STEP 16-G2-D1.
 *
 * Keyed by the planned-expense id, parallel to `RemoteFinanceData.planned`.
 * Only ACTIVE planned expenses appear here (the SELECT filters
 * `deleted_at IS NULL`). `updatedAt` is the opaque optimistic-concurrency
 * token for planned edit / soft-delete — the RAW PostgREST string, never
 * re-serialised. `createdBy` is author bookkeeping only (the 23505
 * idempotency check on CREATE). The `PlannedExpense` domain type stays
 * free of this metadata.
 */
export interface RemotePlannedMeta {
  updatedAt: string;
  createdBy: string | null;
}

/**
 * Remote-only bookkeeping for one RECURRING RULE — STEP 16-G2-D2.
 *
 * Keyed by the recurring-rule id, parallel to `RemoteFinanceData.recurring`.
 * Only ACTIVE (non-soft-deleted) rules appear here (the SELECT filters
 * `deleted_at IS NULL`; a soft-deleted rule has no entry — note this is
 * unrelated to the rule's own `active` on/off flag). `updatedAt` is the
 * opaque optimistic-concurrency token for recurring edit / active-toggle /
 * soft-delete — the RAW PostgREST string, never re-serialised. `createdBy`
 * is author bookkeeping only (the 23505 idempotency check on CREATE). The
 * `RecurringRule` domain type stays free of this metadata, and `last_run`
 * is never written by any client path in this STEP.
 */
export interface RemoteRecurringMeta {
  updatedAt: string;
  createdBy: string | null;
}

/**
 * Remote-only bookkeeping for one SAVINGS GOAL — STEP 16-G2-D3.
 *
 * Keyed by the goal id, parallel to `RemoteFinanceData.goals`. Only
 * non-soft-deleted goals appear (the SELECT filters `deleted_at IS NULL`).
 * `updatedAt` is the opaque optimistic-concurrency token for goal edit /
 * soft-delete — the RAW PostgREST string, never re-serialised. It is also
 * bumped by the `trg_goal_movements` -> `trg_goals_touch` chain whenever a
 * `goal_movements` row changes `goals.saved`, so a goal edit form opened
 * before a deposit/withdrawal correctly conflicts on save (this is
 * intended, not a bug). `createdBy` is author bookkeeping only (the 23505
 * idempotency check on CREATE / movement INSERT). The `Goal` domain type
 * stays free of this metadata, and `saved` is never written directly by
 * any client path.
 */
export interface RemoteGoalMeta {
  updatedAt: string;
  createdBy: string | null;
}

/**
 * Remote-only bookkeeping for one LOAN — STEP 16-G2-D4.
 *
 * Keyed by the loan id, parallel to `RemoteFinanceData.loans`. Only
 * non-soft-deleted loans appear (`deleted_at IS NULL`). `updatedAt` is the
 * opaque optimistic-concurrency token for loan edit / soft-delete — the
 * RAW PostgREST string, never re-serialised. It is also bumped by the
 * `trg_apply_loan_payment` -> `trg_loans_touch` chain whenever a
 * `loan_payments` row changes `loans.paid`, so a loan edit form opened
 * before a repayment correctly conflicts on save (intended). `createdBy`
 * is author bookkeeping only. The `Loan` domain type stays free of this
 * metadata, and `paid` is never written directly by any client path.
 */
export interface RemoteLoanMeta {
  updatedAt: string;
  createdBy: string | null;
}

/**
 * Remote-only bookkeeping for one LOAN PAYMENT — STEP 16-G2-D4.
 *
 * Keyed by the payment id, parallel to the `LoanPayment` entries inside
 * `RemoteFinanceData.loans[].payments`. Only non-soft-deleted payments
 * appear. `updatedAt` is the opaque optimistic-concurrency token for a
 * payment soft-delete — the RAW PostgREST string, never re-serialised.
 * `createdBy` is author bookkeeping only (the 23505 idempotency check on
 * payment INSERT). The `LoanPayment` domain type stays free of this.
 */
export interface RemoteLoanPaymentMeta {
  updatedAt: string;
  createdBy: string | null;
}

/**
 * The read-only, household-financial subset of AppState this app can
 * currently reconstruct from Supabase. Intentionally NOT `AppState` itself
 * (no `seenOnboarding`, no `settings`) — see the file header.
 */
export interface RemoteFinanceData {
  transactions: Transaction[];
  /** id -> remote-only metadata (write/concurrency only, never UI domain). */
  transactionMeta: Record<string, RemoteTransactionMeta>;
  cards: CreditCard[];
  /** card id -> remote-only metadata (write/concurrency only, never UI domain). STEP 16-G2-C2. */
  cardMeta: Record<string, RemoteCardMeta>;
  budgets: BudgetMap;
  /** category_id -> remote-only metadata (write/concurrency only, never UI domain). STEP 16-G2-C3-B. */
  budgetMeta: Record<string, RemoteBudgetMeta>;
  /** custom category id -> remote-only metadata (write/concurrency only, never UI domain). STEP 16-G2-C4-B. */
  categoryMeta: Record<string, RemoteCategoryMeta>;
  recurring: RecurringRule[];
  /** recurring-rule id -> remote-only metadata (write/concurrency only, never UI domain). STEP 16-G2-D2. */
  recurringMeta: Record<string, RemoteRecurringMeta>;
  planned: PlannedExpense[];
  /** planned-expense id -> remote-only metadata (write/concurrency only, never UI domain). STEP 16-G2-D1. */
  plannedMeta: Record<string, RemotePlannedMeta>;
  goals: Goal[];
  /** goal id -> remote-only metadata (write/concurrency only, never UI domain). STEP 16-G2-D3. */
  goalMeta: Record<string, RemoteGoalMeta>;
  loans: Loan[];
  /** loan id -> remote-only metadata (write/concurrency only, never UI domain). STEP 16-G2-D4. */
  loanMeta: Record<string, RemoteLoanMeta>;
  /** loan-payment id -> remote-only metadata (write/concurrency only, never UI domain). STEP 16-G2-D4. */
  loanPaymentMeta: Record<string, RemoteLoanPaymentMeta>;
  customCats: CustomCatMap;
  notes: string;
  catOrder: CatOrderMap;
}

export interface RemoteFinanceCounts {
  transactions: number;
  cards: number;
  budgets: number;
  recurring: number;
  planned: number;
  goals: number;
  loans: number;
  customCategories: number;
}

/** Sum of every migratable-style slice — 0 means a genuinely empty household (STEP 16-G1A §9), not an error. */
export function remoteFinanceCounts(data: RemoteFinanceData): RemoteFinanceCounts {
  return {
    transactions: data.transactions.length,
    cards: data.cards.length,
    budgets: Object.keys(data.budgets).length,
    recurring: data.recurring.length,
    planned: data.planned.length,
    goals: data.goals.length,
    loans: data.loans.length,
    customCategories: data.customCats.expense.length + data.customCats.income.length,
  };
}

export function totalRemoteFinanceCount(counts: RemoteFinanceCounts): number {
  return (
    counts.transactions +
    counts.cards +
    counts.budgets +
    counts.recurring +
    counts.planned +
    counts.goals +
    counts.loans +
    counts.customCategories
  );
}

/** Never mutates `raw`; builds entirely new arrays/objects. */
export function mapRemoteFinanceToReadModel(raw: RemoteFinanceRaw): RemoteFinanceData {
  const cardIds = new Set(raw.cards.map((c) => c.id));

  const cards: CreditCard[] = raw.cards.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color_bg && c.color_fg ? { bg: c.color_bg, color: c.color_fg } : undefined,
    paymentDay: c.payment_day ?? undefined,
    closingDay: c.closing_day ?? undefined,
    createdAt: c.created_at,
  }));

  // Parallel to `cards`, keyed by id. `updatedAt` is stored verbatim (the
  // raw PostgREST timestamptz string) — an opaque concurrency token, never
  // a value to format or re-parse (STEP 16-G2-C2 §2).
  const cardMeta: Record<string, RemoteCardMeta> = {};
  for (const c of raw.cards) {
    cardMeta[c.id] = { updatedAt: c.updated_at, createdBy: c.created_by };
  }

  const customCats: CustomCatMap = { expense: [], income: [] };
  const categoryMeta: Record<string, RemoteCategoryMeta> = {};
  for (const c of raw.customCategories) {
    customCats[c.type].push({
      id: c.id,
      name: c.name,
      bg: c.bg,
      color: c.color,
      icon: c.icon as IconKey, // remote value was only ever written from a valid IconKey
      custom: true,
    });
    // Parallel to the custom entries, keyed by id. `updatedAt` stored
    // verbatim — an opaque concurrency token, never formatted/re-parsed
    // (STEP 16-G2-C4-B §2).
    categoryMeta[c.id] = { updatedAt: c.updated_at, createdBy: c.created_by };
  }

  const paymentsByLoan = new Map<string, LoanPayment[]>();
  const loanPaymentMeta: Record<string, RemoteLoanPaymentMeta> = {};
  for (const p of raw.loanPayments) {
    const list = paymentsByLoan.get(p.loan_id) ?? [];
    list.push({
      id: p.id,
      date: p.date,
      amount: p.amount,
      principalPart: p.principal_part,
      interestPart: p.interest_part,
      memo: p.memo ?? undefined,
    });
    paymentsByLoan.set(p.loan_id, list);
    // Parallel to the payment entries, keyed by payment id. `updatedAt`
    // stored verbatim — an opaque concurrency token (STEP 16-G2-D4).
    loanPaymentMeta[p.id] = { updatedAt: p.updated_at, createdBy: p.created_by };
  }

  const transactions: Transaction[] = raw.transactions.map((t) => ({
    id: t.id,
    type: t.type,
    category: t.category,
    amount: t.amount,
    memo: t.memo,
    date: t.date,
    fromRecurring: t.from_recurring ?? undefined,
    fromPlanned: t.from_planned ?? undefined,
    paymentMethod: (t.payment_method as PaymentMethod | null) ?? undefined,
    cardId: t.card_id && cardIds.has(t.card_id) ? t.card_id : undefined,
    installment: t.installment_months != null ? { months: t.installment_months } : undefined,
    splits: Array.isArray(t.splits) ? (t.splits as TransactionSplit[]) : undefined,
    tags: t.tags ?? undefined,
    memberId: t.member_id ?? undefined,
  }));

  // Parallel to `transactions`, keyed by id. `updatedAt` is stored verbatim
  // (the raw PostgREST timestamptz string) — it is an opaque concurrency
  // token, never a value to format or re-parse (STEP 16-G2-B §4).
  const transactionMeta: Record<string, RemoteTransactionMeta> = {};
  for (const t of raw.transactions) {
    transactionMeta[t.id] = {
      updatedAt: t.updated_at,
      createdBy: t.created_by,
      // Raw DB card_id, WITHOUT the "dangling -> undefined" collapse the
      // read-model `cardId` above gets. STEP 16-G2-C2 §4.
      rawCardId: t.card_id,
    };
  }

  const budgets: BudgetMap = {};
  const budgetMeta: Record<string, RemoteBudgetMeta> = {};
  for (const b of raw.budgets) {
    budgets[b.category_id] = b.amount;
    // Parallel to `budgets`, keyed by category_id. `updatedAt` stored
    // verbatim — an opaque concurrency token, never formatted/re-parsed
    // (STEP 16-G2-C3-B §3).
    budgetMeta[b.category_id] = { updatedAt: b.updated_at, createdBy: b.created_by };
  }

  const recurring: RecurringRule[] = raw.recurringRules.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    amount: r.amount,
    category: r.category,
    frequency: r.frequency,
    dayOfMonth: r.day_of_month ?? undefined,
    dayOfWeek: r.day_of_week ?? undefined,
    active: r.active,
    createdAt: r.created_at,
    lastRun: r.last_run ?? undefined,
  }));

  // Parallel to `recurring`, keyed by id. `updatedAt` stored verbatim — an
  // opaque concurrency token, never formatted/re-parsed (STEP 16-G2-D2).
  const recurringMeta: Record<string, RemoteRecurringMeta> = {};
  for (const r of raw.recurringRules) {
    recurringMeta[r.id] = { updatedAt: r.updated_at, createdBy: r.created_by };
  }

  const planned: PlannedExpense[] = raw.plannedExpenses.map((p) => ({
    id: p.id,
    name: p.name,
    amount: p.amount,
    category: p.category,
    date: p.date,
    memo: p.memo,
    type: p.type,
    createdAt: p.created_at,
  }));

  // Parallel to `planned`, keyed by id. `updatedAt` stored verbatim — an
  // opaque concurrency token, never formatted/re-parsed (STEP 16-G2-D1).
  const plannedMeta: Record<string, RemotePlannedMeta> = {};
  for (const p of raw.plannedExpenses) {
    plannedMeta[p.id] = { updatedAt: p.updated_at, createdBy: p.created_by };
  }

  const goals: Goal[] = raw.goals.map((g) => ({
    id: g.id,
    name: g.name,
    target: g.target,
    saved: g.saved,
    deadline: g.deadline,
    icon: g.icon as IconKey,
    createdAt: g.created_at,
  }));

  // Parallel to `goals`, keyed by id. `updatedAt` stored verbatim — an
  // opaque concurrency token, never formatted/re-parsed (STEP 16-G2-D3).
  const goalMeta: Record<string, RemoteGoalMeta> = {};
  for (const g of raw.goals) {
    goalMeta[g.id] = { updatedAt: g.updated_at, createdBy: g.created_by };
  }

  const loans: Loan[] = raw.loans.map((l) => ({
    id: l.id,
    name: l.name,
    lender: l.lender,
    principal: l.principal,
    annualRate: l.annual_rate,
    termMonths: l.term_months,
    startDate: l.start_date,
    paymentDay: l.payment_day,
    repayType: l.repay_type,
    paid: l.paid,
    payments: paymentsByLoan.get(l.id) ?? [],
    createdAt: l.created_at,
  }));

  // Parallel to `loans`, keyed by id. `updatedAt` stored verbatim — an
  // opaque concurrency token, never formatted/re-parsed (STEP 16-G2-D4).
  const loanMeta: Record<string, RemoteLoanMeta> = {};
  for (const l of raw.loans) {
    loanMeta[l.id] = { updatedAt: l.updated_at, createdBy: l.created_by };
  }

  return {
    transactions,
    transactionMeta,
    cards,
    cardMeta,
    budgets,
    budgetMeta,
    categoryMeta,
    recurring,
    recurringMeta,
    planned,
    plannedMeta,
    goals,
    goalMeta,
    loans,
    loanMeta,
    loanPaymentMeta,
    customCats,
    notes: raw.householdSettings?.notes ?? '',
    catOrder: {
      expense: raw.householdSettings?.cat_order_expense ?? [],
      income: raw.householdSettings?.cat_order_income ?? [],
    },
  };
}
