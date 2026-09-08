/**
 * Dev verification for the savings-goal INSERT/UPDATE-row mappers, the
 * goal_movements INSERT mapper and both draft validators (STEP 16-G2-D3).
 *
 * Same convention as remoteRecurringWriteMapping.cases.ts: no test
 * framework in this project, so these are plain data + a runner. Nothing
 * imports this file (not bundled); `tsc --noEmit` still type-checks it. No
 * Supabase call — only the pure transforms.
 */
import {
  buildGoalInsert,
  buildGoalMovementInsert,
  buildGoalUpdate,
  isValidGoalDraft,
  isValidGoalMovementDraft,
  type GoalInsertRow,
  type GoalMovementInsertRow,
  type NewGoalDraft,
} from '@/lib/remoteGoalWriteMapping';

const HID = 'hh-1111';
const GID = 'goal-1700000000000-abc123';
const MID = 'gm-1700000000000-def456';

/** Every column the app may send for a new goal. `saved` is NOT here. */
const GOAL_INSERT_ALLOWED_KEYS: (keyof GoalInsertRow)[] = [
  'id',
  'household_id',
  'name',
  'target',
  'deadline',
  'icon',
];
const GOAL_INSERT_FORBIDDEN_KEYS = [
  'saved',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
];
const GOAL_UPDATE_ALLOWED_KEYS = ['name', 'target', 'deadline', 'icon'];
const GOAL_UPDATE_FORBIDDEN_KEYS = [
  'id',
  'household_id',
  'saved',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
];

/** Every column the app may send for a new movement. */
const MOVE_INSERT_ALLOWED_KEYS: (keyof GoalMovementInsertRow)[] = [
  'id',
  'household_id',
  'goal_id',
  'amount_delta',
];
const MOVE_INSERT_FORBIDDEN_KEYS = [
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'memo',
];

export interface GoalMapperCaseResult {
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

const GOAL: NewGoalDraft = {
  name: '  제주도 여행  ',
  target: 3_000_000,
  deadline: '2026-12-01',
  icon: 'plane',
};

export function runGoalMapperCases(): {
  results: GoalMapperCaseResult[];
  passed: number;
  failed: number;
} {
  const results: GoalMapperCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---- goals CREATE ---- */
  {
    const row = buildGoalInsert(GOAL, { id: GID, householdId: HID });
    const keys = Object.keys(row);
    check(
      'INSERT · normal — id/household/name/target/deadline/icon only, name trimmed, NO saved',
      keys.filter((k) => GOAL_INSERT_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !GOAL_INSERT_ALLOWED_KEYS.includes(k as keyof GoalInsertRow)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          id: GID,
          household_id: HID,
          name: '제주도 여행',
          target: 3_000_000,
          deadline: '2026-12-01',
          icon: 'plane',
        }) === null,
      keys.join(','),
    );
  }
  {
    const row = buildGoalInsert({ ...GOAL, deadline: null }, { id: GID, householdId: HID });
    check('INSERT · deadline null carried through', row.deadline === null && !('saved' in row));
  }

  /* ---- goals validation ---- */
  check('validate · empty name rejected', isValidGoalDraft({ ...GOAL, name: '   ' }) === false);
  check('validate · target 0 rejected', isValidGoalDraft({ ...GOAL, target: 0 }) === false);
  check('validate · negative target rejected', isValidGoalDraft({ ...GOAL, target: -1 }) === false);
  check('validate · non-integer target rejected', isValidGoalDraft({ ...GOAL, target: 1000.5 }) === false);
  check(
    'validate · NaN / Infinity target rejected',
    isValidGoalDraft({ ...GOAL, target: NaN }) === false &&
      isValidGoalDraft({ ...GOAL, target: Infinity }) === false,
  );
  check('validate · deadline null accepted', isValidGoalDraft({ ...GOAL, deadline: null }) === true);
  check('validate · bad deadline rejected', isValidGoalDraft({ ...GOAL, deadline: '2026-02-30' }) === false);
  check('validate · non-ISO deadline rejected', isValidGoalDraft({ ...GOAL, deadline: '2026/12/01' }) === false);
  check('validate · empty icon rejected', isValidGoalDraft({ ...GOAL, icon: '' }) === false);
  check('validate · clean draft accepted', isValidGoalDraft(GOAL) === true);

  /* ---- goals UPDATE ---- */
  {
    const row = buildGoalUpdate(GOAL);
    const keys = Object.keys(row);
    check(
      'UPDATE · name/target/deadline/icon only — NO saved / id / identity / server fields',
      keys.filter((k) => GOAL_UPDATE_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !GOAL_UPDATE_ALLOWED_KEYS.includes(k)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          name: '제주도 여행',
          target: 3_000_000,
          deadline: '2026-12-01',
          icon: 'plane',
        }) === null,
      keys.join(','),
    );
    check('UPDATE · never carries saved', !('saved' in row));
  }

  /* ---- goal_movements INSERT — sign from mode, never a typed minus ---- */
  {
    const row = buildGoalMovementInsert({ mode: 'deposit', amount: 50_000 }, { id: MID, householdId: HID, goalId: GID });
    const keys = Object.keys(row);
    check(
      'MOVEMENT · deposit -> +amount, schedule cols only, no created_by/memo',
      keys.filter((k) => MOVE_INSERT_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !MOVE_INSERT_ALLOWED_KEYS.includes(k as keyof GoalMovementInsertRow)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          id: MID,
          household_id: HID,
          goal_id: GID,
          amount_delta: 50_000,
        }) === null,
      keys.join(','),
    );
  }
  {
    const row = buildGoalMovementInsert({ mode: 'withdraw', amount: 30_000 }, { id: MID, householdId: HID, goalId: GID });
    check('MOVEMENT · withdraw -> -amount', row.amount_delta === -30_000);
  }
  {
    // Even a (malformed) negative amount is normalised by magnitude + mode.
    const row = buildGoalMovementInsert({ mode: 'deposit', amount: -40_000 as number }, { id: MID, householdId: HID, goalId: GID });
    check('MOVEMENT · magnitude taken from |amount|, sign from mode', row.amount_delta === 40_000);
  }

  /* ---- movement validation ---- */
  check('move-validate · amount 0 rejected', isValidGoalMovementDraft({ mode: 'deposit', amount: 0 }) === false);
  check('move-validate · negative amount rejected', isValidGoalMovementDraft({ mode: 'deposit', amount: -1 }) === false);
  check('move-validate · non-integer amount rejected', isValidGoalMovementDraft({ mode: 'withdraw', amount: 100.5 }) === false);
  check(
    'move-validate · NaN / Infinity rejected',
    isValidGoalMovementDraft({ mode: 'deposit', amount: NaN }) === false &&
      isValidGoalMovementDraft({ mode: 'deposit', amount: Infinity }) === false,
  );
  check('move-validate · bad mode rejected', isValidGoalMovementDraft({ mode: 'set' as unknown as 'deposit', amount: 10 }) === false);
  check('move-validate · deposit 10,000 accepted', isValidGoalMovementDraft({ mode: 'deposit', amount: 10_000 }) === true);
  check('move-validate · withdraw 1 accepted', isValidGoalMovementDraft({ mode: 'withdraw', amount: 1 }) === true);

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
