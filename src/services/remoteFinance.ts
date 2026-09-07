/**
 * Remote household finance READ layer — STEP 16-G1A.
 *
 * The only place in the app that SELECTs the household's financial tables
 * (transactions/cards/budgets/recurring_rules/planned_expenses/goals/
 * loans/loan_payments/custom_categories/household_settings). SELECT only —
 * this module contains no `.insert()`/`.update()`/`.delete()`/`.upsert()`
 * call and no write RPC. Financial writes remain out of scope until a
 * later STEP explicitly adds them; the only existing write path in this
 * app is `src/services/householdImport.ts`'s one-time
 * `import_household_snapshot` RPC, untouched here.
 *
 * Rides the same `authenticated` session src/lib/supabase.ts already holds
 * — no service_role, no extra key. RLS (supabase/migrations/
 * 20260905000400_rls.sql) is what actually scopes every query to rows the
 * caller's household membership allows; every SELECT policy on every table
 * fetched here uses the exact same predicate — `private.is_household_
 * member(household_id)` — for BOTH roles, so an owner and a member calling
 * this with the same household id get identical rows. This module never
 * attempts to bypass or duplicate that check client-side.
 *
 * Soft deletes: every table below except household_settings has a
 * `deleted_at` column, and 20260905000400_rls.sql's own header comment
 * states the design explicitly — "every delete is a soft delete via an
 * UPDATE that sets deleted_at" — so a non-null `deleted_at` means the row
 * is logically gone. Every query here filters `.is('deleted_at', null)`
 * accordingly; nothing here treats a soft-deleted row as live data.
 *
 * Partial-failure policy (STEP 16-G1A §8): `fetchHouseholdFinanceSnapshot`
 * runs every table's query in parallel and returns a single ok/error
 * result — if ANY of them errors, the whole call reports failure. There is
 * no partial/best-effort success; a caller never gets "9 of 10 tables"
 * silently presented as a complete dataset.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

/* ------------------------------------------------------------------ *
 * Remote row DTOs — exactly the columns selected below, snake_case,
 * matching supabase/migrations/20260905000200_household_data.sql. Every
 * row here is already scoped to one household by the query's `.eq(
 * 'household_id', householdId)` — household_id/created_by/created_at (for
 * tables with no local createdAt-equivalent)/updated_at/deleted_at are
 * deliberately NOT selected: they are remote sync/ownership metadata with
 * no 1:1 local-domain-type field (STEP 16-G1A §7), so this module never
 * even fetches them, let alone maps them into the read model in
 * src/lib/remoteFinanceMapping.ts. `created_at` IS selected for the five
 * tables whose local type has a required `createdAt` field (cards/
 * recurring_rules/planned_expenses/goals/loans) — that one is a genuine
 * domain-field overlap, not sync-only metadata.
 *
 * STEP 16-G2-B: `transactions` additionally selects `created_by` and
 * `updated_at`. These are NOT folded into the local `Transaction` domain
 * type — src/lib/remoteFinanceMapping.ts routes them into a SEPARATE
 * `transactionMeta` map. `updated_at` is the optimistic-concurrency token
 * for edit/soft-delete (compared with an exact `.eq('updated_at', …)`), so
 * it must travel as the RAW PostgREST string — never re-parsed through
 * Date/toISOString anywhere.
 *
 * STEP 16-G2-C2: `cards` additionally selects `created_by` and
 * `updated_at`, routed the same way into a separate `cardMeta` map (the
 * CreditCard domain type is untouched). Same opaque-token rule for
 * `updated_at`. `transactions` also gets its raw `card_id` mirrored into
 * `transactionMeta.rawCardId` so a transaction whose card was
 * soft-deleted can be edited without null-ing its real DB `card_id`.
 *
 * STEP 16-G2-C3-B: `budgets` additionally selects `created_by` and
 * `updated_at`, routed into a separate `budgetMeta` map keyed by
 * `category_id` (the BudgetMap domain type — a plain category->amount
 * record — is untouched). Same opaque-token rule for `updated_at`.
 *
 * STEP 16-G2-C4-B: `custom_categories` additionally selects `created_by`
 * and `updated_at`, routed into a separate `categoryMeta` map keyed by the
 * custom category id (the Category domain type is untouched; built-in
 * categories have no meta). Same opaque-token rule for `updated_at`.
 * ------------------------------------------------------------------ */

export interface RemoteCustomCategory {
  id: string;
  type: 'income' | 'expense';
  name: string;
  bg: string;
  color: string;
  icon: string;
  /**
   * STEP 16-G2-C4-B — routed to `categoryMeta`, NOT the Category domain
   * type. `updated_at` is the optimistic-concurrency token for custom
   * category edit / soft-delete (exact `.eq('updated_at', …)`), so it
   * travels as the RAW PostgREST string — never re-parsed through
   * Date/toISOString. `created_by` is author bookkeeping only.
   */
  created_by: string | null;
  updated_at: string;
}

