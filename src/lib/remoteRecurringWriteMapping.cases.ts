/**
 * Dev verification for the recurring-rule INSERT/UPDATE-row mappers and the
 * draft validator (STEP 16-G2-D2).
 *
 * Same convention as remotePlannedWriteMapping.cases.ts: no test framework
 * in this project, so these are plain data + a runner. Nothing imports this
 * file (not bundled); `tsc --noEmit` still type-checks it. No Supabase call
 * — only the pure transforms.
 */
import {
  buildRecurringInsert,
  buildRecurringUpdate,
  isValidRecurringDraft,
  type NewRecurringDraft,
  type RecurringInsertRow,
} from '@/lib/remoteRecurringWriteMapping';

const HID = 'hh-1111';
const RID = 'rec-1700000000000-abc123';

/** Every column the app may send for a new recurring rule. `active` is NOT
 *  here — it is left to the DB default; `last_run` is never written. */
const INSERT_ALLOWED_KEYS: (keyof RecurringInsertRow)[] = [
  'id',
  'household_id',
  'type',
  'name',
  'amount',
  'category',
  'frequency',
  'day_of_month',
  'day_of_week',
];

/** Server-managed / product-immutable columns that must NEVER be in an
 *  INSERT payload. */
const INSERT_FORBIDDEN_KEYS = [
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'last_run',
  'active',
];

/** UPDATE additionally must never carry `type` / `active` (own action) or
 *  identity/filters. */
const UPDATE_FORBIDDEN_KEYS = [
  'type',
  'active',
  'id',
  'household_id',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'last_run',
];
const UPDATE_ALLOWED_KEYS = [
  'name',
  'amount',
  'category',
  'frequency',
  'day_of_month',
  'day_of_week',
];

export interface RecurringMapperCaseResult {
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

const MONTHLY: NewRecurringDraft = {
  type: 'expense',
  name: '  넷플릭스  ',
  amount: 17_000,
  category: 'subscribe',
  frequency: 'monthly',
  dayOfMonth: 15,
  dayOfWeek: null,
};

const WEEKLY: NewRecurringDraft = {
  type: 'income',
  name: '주급',
  amount: 300_000,
  category: 'salary',
  frequency: 'weekly',
  dayOfMonth: null,
  dayOfWeek: 5,
};

export function runRecurringMapperCases(): {
  results: RecurringMapperCaseResult[];
  passed: number;
  failed: number;
} {
  const results: RecurringMapperCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---- 1. CREATE mapper normal (monthly) ---- */
  {
    const row = buildRecurringInsert(MONTHLY, { id: RID, householdId: HID });
    const keys = Object.keys(row);
    check(
      'INSERT · monthly — schedule fields only, name trimmed, day_of_week nulled, no active/last_run',
      keys.filter((k) => INSERT_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !INSERT_ALLOWED_KEYS.includes(k as keyof RecurringInsertRow)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          id: RID,
          household_id: HID,
          type: 'expense',
          name: '넷플릭스',
          amount: 17_000,
          category: 'subscribe',
          frequency: 'monthly',
          day_of_month: 15,
          day_of_week: null,
        }) === null,
      keys.join(','),
    );
  }

  /* ---- 1b. CREATE mapper normal (weekly) — opposite day field nulled ---- */
  {
    const row = buildRecurringInsert(WEEKLY, { id: RID, householdId: HID });
    check(
      'INSERT · weekly — day_of_month explicitly null, day_of_week carried, type=income',
      row.frequency === 'weekly' &&
        row.day_of_month === null &&
        row.day_of_week === 5 &&
        row.type === 'income' &&
        !('active' in row) &&
        !('last_run' in row) &&
        !('created_by' in row),
    );
  }

  /* ---- 2. invalid amount rejected ---- */
  check('validate · amount 0 rejected', isValidRecurringDraft({ ...MONTHLY, amount: 0 }) === false);
  check('validate · negative amount rejected', isValidRecurringDraft({ ...MONTHLY, amount: -1 }) === false);
  check(
    'validate · NaN / Infinity amount rejected',
    isValidRecurringDraft({ ...MONTHLY, amount: NaN }) === false &&
      isValidRecurringDraft({ ...MONTHLY, amount: Infinity }) === false,
  );

