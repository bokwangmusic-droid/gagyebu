/**
 * Dev verification for the local-draft -> budgets INSERT/UPDATE-row mappers
 * and the draft validator (STEP 16-G2-C3-B).
 *
 * Same convention as remoteCardWriteMapping.cases.ts: no test framework is
 * set up in this project, so these are plain data + a runner. Nothing in
 * the app imports this file, so it is not bundled; `tsc --noEmit` still
 * type-checks it. It performs NO Supabase call — it only exercises the pure
 * `buildBudget*()` transforms and `isValidBudgetDraft()`.
 */
import {
  buildBudgetInsert,
  buildBudgetRevive,
  buildBudgetUpdate,
  isValidBudgetDraft,
  type BudgetInsertRow,
  type NewBudgetDraft,
} from '@/lib/remoteBudgetWriteMapping';

const HID = 'hh-1111';

/** Every column the app is allowed to send for a new budget. */
const INSERT_ALLOWED_KEYS: (keyof BudgetInsertRow)[] = ['household_id', 'category_id', 'amount'];

/**
 * Columns that must NEVER appear in a budget payload — server-managed
 * identity/timestamps, plus the two columns that DO NOT EXIST on
 * public.budgets (`id`, `month`) and must never be invented.
 */
const FORBIDDEN_KEYS = ['created_by', 'created_at', 'updated_at', 'id', 'month'];

export interface BudgetMapperCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

function fieldMatch(got: Record<string, unknown>, want: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(want)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(v)) {
      return `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`;
    }
  }
  return null;
}

export function runBudgetMapperCases(): {
  results: BudgetMapperCaseResult[];
  passed: number;
  failed: number;
} {
  const results: BudgetMapperCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---- INSERT ---- */
  {
    const row = buildBudgetInsert({ category: 'food', amount: 100_000 }, { householdId: HID });
    const keys = Object.keys(row);
    const forbidden = keys.filter((k) => FORBIDDEN_KEYS.includes(k));
    const unexpected = keys.filter((k) => !INSERT_ALLOWED_KEYS.includes(k as keyof BudgetInsertRow));
    const miss = fieldMatch(row as unknown as Record<string, unknown>, {
      household_id: HID,
      category_id: 'food',
      amount: 100_000,
    });
    check(
      'INSERT · normal — household_id/category_id/amount only',
      forbidden.length === 0 && unexpected.length === 0 && miss === null,
      [
        forbidden.length ? `forbidden: ${forbidden.join(',')}` : '',
        unexpected.length ? `unexpected: ${unexpected.join(',')}` : '',
        miss ?? '',
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }
  {
    // household_id / category_id come from context+draft, never a stray field.
    const row = buildBudgetInsert({ category: 'c-custom-1', amount: 50_000 }, { householdId: HID });
    check(
      'INSERT · custom category id maps to category_id, no id/month',
      row.category_id === 'c-custom-1' &&
        row.household_id === HID &&
        !('id' in row) &&
        !('month' in row) &&
        !('created_by' in row),
    );
  }

  /* ---- UPDATE (amount only) ---- */
  {
    const row = buildBudgetUpdate({ category: 'food', amount: 120_000 });
    const keys = Object.keys(row);
    check(
      'UPDATE · amount only — no identity/server/deleted_at fields',
      keys.length === 1 && keys[0] === 'amount' && row.amount === 120_000,
      keys.join(','),
    );
  }

  /* ---- revive (amount + deleted_at:null) ---- */
  {
    const row = buildBudgetRevive({ category: 'food', amount: 90_000 });
    const keys = Object.keys(row).sort();
    check(
      'REVIVE · exactly { amount, deleted_at:null }',
      keys.length === 2 &&
        keys[0] === 'amount' &&
        keys[1] === 'deleted_at' &&
        row.amount === 90_000 &&
        row.deleted_at === null,
      Object.keys(row).join(','),
    );
  }

  /* ---- validation ---- */
  const badCases: { name: string; draft: NewBudgetDraft }[] = [
    { name: 'amount 0', draft: { category: 'food', amount: 0 } },
    { name: 'amount negative', draft: { category: 'food', amount: -1 } },
    { name: 'amount NaN', draft: { category: 'food', amount: Number.NaN } },
    { name: 'amount Infinity', draft: { category: 'food', amount: Number.POSITIVE_INFINITY } },
    { name: 'empty category', draft: { category: '', amount: 1000 } },
    { name: 'whitespace category', draft: { category: '   ', amount: 1000 } },
  ];
  for (const c of badCases) {
    check(`validation rejects: ${c.name}`, isValidBudgetDraft(c.draft) === false);
  }
  check('validation accepts a normal draft', isValidBudgetDraft({ category: 'food', amount: 100_000 }) === true);

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