export interface RemoteCard {
  id: string;
  name: string;
  color_bg: string | null;
  color_fg: string | null;
  payment_day: number | null;
  closing_day: number | null;
  created_at: string;
  /**
   * STEP 16-G2-C2 — routed to `cardMeta`, NOT the CreditCard domain type.
   * `updated_at` is the optimistic-concurrency token for card edit /
   * soft-delete (compared with an exact `.eq('updated_at', …)`), so it
   * must travel as the RAW PostgREST string — never re-parsed through
   * Date/toISOString anywhere. `created_by` is author bookkeeping only.
   */
  created_by: string | null;
  updated_at: string;
}

export interface RemoteRecurringRule {
  id: string;
  type: 'income' | 'expense';
  name: string;
  amount: number;
  category: string;
  frequency: 'monthly' | 'weekly';
  day_of_month: number | null;
  day_of_week: number | null;
  active: boolean;
  last_run: string | null;
  created_at: string;
}

export interface RemotePlannedExpense {
  id: string;
  name: string;
  amount: number;
  category: string;
  date: string;
  memo: string;
  type: 'income' | 'expense';
  created_at: string;
}

export interface RemoteGoal {
  id: string;
  name: string;
  target: number;
  saved: number;
  deadline: string | null;
  icon: string;
  created_at: string;
}

export interface RemoteLoan {
  id: string;
  name: string;
  lender: string;
  principal: number;
  annual_rate: number;
  term_months: number;
  start_date: string;
  payment_day: number;
  repay_type: 'amortizing' | 'bullet';
  paid: number;
  created_at: string;
}

export interface RemoteLoanPayment {
  id: string;
  loan_id: string;
  date: string;
  amount: number;
  principal_part: number;
  interest_part: number;
  memo: string | null;
}

export interface RemoteTransaction {
  id: string;
  type: 'income' | 'expense';
  category: string;
  amount: number;
  memo: string;
  date: string;
  from_recurring: string | null;
  from_planned: string | null;
  payment_method: string | null;
  card_id: string | null;
  installment_months: number | null;
  splits: unknown;
  tags: string[] | null;
  member_id: string | null;
  /** STEP 16-G2-B — routed to transactionMeta, NOT the Transaction domain type. */
  created_by: string | null;
  /** Optimistic-concurrency token. RAW PostgREST timestamptz string; never re-serialize. */
  updated_at: string;
}

export interface RemoteBudgetRow {
  category_id: string;
  amount: number;
  /**
   * STEP 16-G2-C3-B — routed to `budgetMeta`, NOT the BudgetMap domain
   * type. `updated_at` is the optimistic-concurrency token for budget edit
   * / soft-delete / tombstone-revive (compared with an exact
   * `.eq('updated_at', …)`), so it must travel as the RAW PostgREST string
   * — never re-parsed through Date/toISOString. `created_by` is author
   * bookkeeping only.
   */
  created_by: string | null;
  updated_at: string;
}

export interface RemoteHouseholdSettings {
  notes: string;
  cat_order_expense: string[];
  cat_order_income: string[];
}

export interface RemoteFinanceRaw {
  customCategories: RemoteCustomCategory[];
  cards: RemoteCard[];
  recurringRules: RemoteRecurringRule[];
  plannedExpenses: RemotePlannedExpense[];
  goals: RemoteGoal[];
  loans: RemoteLoan[];
  loanPayments: RemoteLoanPayment[];
  transactions: RemoteTransaction[];
  budgets: RemoteBudgetRow[];
  householdSettings: RemoteHouseholdSettings | null;
  /**
   * Row count only, from public.goal_movements — NOT mapped into the local
   * read model (STEP 16-G1A §6: no local UI type has any concept of a
   * "movement" — app/goals.tsx's `saved` is a directly store-editable
   * number, and goals.saved already comes straight from the remote cache
   * column the movements trigger maintains). Fetched anyway (a) so a
   * broken goal_movements table/policy still fails this call per the
   * partial-failure policy above rather than silently passing, and (b) as
   * a future integrity-check hook for STEP 16-G2/G3. `head: true` means no
   * row content is transferred at all — count only.
   */
  goalMovementsCount: number;
}

export type RemoteFinanceFetchResult =
  | { ok: true; raw: RemoteFinanceRaw }
  | { ok: false; message: string };

