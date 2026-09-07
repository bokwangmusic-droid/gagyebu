/**
 * Dev verification for the local-draft -> cards INSERT/UPDATE-row mappers
 * (STEP 16-G2-C2).
 *
 * Same rationale as remoteFinanceWriteMapping.cases.ts: no test framework
 * is set up in this project, so these are plain data + a runner. Nothing in
 * the app imports this file, so it is not bundled; `tsc --noEmit` still
 * type-checks it, catching signature drift. It performs NO Supabase call —
 * it only exercises the pure `buildCardInsert()` / `buildCardUpdate()`
 * transforms.
 */
import {
  buildCardInsert,
  buildCardUpdate,
  type CardInsertRow,
  type CardUpdateRow,
  type NewCardDraft,
} from '@/lib/remoteCardWriteMapping';

const HID = 'hh-1111';
const CID = 'card-1700000000000-abc123';

/** Every column the app is allowed to send for a new card. */
const INSERT_ALLOWED_KEYS: (keyof CardInsertRow)[] = [
  'id',
  'household_id',
  'name',
  'color_bg',
  'color_fg',
  'payment_day',
  'closing_day',
];

/** Server-managed columns that must NEVER appear in a card payload. */
const FORBIDDEN_KEYS = ['created_by', 'created_at', 'updated_at', 'deleted_at'];

/** Every column allowed in a card PATCH body (no id / household_id here). */
const UPDATE_ALLOWED_KEYS: (keyof CardUpdateRow)[] = [
  'name',
  'color_bg',
  'color_fg',
  'payment_day',
  'closing_day',
];

const UPDATE_FORBIDDEN_KEYS = [
  'id',
  'household_id',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
];

const VIOLET = { bg: '#EDE9FE', color: '#7C63D4' };

export interface CardMapperCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface InsertCase {
  name: string;
  draft: NewCardDraft;
  expect: Partial<CardInsertRow>;
}

export const CARD_INSERT_CASES: InsertCase[] = [
  {
    name: 'normal — name + color + both days',
    draft: { name: '현대카드', color: VIOLET, paymentDay: 15, closingDay: 25 },
    expect: {
      id: CID,
      household_id: HID,
      name: '현대카드',
      color_bg: '#EDE9FE',
      color_fg: '#7C63D4',
      payment_day: 15,
      closing_day: 25,
    },
  },
  {
    name: 'optional days omitted -> null',
    draft: { name: '삼성카드', color: VIOLET },
    expect: { name: '삼성카드', payment_day: null, closing_day: null },
  },
  {
    name: 'no color -> color_bg/color_fg null',
    draft: { name: '무지개카드', paymentDay: 3 },
    expect: { color_bg: null, color_fg: null, payment_day: 3, closing_day: null },
  },
  {
    name: 'id / household_id are injected from context, not the draft',
    draft: { name: 'X' },
    expect: { id: CID, household_id: HID },
  },
];

interface UpdateCase {
  name: string;
  draft: NewCardDraft;
  expect: Partial<CardUpdateRow>;
}

export const CARD_UPDATE_CASES: UpdateCase[] = [
  {
    name: 'normal update',
    draft: { name: '새이름', color: VIOLET, paymentDay: 10, closingDay: 20 },
    expect: {
      name: '새이름',
      color_bg: '#EDE9FE',
      color_fg: '#7C63D4',
      payment_day: 10,
      closing_day: 20,
    },
  },
  {
    name: 'day cleared -> null',
    draft: { name: 'A', color: VIOLET },
    expect: { payment_day: null, closing_day: null },
  },
  {
    name: 'color cleared -> null',
    draft: { name: 'A', paymentDay: 5 },
    expect: { color_bg: null, color_fg: null, payment_day: 5 },
  },
];

function fieldMatch(
  got: Record<string, unknown>,
  want: Record<string, unknown>,
): string | null {
  for (const [k, v] of Object.entries(want)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(v)) {
      return `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`;
    }
  }
  return null;
}

export function runCardMapperCases(): {
  results: CardMapperCaseResult[];
  passed: number;
  failed: number;
} {
  const results: CardMapperCaseResult[] = [];

  for (const c of CARD_INSERT_CASES) {
    const row = buildCardInsert(c.draft, { id: CID, householdId: HID });
    const keys = Object.keys(row);
    const forbidden = keys.filter((k) => FORBIDDEN_KEYS.includes(k));
    const unexpected = keys.filter(
      (k) => !INSERT_ALLOWED_KEYS.includes(k as keyof CardInsertRow),
    );
    const miss = fieldMatch(row as unknown as Record<string, unknown>, c.expect);
    const pass = forbidden.length === 0 && unexpected.length === 0 && miss === null;
    results.push({
      name: `INSERT · ${c.name}`,
      pass,
      detail: pass
        ? 'ok'
        : [
            forbidden.length ? `forbidden: ${forbidden.join(',')}` : '',
            unexpected.length ? `unexpected: ${unexpected.join(',')}` : '',
            miss ?? '',
          ]
            .filter(Boolean)
            .join(' · '),
    });
  }

  for (const c of CARD_UPDATE_CASES) {
    const row = buildCardUpdate(c.draft);
    const keys = Object.keys(row);
    const forbidden = keys.filter((k) => UPDATE_FORBIDDEN_KEYS.includes(k));
    const unexpected = keys.filter(
      (k) => !UPDATE_ALLOWED_KEYS.includes(k as keyof CardUpdateRow),
    );
    const miss = fieldMatch(row as unknown as Record<string, unknown>, c.expect);
    const pass = forbidden.length === 0 && unexpected.length === 0 && miss === null;
    results.push({
      name: `UPDATE · ${c.name}`,
      pass,
      detail: pass
        ? 'ok'
        : [
            forbidden.length ? `forbidden: ${forbidden.join(',')}` : '',
            unexpected.length ? `unexpected: ${unexpected.join(',')}` : '',
            miss ?? '',
          ]
            .filter(Boolean)
            .join(' · '),
    });
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