  /* ---- 3. invalid name / category / type / frequency ---- */
  check('validate · empty name rejected', isValidRecurringDraft({ ...MONTHLY, name: '   ' }) === false);
  check('validate · empty category rejected', isValidRecurringDraft({ ...MONTHLY, category: '  ' }) === false);
  check('validate · bad type rejected', isValidRecurringDraft({ ...MONTHLY, type: 'both' as unknown as 'expense' }) === false);
  check(
    'validate · bad frequency rejected',
    isValidRecurringDraft({ ...MONTHLY, frequency: 'yearly' as unknown as 'monthly' }) === false,
  );

  /* ---- 4. day-of-month / day-of-week bounds ---- */
  check('validate · dayOfMonth 0 rejected', isValidRecurringDraft({ ...MONTHLY, dayOfMonth: 0 }) === false);
  check('validate · dayOfMonth 32 rejected', isValidRecurringDraft({ ...MONTHLY, dayOfMonth: 32 }) === false);
  check('validate · dayOfMonth 1 accepted', isValidRecurringDraft({ ...MONTHLY, dayOfMonth: 1 }) === true);
  check('validate · dayOfMonth 31 accepted', isValidRecurringDraft({ ...MONTHLY, dayOfMonth: 31 }) === true);
  check('validate · dayOfMonth non-int rejected', isValidRecurringDraft({ ...MONTHLY, dayOfMonth: 15.5 }) === false);
  check('validate · dayOfMonth null while monthly rejected', isValidRecurringDraft({ ...MONTHLY, dayOfMonth: null }) === false);
  check('validate · dayOfWeek -1 rejected', isValidRecurringDraft({ ...WEEKLY, dayOfWeek: -1 }) === false);
  check('validate · dayOfWeek 7 rejected', isValidRecurringDraft({ ...WEEKLY, dayOfWeek: 7 }) === false);
  check('validate · dayOfWeek 0 accepted (일)', isValidRecurringDraft({ ...WEEKLY, dayOfWeek: 0 }) === true);
  check('validate · dayOfWeek 6 accepted (토)', isValidRecurringDraft({ ...WEEKLY, dayOfWeek: 6 }) === true);
  check('validate · dayOfWeek null while weekly rejected', isValidRecurringDraft({ ...WEEKLY, dayOfWeek: null }) === false);
  check(
    'validate · monthly ignores a bad dayOfWeek / weekly ignores a bad dayOfMonth',
    isValidRecurringDraft({ ...MONTHLY, dayOfWeek: 99 }) === true &&
      isValidRecurringDraft({ ...WEEKLY, dayOfMonth: 99 }) === true,
  );
  check('validate · clean monthly + weekly accepted', isValidRecurringDraft(MONTHLY) === true && isValidRecurringDraft(WEEKLY) === true);

  /* ---- 5. UPDATE mapper omits identity + type + active + last_run ---- */
  {
    const row = buildRecurringUpdate({ ...MONTHLY });
    const keys = Object.keys(row);
    check(
      'UPDATE · schedule fields only — NO type / active / id / last_run / server fields',
      keys.filter((k) => UPDATE_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !UPDATE_ALLOWED_KEYS.includes(k)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          name: '넷플릭스',
          amount: 17_000,
          category: 'subscribe',
          frequency: 'monthly',
          day_of_month: 15,
          day_of_week: null,
        }) === null,
      keys.join(','),
    );
  }
  {
    // monthly -> weekly edit must null day_of_month and set day_of_week.
    const row = buildRecurringUpdate({ ...MONTHLY, frequency: 'weekly', dayOfWeek: 2 });
    check(
      'UPDATE · monthly->weekly clears day_of_month, sets day_of_week',
      row.frequency === 'weekly' && row.day_of_month === null && row.day_of_week === 2,
    );
  }
  {
    // Even when the draft carries a different type, the mapper must not surface it.
    const row = buildRecurringUpdate({ ...MONTHLY, type: 'income' });
    check('UPDATE · draft.type never leaks into the PATCH body', !('type' in row));
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
