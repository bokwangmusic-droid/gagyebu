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
import { startOfMonth } from '@/lib/format';
import { loadItem, saveItem } from '@/lib/storage';
import {
  DEFAULT_SETTINGS,
  type AppState,
  type BudgetMap,
  type Goal,
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
        seenOnboarding,
        transactions,
        budgets,
        goals,
        recurring,
        planned,
        notes,
        customCats,
        catOrder,
        settings,
      ] = await Promise.all([
        loadItem('seen', DEFAULT_STATE.seenOnboarding),
        loadItem('txns', DEFAULT_STATE.transactions),
        loadItem('budgets', DEFAULT_STATE.budgets),
        loadItem('goals', DEFAULT_STATE.goals),
        loadItem('recurring', DEFAULT_STATE.recurring),
        loadItem('planned', DEFAULT_STATE.planned),
        loadItem('notes', DEFAULT_STATE.notes),
        loadItem('customCats', DEFAULT_STATE.customCats),
        loadItem('catOrder', DEFAULT_STATE.catOrder),
        loadItem('settings', DEFAULT_STATE.settings),
      ]);
      if (cancelled) return;
      setState({
        seenOnboarding,
        transactions,
        budgets,
        goals,
        recurring,
        planned,
        notes,
        customCats,
        catOrder,
        settings: { ...DEFAULT_SETTINGS, ...settings },
      });
      hydratedRef.current = true;
      setHydrated(true);
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
        const parsed = JSON.parse(raw) as Partial<AppState>;
        mutate(
          (s) => ({
            ...s,
            transactions: parsed.transactions ?? s.transactions,
            budgets: parsed.budgets ?? s.budgets,
            goals: parsed.goals ?? s.goals,
            recurring: parsed.recurring ?? s.recurring,
            planned: parsed.planned ?? s.planned,
            notes: parsed.notes ?? s.notes,
            customCats: parsed.customCats ?? s.customCats,
            catOrder: parsed.catOrder ?? s.catOrder,
            settings: parsed.settings
              ? { ...DEFAULT_SETTINGS, ...parsed.settings }
              : s.settings,
          }),
          PERSIST_KEYS,
        );
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
    const som = startOfMonth();
    const thisMonth = transactions.filter((t) => new Date(t.date) >= som);
    const income = thisMonth
      .filter((t) => t.type === 'income')
      .reduce((sum, t) => sum + t.amount, 0);
    const expense = thisMonth
      .filter((t) => t.type === 'expense')
      .reduce((sum, t) => sum + t.amount, 0);
    const byCategory: Record<string, number> = {};
    for (const t of thisMonth) {
      if (t.type !== 'expense') continue;
      byCategory[t.category] = (byCategory[t.category] ?? 0) + t.amount;
    }
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
