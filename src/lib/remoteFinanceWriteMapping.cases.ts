/**
 * Dev verification for the local-draft -> transactions INSERT-row mapper
 * (STEP 16-G2-A).
 *
 * Same rationale as splits.cases.ts / naturalInput.cases.ts: no test
 * framework is set up in this project, so these are plain data + a runner.
 * Nothing in the app imports this file, so it is not bundled; `tsc --noEmit`
 * still type-checks it, catching signature drift. It performs NO Supabase
 * call — it only exercises the pure `buildTransactionInsert()` transform.
 */
import {
  buildTransactionInsert,
  type NewTransactionDraft,
  type TransactionInsertRow,
} from '@/lib/remoteFinanceWriteMapping';

const HID = 'hh-1111';
const TID = 'txn-1700000000000-abc123';

/** Every column the app is allowed to send for a new transaction. */
const ALLOWED_KEYS: (keyof TransactionInsertRow)[] = [
  'id',
  'household_id',
  'member_id',
  'type',
  'category',
  'amount',
  'memo',
  'date',
  'payment_method',
  'card_id',
  'installment_months',
  'splits',
  'tags',
];

/** Server-managed / provenance columns that must NEVER appear in the payload. */
const FORBIDDEN_KEYS = [
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'from_recurring',
  'from_planned',
  'recurring_occurrence_date',
];

export interface MapperCase {
  name: string;
  draft: NewTransactionDraft;
  knownCardIds: string[];
  /** Partial expectations checked field-by-field against the built row. */
  expect: Partial<TransactionInsertRow>;
}

export const MAPPER_CASES: MapperCase[] = [
  {
    name: 'normal expense',
    draft: { type: 'expense', category: 'food', amount: 9000, memo: '점심', date: '2026-09-06T03:00:00.000Z' },
    knownCardIds: [],
    expect: {
      id: TID,
      household_id: HID,
      member_id: null,
      type: 'expense',
      category: 'food',
      amount: 9000,
      memo: '점심',
      date: '2026-09-06T03:00:00.000Z',
      payment_method: null,
      card_id: null,
      installment_months: null,
      splits: null,
      tags: null,
    },
  },
  {
    name: 'income',
    draft: { type: 'income', category: 'salary', amount: 3200000, memo: '', date: '2026-09-01T00:00:00.000Z' },
    knownCardIds: [],
    expect: { type: 'income', category: 'salary', amount: 3200000, memo: '', payment_method: null, card_id: null },
  },
  {
    name: 'credit + known card',
    draft: {
      type: 'expense',
      category: 'shopping',
      amount: 50000,
      memo: '',
      date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit',
      cardId: 'card-A',
    },
    knownCardIds: ['card-A', 'card-B'],
    expect: { payment_method: 'credit', card_id: 'card-A' },
  },
  {
    name: 'credit + unknown card -> card_id null',
    draft: {
      type: 'expense',
      category: 'shopping',
      amount: 50000,
      memo: '',
      date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit',
      cardId: 'card-GONE',
    },
    knownCardIds: ['card-A'],
    expect: { payment_method: 'credit', card_id: null },
  },
  {
    name: 'installment 3',
    draft: {
      type: 'expense',
      category: 'shopping',
      amount: 90000,
      memo: '',
      date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit',
      cardId: 'card-A',
      installment: { months: 3 },
    },
    knownCardIds: ['card-A'],
    expect: { installment_months: 3, card_id: 'card-A' },
  },
  {
    name: 'splits',
    draft: {
      type: 'expense',
      category: 'food',
      amount: 50000,
      memo: '마트',
      date: '2026-09-06T03:00:00.000Z',
      splits: [
        { category: 'food', amount: 30000 },
        { category: 'shopping', amount: 20000 },
      ],
    },
    knownCardIds: [],
    expect: {
      category: 'food',
      amount: 50000,
      splits: [
        { category: 'food', amount: 30000 },
        { category: 'shopping', amount: 20000 },
      ],
    },
  },
  {
    name: 'empty splits array -> null',
    draft: { type: 'expense', category: 'food', amount: 1000, memo: '', date: '2026-09-06T03:00:00.000Z', splits: [] },
    knownCardIds: [],
    expect: { splits: null },
  },
];

export interface MapperCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

function shallowFieldMatch(got: TransactionInsertRow, want: Partial<TransactionInsertRow>): string | null {
  for (const [k, v] of Object.entries(want)) {
    const g = (got as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(g) !== JSON.stringify(v)) {
      return `${k}: got ${JSON.stringify(g)}, want ${JSON.stringify(v)}`;
    }
  }
  return null;
}

export function runMapperCases(cases: MapperCase[] = MAPPER_CASES): {
  results: MapperCaseResult[];
  passed: number;
  failed: number;
} {
  const results = cases.map((c) => {
    const row = buildTransactionInsert(c.draft, {
      id: TID,
      householdId: HID,
      knownCardIds: new Set(c.knownCardIds),
    });

    const keys = Object.keys(row);
    const forbidden = keys.filter((k) => FORBIDDEN_KEYS.includes(k));
    const unexpected = keys.filter((k) => !ALLOWED_KEYS.includes(k as keyof TransactionInsertRow));
    const memberIdOk = row.member_id === null;
    const fieldMiss = shallowFieldMatch(row, c.expect);

    const pass =
      forbidden.length === 0 && unexpected.length === 0 && memberIdOk && fieldMiss === null;

    return {
      name: c.name,
      pass,
      detail: pass
        ? 'ok'
        : [
            forbidden.length ? `forbidden keys: ${forbidden.join(',')}` : '',
            unexpected.length ? `unexpected keys: ${unexpected.join(',')}` : '',
            memberIdOk ? '' : `member_id=${JSON.stringify(row.member_id)} (want null)`,
            fieldMiss ?? '',
          ]
            .filter(Boolean)
            .join(' · '),
    };
  });

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
