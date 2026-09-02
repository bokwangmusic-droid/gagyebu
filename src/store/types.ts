import type { CatOrderMap, CustomCatMap, TxnType } from '@/data/categories';

export interface Transaction {
  id: string;
  type: TxnType;
  category: string;
  amount: number;
  memo: string;
  date: string; // ISO
  fromRecurring?: string;
  fromPlanned?: string;
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
