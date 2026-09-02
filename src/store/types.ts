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

/** 원리금균등상환 | 만기일시상환(이자만 매달, 원금은 만기) */
export type LoanRepayType = 'amortizing' | 'bullet';

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

export interface Settings {
  budgetAlert: boolean;
  recurringAlert: boolean;
  cloudBackup: boolean;
  quickPaste: boolean;
  profileName: string;
  profileEmail: string;
}

export interface AppState {
  seenOnboarding: boolean;
  transactions: Transaction[];
  budgets: BudgetMap;
  goals: Goal[];
  recurring: RecurringRule[];
  planned: PlannedExpense[];
  loans: Loan[];
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