/** Never surfaces raw Postgres/PostgREST internals — mirrors src/store/
 *  household.tsx's describeHouseholdError() / src/services/
 *  householdImport.ts's describeImportError(). Logs nothing (no
 *  console.*) — a SELECT error's message/details could in principle echo
 *  back a filter value, so this module plays it safe and never logs the
 *  raw error object anywhere. */
function describeRemoteFinanceError(error: PostgrestError): string {
  const m = error.message.toLowerCase();
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) {
    return '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
  }
  return '우리집 데이터를 불러오지 못했어요. 잠시 후 다시 시도해주세요.';
}

/**
 * Fetches every finance table for one household, in parallel, read-only.
 * All-or-nothing (STEP 16-G1A §8): the first error found among the 11
 * queries below is what gets reported, and no partial data is returned
 * alongside it.
 */
export async function fetchHouseholdFinanceSnapshot(
  householdId: string,
): Promise<RemoteFinanceFetchResult> {
  const [
    customCategoriesRes,
    cardsRes,
    recurringRulesRes,
    plannedExpensesRes,
    goalsRes,
    loansRes,
    loanPaymentsRes,
    transactionsRes,
    budgetsRes,
    householdSettingsRes,
    goalMovementsRes,
  ] = await Promise.all([
    supabase
      .from('custom_categories')
      .select('id,type,name,bg,color,icon,created_by,updated_at')
      .eq('household_id', householdId)
      .is('deleted_at', null),
    supabase
      .from('cards')
      .select('id,name,color_bg,color_fg,payment_day,closing_day,created_at,created_by,updated_at')
      .eq('household_id', householdId)
      .is('deleted_at', null),
    supabase
      .from('recurring_rules')
      .select('id,type,name,amount,category,frequency,day_of_month,day_of_week,active,last_run,created_at')
      .eq('household_id', householdId)
      .is('deleted_at', null),
    supabase
      .from('planned_expenses')
      .select('id,name,amount,category,date,memo,type,created_at')
      .eq('household_id', householdId)
      .is('deleted_at', null),
    supabase
      .from('goals')
      .select('id,name,target,saved,deadline,icon,created_at')
      .eq('household_id', householdId)
      .is('deleted_at', null),
    supabase
      .from('loans')
      .select('id,name,lender,principal,annual_rate,term_months,start_date,payment_day,repay_type,paid,created_at')
      .eq('household_id', householdId)
      .is('deleted_at', null),
    supabase
      .from('loan_payments')
      .select('id,loan_id,date,amount,principal_part,interest_part,memo')
      .eq('household_id', householdId)
      .is('deleted_at', null),
    supabase
      .from('transactions')
      .select(
        'id,type,category,amount,memo,date,from_recurring,from_planned,payment_method,card_id,installment_months,splits,tags,member_id,created_by,updated_at',
      )
      .eq('household_id', householdId)
      .is('deleted_at', null),
    supabase
      .from('budgets')
      .select('category_id,amount,created_by,updated_at')
      .eq('household_id', householdId)
      .is('deleted_at', null),
    supabase
      .from('household_settings')
      .select('notes,cat_order_expense,cat_order_income')
      .eq('household_id', householdId)
      .maybeSingle(),
    supabase
      .from('goal_movements')
      .select('id', { count: 'exact', head: true })
      .eq('household_id', householdId)
      .is('deleted_at', null),
  ]);

  const errored = [
    customCategoriesRes,
    cardsRes,
    recurringRulesRes,
    plannedExpensesRes,
    goalsRes,
    loansRes,
    loanPaymentsRes,
    transactionsRes,
    budgetsRes,
    householdSettingsRes,
    goalMovementsRes,
  ].find((r) => r.error);
  if (errored?.error) {
    return { ok: false, message: describeRemoteFinanceError(errored.error) };
  }

  return {
    ok: true,
    raw: {
      customCategories: (customCategoriesRes.data ?? []) as RemoteCustomCategory[],
      cards: (cardsRes.data ?? []) as RemoteCard[],
      recurringRules: (recurringRulesRes.data ?? []) as RemoteRecurringRule[],
      plannedExpenses: (plannedExpensesRes.data ?? []) as RemotePlannedExpense[],
      goals: (goalsRes.data ?? []) as RemoteGoal[],
      loans: (loansRes.data ?? []) as RemoteLoan[],
      loanPayments: (loanPaymentsRes.data ?? []) as RemoteLoanPayment[],
      transactions: (transactionsRes.data ?? []) as RemoteTransaction[],
      budgets: (budgetsRes.data ?? []) as RemoteBudgetRow[],
      householdSettings: (householdSettingsRes.data ?? null) as RemoteHouseholdSettings | null,
      goalMovementsCount: goalMovementsRes.count ?? 0,
    },
  };
}
