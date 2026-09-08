import type { CatOrderMap, CustomCatMap, TxnType } from '@/data/categories';

/** How a transaction was paid. Optional — absent on legacy rows. */
export type PaymentMethod = 'cash' | 'debit' | 'credit' | 'transfer' | 'other';

/**
 * One slice of a split transaction. `amount` is positive; the slices of a
 * transaction are expected to sum to its `amount` (validation lives at the
 * input layer, not here).
 */
export interface TransactionSplit {
  category: string;
  amount: number;
  memo?: string;
}

/**
 * Instalment plan for a single credit-card purchase. `months >= 2`
 * (1 month = 일시불, which stores no `installment` at all). The plan's start
 * month is the parent transaction's `date` month — not stored here. The
 * per-month charge is always a derived value (see `src/lib/card.ts`); the
 * transaction's `amount` stays the full purchase price.
 */
export interface TransactionInstallment {
  months: number;
}

export interface Transaction {
  id: string;
  type: TxnType;
  category: string;
  amount: number;
  memo: string;
  date: string; // ISO
  fromRecurring?: string;
  fromPlanned?: string;

  /* ---- extension fields — all optional; absent = current behaviour ---- */
  /** Payment instrument. Foundation for card / 할부 tracking. */
  paymentMethod?: PaymentMethod;
  /** Which registered card was used. Only meaningful when `paymentMethod === 'credit'`. */
  cardId?: string;
  /** Present = 할부; absent = 일시불. Never materialised as separate rows. */
  installment?: TransactionInstallment;
  /**
   * Per-category breakdown of a single payment. When present and non-empty,
   * per-category aggregation uses these instead of `category` / `amount`.
   */
  splits?: TransactionSplit[];
  /** Owner within a shared (부부/가족) ledger. Absent = the single local user. */
  memberId?: string;
  /** Free-form labels. */
  tags?: string[];
}

/**
 * A credit card the user registered. `closingDay` / `paymentDay` are stored
 * for display only in the MVP — card billing is computed on the purchase
 * month, not on carrier-specific 이용기간 windows.
 */
export interface CreditCard {
  id: string;
  name: string;
  /** Optional accent colour ({ bg, color } from CAT_COLOR_PALETTE). */
  color?: { bg: string; color: string };
  /** 결제일 1–31 (표시 전용). */
  paymentDay?: number;
  /** 마감일 1–31 (표시 전용, MVP 계산 미사용). */
  closingDay?: number;
  createdAt: string;
}

/** Category id -> monthly budget won. */
export type BudgetMap = Record<string, number>;

export interface Goal {
  id: string;
  name: string;
  target: number;
  saved: number;
  deadline: string | null;
  icon: string;
  createdAt: string;
}

export type Frequency = 'monthly' | 'weekly';

export interface RecurringRule {
  id: string;
  type: TxnType;
  name: string;
  amount: number;
  category: string;
  frequency: Frequency;
  dayOfMonth?: number;
  dayOfWeek?: number;
  active: boolean;
  createdAt: string;
  lastRun?: string;
}

export interface PlannedExpense {
  id: string;
  name: string;
  amount: number;
  category: string;
  date: string; // YYYY-MM-DD
  memo: string;
  type: TxnType;
  createdAt: string;
}

/**
 * 원리금균등상환(매달 총액 고정) | 원금균등상환(매달 원금 고정 + 잔액 이자 →
 * 납입액이 매달 감소) | 만기일시상환(이자만 매달, 원금은 만기).
 */
export type LoanRepayType = 'amortizing' | 'equal_principal' | 'bullet';

export interface LoanPayment {
  id: string;
  date: string; // YYYY-MM-DD
  amount: number; // total paid this time
  principalPart: number; // portion applied to principal
  interestPart: number; // portion applied to interest
  memo?: string;
}

export interface Loan {
  id: string;
  name: string;
  lender: string; // 대출 기관 (빈 문자열 허용)
  principal: number; // 최초 원금
  annualRate: number; // 연이자율 %  e.g. 4.5
  termMonths: number; // 상환 기간(개월)
  startDate: string; // YYYY-MM-DD
  paymentDay: number; // 매월 상환일 1~31
  repayType: LoanRepayType;
  paid: number; // 누적 상환 원금
  payments: LoanPayment[];
  createdAt: string;
}

/**
 * A person in a shared (부부/가족) ledger. STEP 10 roadmap skeleton only — the
 * app is single-user, no UI creates or selects members, and nothing filters
 * transactions by `Transaction.memberId`. Resolved to one default member at
 * runtime (see `src/lib/members.ts`).
 */
export interface Member {
  id: string;
  name: string;
}

export interface Settings {
  budgetAlert: boolean;
  recurringAlert: boolean;
  cloudBackup: boolean;
  quickPaste: boolean;
  profileName: string;
  profileEmail: string;
  /**
   * Shared-ledger roadmap field. Absent on every existing install and backup;
   * kept out of `DEFAULT_SETTINGS` so nothing writes it yet. Read only through
   * `resolveMembers()`, which supplies the default member when it is missing.
   */
  members?: Member[];
}

export interface AppState {
  seenOnboarding: boolean;
  transactions: Transaction[];
  budgets: BudgetMap;
  goals: Goal[];
  recurring: RecurringRule[];
  planned: PlannedExpense[];
  loans: Loan[];
  cards: CreditCard[];
  notes: string;
  customCats: CustomCatMap;
  catOrder: CatOrderMap;
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  budgetAlert: true,
  recurringAlert: true,
  cloudBackup: false,
  quickPaste: false,
  profileName: '나',
  profileEmail: '',
};
