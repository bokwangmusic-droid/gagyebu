/**
 * Dev verification for the planned-expense INSERT/UPDATE-row mappers, the
 * draft validator and the strict date-key check (STEP 16-G2-D1).
 *
 * Same convention as remoteCategoryWriteMapping.cases.ts: no test framework
 * in this project, so these are plain data + a runner. Nothing imports this
 * file (not bundled); `tsc --noEmit` still type-checks it. No Supabase call
 * — only the pure transforms.
 */
import {
  buildPlannedInsert,
  buildPlannedUpdate,
  isValidDateKey,
  isValidPlannedDraft,
  type NewPlannedExpenseDraft,
  type PlannedInsertRow,
} from '@/lib/remotePlannedWriteMapping';

const HID = 'hh-1111';
const PID = 'p-1700000000000-abc123';

/** Every column the app may send for a new planned expense. */
const INSERT_ALLOWED_KEYS: (keyof PlannedInsertRow)[] = [
  'id',
  'household_id',
  'name',
  'amount',
  'category',
  'date',
  'memo',
  'type',
];

/** Server-managed columns that must NEVER appear in a planned payload. */
const INSERT_FORBIDDEN_KEYS = ['created_by', 'created_at', 'updated_at', 'deleted_at'];

/** UPDATE additionally must never carry `type` (product-immutable) or identity/filters. */
const UPDATE_FORBIDDEN_KEYS = [
  'type',
  'id',
  'household_id',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
];
const UPDATE_ALLOWED_KEYS = ['name', 'amount', 'category', 'date', 'memo'];

export interface PlannedMapperCaseResult {
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

const GOOD: NewPlannedExpenseDraft = {
  name: '  결혼식 축의금  ',
  amount: 100_000,
  category: 'gift',
  date: '2026-10-01',
  memo: '  고등학교 친구  ',
  type: 'expense',
};

export function runPlannedMapperCases(): {
  results: PlannedMapperCaseResult[];
  passed: number;
  failed: number;
} {
  const results: PlannedMapperCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---- 1. CREATE mapper normal ---- */
  {
    const row = buildPlannedInsert(GOOD, { id: PID, householdId: HID });
    const keys = Object.keys(row);
    check(
      'INSERT · normal — id/household/name/amount/category/date/memo/type only, trimmed',
      keys.filter((k) => INSERT_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !INSERT_ALLOWED_KEYS.includes(k as keyof PlannedInsertRow)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          id: PID,
          household_id: HID,
          name: '결혼식 축의금',
          amount: 100_000,
          category: 'gift',
          date: '2026-10-01',
          memo: '고등학교 친구',
          type: 'expense',
        }) === null,
      keys.join(','),
    );
  }
  {
    const row = buildPlannedInsert({ ...GOOD, type: 'income' }, { id: PID, householdId: HID });
    check(
      'INSERT · income type carried, still no server fields',
      row.type === 'income' &&
        !('created_by' in row) &&
        !('created_at' in row) &&
        !('deleted_at' in row),
    );
  }

  /* ---- 2. invalid amount rejected ---- */
  check('validate · amount 0 rejected', isValidPlannedDraft({ ...GOOD, amount: 0 }) === false);
  check('validate · negative amount rejected', isValidPlannedDraft({ ...GOOD, amount: -1 }) === false);
  check(
    'validate · NaN / Infinity amount rejected',
    isValidPlannedDraft({ ...GOOD, amount: NaN }) === false &&
      isValidPlannedDraft({ ...GOOD, amount: Infinity }) === false,
  );

  /* ---- 3. invalid date rejected ---- */
  check('date · empty rejected', isValidDateKey('') === false);
  check('date · non-ISO rejected', isValidDateKey('2026/10/01') === false);
  check('date · slashless digits rejected', isValidDateKey('20261001') === false);
  check('date · month 13 rejected', isValidDateKey('2026-13-01') === false);
  check('date · 2026-02-30 rejected (round-trip)', isValidDateKey('2026-02-30') === false);
  check('date · 2026-10-01 accepted', isValidDateKey('2026-10-01') === true);
  check('validate · bad date rejects whole draft', isValidPlannedDraft({ ...GOOD, date: '2026-02-30' }) === false);
  check('validate · empty category rejected', isValidPlannedDraft({ ...GOOD, category: '   ' }) === false);
  check('validate · empty name rejected', isValidPlannedDraft({ ...GOOD, name: '   ' }) === false);
  check('validate · non-string memo rejected', isValidPlannedDraft({ ...GOOD, memo: 5 as unknown as string }) === false);
  check('validate · bad type rejected', isValidPlannedDraft({ ...GOOD, type: 'both' as unknown as 'expense' }) === false);
  check('validate · a clean draft is accepted', isValidPlannedDraft(GOOD) === true);

  /* ---- 4/5. UPDATE mapper omits identity + type ---- */
  {
    const row = buildPlannedUpdate({ ...GOOD, type: 'expense' });
    const keys = Object.keys(row);
    check(
      'UPDATE · name/amount/category/date/memo only — NO type, NO identity/server fields',
      keys.filter((k) => UPDATE_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !UPDATE_ALLOWED_KEYS.includes(k)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          name: '결혼식 축의금',
          amount: 100_000,
          category: 'gift',
          date: '2026-10-01',
          memo: '고등학교 친구',
        }) === null,
      keys.join(','),
    );
  }
  {
    // Even when the draft carries a different type than the row, the mapper
    // must not surface it — the caller keeps the row's original type.
    const row = buildPlannedUpdate({ ...GOOD, type: 'income' });
    check('UPDATE · draft.type never leaks into the PATCH body', !('type' in row));
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
