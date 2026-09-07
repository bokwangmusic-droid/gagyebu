/**
 * Dev verification for the custom-category INSERT/UPDATE-row mappers, the
 * draft validator and the duplicate-name helper (STEP 16-G2-C4-B).
 *
 * Same convention as remoteBudgetWriteMapping.cases.ts: no test framework
 * in this project, so these are plain data + a runner. Nothing imports this
 * file (not bundled); `tsc --noEmit` still type-checks it. No Supabase
 * call — only the pure transforms.
 */
import { CAT_COLOR_PALETTE } from '@/data/categories';
import {
  buildCustomCategoryInsert,
  buildCustomCategoryUpdate,
  isCategoryNameTaken,
  isValidCustomCategoryDraft,
  type CustomCategoryInsertRow,
  type NewCustomCategoryDraft,
} from '@/lib/remoteCategoryWriteMapping';

const HID = 'hh-1111';
const CID = 'c-1700000000000-abc123';
const VIOLET = { bg: CAT_COLOR_PALETTE[0].bg, color: CAT_COLOR_PALETTE[0].color };

/** Every column the app may send for a new custom category. */
const INSERT_ALLOWED_KEYS: (keyof CustomCategoryInsertRow)[] = [
  'id',
  'household_id',
  'type',
  'name',
  'bg',
  'color',
  'icon',
];

/** Server-managed / product-immutable columns that must NEVER be in a payload. */
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
const UPDATE_ALLOWED_KEYS = ['name', 'bg', 'color', 'icon'];

export interface CategoryMapperCaseResult {
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

export function runCategoryMapperCases(): {
  results: CategoryMapperCaseResult[];
  passed: number;
  failed: number;
} {
  const results: CategoryMapperCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---- INSERT ---- */
  {
    const draft: NewCustomCategoryDraft = {
      type: 'expense',
      name: '반려동물',
      icon: 'heart',
      bg: VIOLET.bg,
      color: VIOLET.color,
    };
    const row = buildCustomCategoryInsert(draft, { id: CID, householdId: HID });
    const keys = Object.keys(row);
    check(
      'INSERT · normal expense — id/household/type/name/bg/color/icon only',
      keys.filter((k) => INSERT_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !INSERT_ALLOWED_KEYS.includes(k as keyof CustomCategoryInsertRow)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          id: CID,
          household_id: HID,
          type: 'expense',
          name: '반려동물',
          bg: VIOLET.bg,
          color: VIOLET.color,
          icon: 'heart',
        }) === null,
      keys.join(','),
    );
  }
  {
    const draft: NewCustomCategoryDraft = {
      type: 'income',
      name: '용돈벌이',
      icon: 'gift',
      bg: VIOLET.bg,
      color: VIOLET.color,
    };
    const row = buildCustomCategoryInsert(draft, { id: CID, householdId: HID });
    check(
      'INSERT · normal income — type carried, no server fields',
      row.type === 'income' &&
        row.household_id === HID &&
        !('created_by' in row) &&
        !('created_at' in row) &&
        !('deleted_at' in row),
    );
  }
  {
    const draft: NewCustomCategoryDraft = {
      type: 'expense',
      name: '  반려동물자기계발커피취미생활  ',
      icon: 'coffee',
      bg: VIOLET.bg,
      color: VIOLET.color,
    };
    const row = buildCustomCategoryInsert(draft, { id: CID, householdId: HID });
    check(
      'INSERT · name trimmed + capped at 12 chars',
      row.name === '반려동물자기계발커피취미' && row.name.length === 12,
      `name=${JSON.stringify(row.name)} len=${row.name.length}`,
    );
  }

  /* ---- UPDATE ---- */
  {
    const draft: NewCustomCategoryDraft = {
      type: 'expense', // present on the draft but MUST NOT reach the row
      name: '외식데이트',
      icon: 'utensils',
      bg: VIOLET.bg,
      color: VIOLET.color,
    };
    const row = buildCustomCategoryUpdate(draft);
    const keys = Object.keys(row);
    check(
      'UPDATE · name/bg/color/icon only — NO type, NO identity/server fields',
      keys.filter((k) => UPDATE_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !UPDATE_ALLOWED_KEYS.includes(k)).length === 0 &&
        row.name === '외식데이트' &&
        row.bg === VIOLET.bg &&
        row.color === VIOLET.color &&
        row.icon === 'utensils',
      keys.join(','),
    );
  }

  /* ---- validation ---- */
  const bad: { name: string; draft: NewCustomCategoryDraft }[] = [
    { name: 'empty name', draft: { type: 'expense', name: '', icon: 'heart', bg: VIOLET.bg, color: VIOLET.color } },
    { name: 'whitespace name', draft: { type: 'expense', name: '   ', icon: 'heart', bg: VIOLET.bg, color: VIOLET.color } },
    {
      name: 'invalid type',
      // deliberately wrong at runtime
      draft: { type: 'both' as unknown as 'expense', name: 'X', icon: 'heart', bg: VIOLET.bg, color: VIOLET.color },
    },
    {
      name: 'invalid icon',
      draft: { type: 'expense', name: 'X', icon: 'rocket' as unknown as 'heart', bg: VIOLET.bg, color: VIOLET.color },
    },
    {
      name: 'mismatched color pair',
      draft: { type: 'expense', name: 'X', icon: 'heart', bg: VIOLET.bg, color: '#000000' },
    },
    {
      name: 'off-palette bg',
      draft: { type: 'expense', name: 'X', icon: 'heart', bg: '#123456', color: VIOLET.color },
    },
  ];
  for (const c of bad) {
    check(`validation rejects: ${c.name}`, isValidCustomCategoryDraft(c.draft) === false);
  }
  check(
    'validation accepts a normal draft (12-char name still valid)',
    isValidCustomCategoryDraft({
      type: 'expense',
      name: '열두자이름테스트okay',
      icon: 'heart',
      bg: VIOLET.bg,
      color: VIOLET.color,
    }) === true,
  );

  /* ---- duplicate-name helper ---- */
  const existing = ['식비', '교통', '데이트'];
  check('dup: exact built-in name', isCategoryNameTaken('식비', existing) === true);
  check('dup: exact custom name', isCategoryNameTaken('데이트', existing) === true);
  check('dup: case-insensitive', isCategoryNameTaken('Cafe', ['cafe', '식비']) === true);
  check('dup: whitespace normalized', isCategoryNameTaken('  데이트  ', existing) === true);
  check('dup: distinct name is free', isCategoryNameTaken('반려동물', existing) === false);
  check(
    'dup: edit self excluded (caller filters own name out of the list)',
    isCategoryNameTaken('데이트', ['식비', '교통']) === false,
  );

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
