/**
 * Global app store — React Context over the same data slices the web
 * version kept in localStorage. Each slice is hydrated from AsyncStorage on
 * mount and written back on change. Keys stay `gagyebu.*` so the text
 * backup format is portable between web and native.
 *
 * Deliberately dependency-free (no Redux/Zustand) for a first pass; the
 * surface is small and can be swapped later without touching screens.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  DEFAULT_CAT_ORDER,
  DEFAULT_CUSTOM_CATS,
  type Category,
  type TxnType,
} from '@/data/categories';
import { expenseByCategory, inRange, totals } from '@/lib/aggregate';
import { splitPayment } from '@/lib/loan';
import { migrate, SCHEMA_VERSION } from '@/lib/migrations';
import { monthRange } from '@/lib/period';
import { loadItem, saveItem } from '@/lib/storage';
import {
  DEFAULT_SETTINGS,
  type AppState,
  type BudgetMap,
  type CreditCard,
  type Goal,
  type Loan,
  type LoanPayment,
  type PlannedExpense,
  type RecurringRule,
  type Settings,
  type Transaction,
} from './types';

const uid = (p: string) =>
  `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_STATE: AppState = {
  seenOnboarding: false,
  transactions: [],
  budgets: {},
  goals: [],
  recurring: [],
  planned: [],
  loans: [],
  cards: [],
  notes: '',
  customCats: DEFAULT_CUSTOM_CATS,
  catOrder: DEFAULT_CAT_ORDER,
  settings: DEFAULT_SETTINGS,
};

interface StoreValue extends AppState {
  hydrated: boolean;

  setSeenOnboarding: (v: boolean) => void;

  addTransaction: (t: Omit<Transaction, 'id' | 'date'> & { date?: string }) => void;
  updateTransaction: (id: string, patch: Partial<Transaction>) => void;
  deleteTransaction: (id: string) => void;

  setBudget: (catId: string, amount: number) => void;
  deleteBudget: (catId: string) => void;
  resetBudgets: () => void;

  addGoal: (g: Omit<Goal, 'id' | 'createdAt' | 'saved'>) => void;
  updateGoal: (id: string, patch: Partial<Goal>) => void;
  deleteGoal: (id: string) => void;

  addRecurring: (r: Omit<RecurringRule, 'id' | 'createdAt' | 'active'>) => void;
  updateRecurring: (id: string, patch: Partial<RecurringRule>) => void;
  toggleRecurring: (id: string) => void;
  deleteRecurring: (id: string) => void;

  addPlanned: (p: Omit<PlannedExpense, 'id' | 'createdAt'>) => void;
  deletePlanned: (id: string) => void;
  markPlannedDone: (p: PlannedExpense) => void;

  addLoan: (l: Omit<Loan, 'id' | 'createdAt' | 'paid' | 'payments'>) => void;
  updateLoan: (id: string, patch: Partial<Loan>) => void;
  deleteLoan: (id: string) => void;
  addLoanPayment: (
    loanId: string,
    entry: { amount: number; date: string; memo?: string },
  ) => void;
  deleteLoanPayment: (loanId: string, paymentId: string) => void;

  addCard: (c: Omit<CreditCard, 'id' | 'createdAt'>) => void;
  updateCard: (id: string, patch: Partial<CreditCard>) => void;
  deleteCard: (id: string) => void;

  setNotes: (v: string) => void;

  addCustomCat: (type: TxnType, cat: Omit<Category, 'id' | 'custom'>) => void;
  deleteCustomCat: (type: TxnType, id: string) => void;
  moveCat: (type: TxnType, id: string, direction: -1 | 1) => void;
  reorderCats: (type: TxnType, orderedIds: string[]) => void;

  setSettings: (patch: Partial<Settings>) => void;

  importData: (raw: string) => boolean;
  resetAll: () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

const PERSIST_KEYS: (keyof AppState)[] = [
  'transactions',
  'budgets',
  'goals',
  'recurring',
  'planned',
  'loans',
  'cards',
  'notes',
  'customCats',
  'catOrder',
  'settings',
];

const KEY_ALIAS: Partial<Record<keyof AppState, string>> = {
  transactions: 'txns',
  seenOnboarding: 'seen',
};

const storeKeyFor = (k: keyof AppState) => KEY_ALIAS[k] ?? k;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);
  const hydratedRef = useRef(false);

  // ---- hydrate ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [
        storedVersion,
        seenOnboarding,
        transactions,
        budgets,
        goals,
        recurring,
        planned,
        loans,
        cards,
        notes,
        customCats,
        catOrder,
        settings,
      ] = await Promise.all([
        loadItem('schemaVersion', 0),
        loadItem('seen', DEFAULT_STATE.seenOnboarding),
        loadItem('txns', DEFAULT_STATE.transactions),
        loadItem('budgets', DEFAULT_STATE.budgets),
        loadItem('goals', DEFAULT_STATE.goals),
        loadItem('recurring', DEFAULT_STATE.recurring),
        loadItem('planned', DEFAULT_STATE.planned),
        loadItem('loans', DEFAULT_STATE.loans),
        loadItem('cards', DEFAULT_STATE.cards),
        loadItem('notes', DEFAULT_STATE.notes),
        loadItem('customCats', DEFAULT_STATE.customCats),
        loadItem('catOrder', DEFAULT_STATE.catOrder),
        loadItem('settings', DEFAULT_STATE.settings),
      ]);
      if (cancelled) return;

      const hydratedState: AppState = {
        seenOnboarding,
        transactions,
        budgets,
        goals,
        recurring,
        planned,
        loans,
        cards,
        notes,
        customCats,
        catOrder,
        settings: { ...DEFAULT_SETTINGS, ...settings },
      };

      // Run any pending schema migrations before the app sees the data.
      const { state: migratedState, from } = migrate(hydratedState, storedVersion);
      setState(migratedState);
      hydratedRef.current = true;
      setHydrated(true);

      // First launch after an update (or a fresh install): write the
      // migrated slices back and stamp the current schema version.
      if (from < SCHEMA_VERSION) {
        for (const k of PERSIST_KEYS) void saveItem(storeKeyFor(k), migratedState[k]);
        void saveItem('schemaVersion', SCHEMA_VERSION);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- persist on change (after hydration only) ----
  const persist = useCallback((next: AppState, keys: (keyof AppState)[]) => {
    if (!hydratedRef.current) return;
    for (const k of keys) void saveItem(storeKeyFor(k), next[k]);
  }, []);

  const mutate = useCallback(
    (updater: (s: AppState) => AppState, keys: (keyof AppState)[]) => {
      setState((prev) => {
        const next = updater(prev);
        persist(next, keys);
        return next;
      });
    },
    [persist],
  );

  // ---- actions ----
  const setSeenOnboarding = useCallback(
    (v: boolean) => {
      setState((p) => ({ ...p, seenOnboarding: v }));
      void saveItem('seen', v);
    },
    [],
  );

  const addTransaction: StoreValue['addTransaction'] = useCallback(
    (t) =>
      mutate(
        (s) => ({
          ...s,
          transactions: [
            {
              id: uid('txn'),
              date: t.date ?? new Date().toISOString(),
              ...t,
            } as Transaction,
            ...s.transactions,
          ],
        }),
        ['transactions'],
      ),
    [mutate],
  );

  const updateTransaction: StoreValue['updateTransaction'] = useCallback(
    (id, patch) =>
      mutate(
        (s) => ({
          ...s,
          transactions: s.transactions.map((t) =>
            t.id === id ? { ...t, ...patch } : t,
          ),
        }),
        ['transactions'],
      ),
    [mutate],
  );

  const deleteTransaction: StoreValue['deleteTransaction'] = useCallback(
    (id) =>
      mutate(
        (s) => ({ ...s, transactions: s.transactions.filter((t) => t.id !== id) }),
        ['transactions'],
      ),
    [mutate],
  );

  const setBudget: StoreValue['setBudget'] = useCallback(
    (catId, amount) =>
      mutate(
        (s) => ({ ...s, budgets: { ...s.budgets, [catId]: amount } }),
        ['budgets'],
      ),
    [mutate],
  );

  const deleteBudget: StoreValue['deleteBudget'] = useCallback(
    (catId) =>
      mutate(
        (s) => {
          const budgets: BudgetMap = { ...s.budgets };
          delete budgets[catId];
          return { ...s, budgets };
        },
        ['budgets'],
      ),
    [mutate],
  );

  const resetBudgets = useCallback(
    () => mutate((s) => ({ ...s, budgets: {} }), ['budgets']),
    [mutate],
  );

  const addGoal: StoreValue['addGoal'] = useCallback(
    (g) =>
      mutate(
        (s) => ({
          ...s,
          goals: [
            ...s.goals,
            { id: uid('goal'), createdAt: new Date().toISOString(), saved: 0, ...g },
          ],
        }),
        ['goals'],
      ),
    [mutate],
  );

  const updateGoal: StoreValue['updateGoal'] = useCallback(
    (id, patch) =>
      mutate(
        (s) => ({
          ...s,
          goals: s.goals.map((g) => (g.id === id ? { ...g, ...patch } : g)),
        }),
        ['goals'],
      ),
    [mutate],
  );

  const deleteGoal: StoreValue['deleteGoal'] = useCallback(
    (id) =>
      mutate((s) => ({ ...s, goals: s.goals.filter((g) => g.id !== id) }), ['goals']),
    [mutate],
  );

  const addRecurring: StoreValue['addRecurring'] = useCallback(
    (r) =>
      mutate(
        (s) => ({
          ...s,
          recurring: [
            ...s.recurring,
            {
              id: uid('rec'),
              createdAt: new Date().toISOString(),
              active: true,
              ...r,
            },
          ],
        }),
        ['recurring'],
      ),
    [mutate],
  );

  const updateRecurring: StoreValue['updateRecurring'] = useCallback(
    (id, patch) =>
      mutate(
        (s) => ({
          ...s,
          recurring: s.recurring.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        }),
        ['recurring'],
      ),
    [mutate],
  );

  const toggleRecurring: StoreValue['toggleRecurring'] = useCallback(
    (id) =>
      mutate(
        (s) => ({
          ...s,
          recurring: s.recurring.map((r) =>
            r.id === id ? { ...r, active: !r.active } : r,
          ),
        }),
        ['recurring'],
      ),
    [mutate],
  );

  const deleteRecurring: StoreValue['deleteRecurring'] = useCallback(
    (id) =>
      mutate(
        (s) => ({ ...s, recurring: s.recurring.filter((r) => r.id !== id) }),
        ['recurring'],
      ),
    [mutate],
  );

  const addPlanned: StoreValue['addPlanned'] = useCallback(
    (p) =>
      mutate(
        (s) => ({
          ...s,
          planned: [
            ...s.planned,
            { id: uid('p'), createdAt: new Date().toISOString(), ...p },
          ],
        }),
        ['planned'],
      ),
    [mutate],
  );

  const deletePlanned: StoreValue['deletePlanned'] = useCallback(
    (id) =>
      mutate(
        (s) => ({ ...s, planned: s.planned.filter((p) => p.id !== id) }),
        ['planned'],
      ),
    [mutate],
  );

  const markPlannedDone: StoreValue['markPlannedDone'] = useCallback(
    (p) =>
      mutate(
        (s) => ({
          ...s,
          transactions: [
            {
              id: uid('txn'),
              type: p.type ?? 'expense',
              category: p.category ?? 'other',
              amount: p.amount,
              memo: p.name + (p.memo ? ` · ${p.memo}` : ''),
              date: new Date().toISOString(),
              fromPlanned: p.id,
            },
            ...s.transactions,
          ],
          planned: s.planned.filter((x) => x.id !== p.id),
        }),
        ['transactions', 'planned'],
      ),
    [mutate],
  );

  const addLoan: StoreValue['addLoan'] = useCallback(
    (l) =>
      mutate(
        (s) => ({
          ...s,
          loans: [
            ...s.loans,
            {
              id: uid('loan'),
              createdAt: new Date().toISOString(),
              paid: 0,
              payments: [],
              ...l,
            },
          ],
        }),
        ['loans'],
      ),
    [mutate],
  );

  const updateLoan: StoreValue['updateLoan'] = useCallback(
    (id, patch) =>
      mutate(
        (s) => ({
          ...s,
          loans: s.loans.map((ln) => (ln.id === id ? { ...ln, ...patch } : ln)),
        }),
        ['loans'],
      ),
    [mutate],
  );

  const deleteLoan: StoreValue['deleteLoan'] = useCallback(
    (id) =>
      mutate((s) => ({ ...s, loans: s.loans.filter((ln) => ln.id !== id) }), ['loans']),
    [mutate],
  );

  const addLoanPayment: StoreValue['addLoanPayment'] = useCallback(
    (loanId, entry) =>
      mutate(
        (s) => ({
          ...s,
          loans: s.loans.map((ln) => {
            if (ln.id !== loanId) return ln;
            const remaining = Math.max(0, ln.principal - ln.paid);
            const { interestPart, principalPart } = splitPayment(
              remaining,
              ln.annualRate,
              entry.amount,
            );
            const payment: LoanPayment = {
              id: uid('lp'),
              date: entry.date,
              amount: entry.amount,
              principalPart,
              interestPart,
              memo: entry.memo,
            };
            return {
              ...ln,
              paid: ln.paid + principalPart,
              payments: [payment, ...ln.payments],
            };
          }),
        }),
        ['loans'],
      ),
    [mutate],
  );

  const deleteLoanPayment: StoreValue['deleteLoanPayment'] = useCallback(
    (loanId, paymentId) =>
      mutate(
        (s) => ({
          ...s,
          loans: s.loans.map((ln) => {
            if (ln.id !== loanId) return ln;
            const p = ln.payments.find((x) => x.id === paymentId);
            if (!p) return ln;
            return {
              ...ln,
              paid: Math.max(0, ln.paid - p.principalPart),
              payments: ln.payments.filter((x) => x.id !== paymentId),
            };
          }),
        }),
        ['loans'],
      ),
    [mutate],
  );

  const addCard: StoreValue['addCard'] = useCallback(
    (c) =>
      mutate(
        (s) => ({
          ...s,
          cards: [
            ...s.cards,
            { id: uid('card'), createdAt: new Date().toISOString(), ...c },
          ],
        }),
        ['cards'],
      ),
    [mutate],
  );

  const updateCard: StoreValue['updateCard'] = useCallback(
    (id, patch) =>
      mutate(
        (s) => ({
          ...s,
          cards: s.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        }),
        ['cards'],
      ),
    [mutate],
  );

  // Deleting a card never touches transactions: rows keep their `cardId` and
  // are shown / billed as "카드 미지정" until reassigned.
  const deleteCard: StoreValue['deleteCard'] = useCallback(
    (id) =>
      mutate((s) => ({ ...s, cards: s.cards.filter((c) => c.id !== id) }), ['cards']),
    [mutate],
  );

  const setNotes: StoreValue['setNotes'] = useCallback(
    (v) => mutate((s) => ({ ...s, notes: v }), ['notes']),
    [mutate],
  );

  const addCustomCat: StoreValue['addCustomCat'] = useCallback(
    (type, cat) => {
      const id = uid('c');
      mutate(
        (s) => ({
          ...s,
          customCats: {
            ...s.customCats,
            [type]: [...s.customCats[type], { ...cat, id, custom: true }],
          },
          catOrder: {
            ...s.catOrder,
            [type]: [...(s.catOrder[type] ?? []), id],
          },
        }),
        ['customCats', 'catOrder'],
      );
    },
    [mutate],
  );

  const deleteCustomCat: StoreValue['deleteCustomCat'] = useCallback(
    (type, id) =>
      mutate(
        (s) => ({
          ...s,
          customCats: {
            ...s.customCats,
            [type]: s.customCats[type].filter((c) => c.id !== id),
          },
          catOrder: {
            ...s.catOrder,
            [type]: (s.catOrder[type] ?? []).filter((x) => x !== id),
          },
        }),
        ['customCats', 'catOrder'],
      ),
    [mutate],
  );

  const moveCat: StoreValue['moveCat'] = useCallback(
    (type, id, direction) =>
      mutate(
        (s) => {
          const cur = s.catOrder[type] ?? [];
          const idx = cur.indexOf(id);
          if (idx === -1) return s;
          const nextIdx = idx + direction;
          if (nextIdx < 0 || nextIdx >= cur.length) return s;
          const list = cur.slice();
          [list[idx], list[nextIdx]] = [list[nextIdx], list[idx]];
          return { ...s, catOrder: { ...s.catOrder, [type]: list } };
        },
        ['catOrder'],
      ),
    [mutate],
  );

  const reorderCats: StoreValue['reorderCats'] = useCallback(
    (type, orderedIds) =>
      mutate(
        (s) => ({ ...s, catOrder: { ...s.catOrder, [type]: orderedIds } }),
        ['catOrder'],
      ),
    [mutate],
  );

  const setSettings: StoreValue['setSettings'] = useCallback(
    (patch) =>
      mutate((s) => ({ ...s, settings: { ...s.settings, ...patch } }), ['settings']),
    [mutate],
  );

  const importData: StoreValue['importData'] = useCallback(
    (raw) => {
      try {
        const parsed = JSON.parse(raw) as Partial<AppState> & { schemaVersion?: number };
        mutate((s) => {
          const merged: AppState = {
            ...s,
            transactions: parsed.transactions ?? s.transactions,
            budgets: parsed.budgets ?? s.budgets,
            goals: parsed.goals ?? s.goals,
            recurring: parsed.recurring ?? s.recurring,
            planned: parsed.planned ?? s.planned,
            loans: parsed.loans ?? s.loans,
            cards: parsed.cards ?? s.cards,
            notes: parsed.notes ?? s.notes,
            customCats: parsed.customCats ?? s.customCats,
            catOrder: parsed.catOrder ?? s.catOrder,
            settings: parsed.settings
              ? { ...DEFAULT_SETTINGS, ...parsed.settings }
              : s.settings,
          };
          // Bring an older backup up to the current schema before it lands.
          return migrate(merged, parsed.schemaVersion ?? 0).state;
        }, PERSIST_KEYS);
        void saveItem('schemaVersion', SCHEMA_VERSION);
        return true;
      } catch {
        return false;
      }
    },
    [mutate],
  );

  const resetAll = useCallback(
    () =>
      mutate(
        (s) => ({
          ...s,
          transactions: [],
          budgets: {},
          goals: [],
          recurring: [],
          planned: [],
          loans: [],
          cards: [],
          notes: '',
          settings: DEFAULT_SETTINGS,
        }),
        PERSIST_KEYS,
      ),
    [mutate],
  );

  const value = useMemo<StoreValue>(
    () => ({
      ...state,
      hydrated,
      setSeenOnboarding,
      addTransaction,
      updateTransaction,
      deleteTransaction,
      setBudget,
      deleteBudget,
      resetBudgets,
      addGoal,
      updateGoal,
      deleteGoal,
      addRecurring,
      updateRecurring,
      toggleRecurring,
      deleteRecurring,
      addPlanned,
      deletePlanned,
      markPlannedDone,
      addLoan,
      updateLoan,
      deleteLoan,
      addLoanPayment,
      deleteLoanPayment,
      addCard,
      updateCard,
      deleteCard,
      setNotes,
      addCustomCat,
      deleteCustomCat,
      moveCat,
      reorderCats,
      setSettings,
      importData,
      resetAll,
    }),
    [
      state,
      hydrated,
      setSeenOnboarding,
      addTransaction,
      updateTransaction,
      deleteTransaction,
      setBudget,
      deleteBudget,
      resetBudgets,
      addGoal,
      updateGoal,
      deleteGoal,
      addRecurring,
      updateRecurring,
      toggleRecurring,
      deleteRecurring,
      addPlanned,
      deletePlanned,
      markPlannedDone,
      addLoan,
      updateLoan,
      deleteLoan,
      addLoanPayment,
      deleteLoanPayment,
      addCard,
      updateCard,
      deleteCard,
      setNotes,
      addCustomCat,
      deleteCustomCat,
      moveCat,
      reorderCats,
      setSettings,
      importData,
      resetAll,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within <StoreProvider>');
  return ctx;
}

/** Derived monthly figures for the current calendar month. */
export function useMonthlyTotals() {
  const { transactions, budgets } = useStore();
  return useMemo(() => {
    // Bound to [month start, next month start) — without the upper bound a
    // transaction dated in a future month would leak into this month's totals.
    const { start, end } = monthRange();
    const thisMonth = inRange(transactions, start, end);
    const { income, expense } = totals(thisMonth);
    const byCategory = expenseByCategory(thisMonth);
    const totalBudget = Object.values(budgets).reduce((s, v) => s + (v || 0), 0);
    return {
      thisMonth,
      income,
      expense,
      byCategory,
      totalBudget,
      remaining: totalBudget - expense,
    };
  }, [transactions, budgets]);
}
