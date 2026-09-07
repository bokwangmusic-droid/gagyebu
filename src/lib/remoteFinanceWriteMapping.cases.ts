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
  buildTransactionUpdate,
  type NewTransactionDraft,
  type TransactionInsertRow,
  type TransactionUpdateRow,
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

/* ================================================================== *
 * UPDATE mapper — STEP 16-G2-B
 * ================================================================== */

/** Every column allowed in a transaction PATCH body. */
const UPDATE_ALLOWED_KEYS: (keyof TransactionUpdateRow)[] = [
  'type',
  'category',
  'amount',
  'memo',
  'date',
  'payment_method',
  'card_id',
  'installment_months',
  'splits',
];

/**
 * Columns that must NEVER appear in a PATCH body: server-locked identity,
 * server-forced timestamps, soft-delete marker, locked provenance, and the
 * two fields the UI has no editor for (must be preserved, not null-ed).
 */
const UPDATE_FORBIDDEN_KEYS = [
  'id',
  'household_id',
  'member_id',
  'tags',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'from_recurring',
  'from_planned',
  'recurring_occurrence_date',
];

export interface UpdateMapperCase {
  name: string;
  draft: NewTransactionDraft;
  knownCardIds: string[];
  /** STEP 16-G2-C2 §5: the transaction's ORIGINAL DB card_id (transactionMeta.rawCardId). */
  originalRawCardId?: string | null;
  expect: Partial<TransactionUpdateRow>;
  /** STEP 16-G2-C2 §5-C: `card_id` must be ABSENT from the built row (dangling link preserved). */
  expectCardIdOmitted?: boolean;
}

export const UPDATE_MAPPER_CASES: UpdateMapperCase[] = [
  {
    name: 'normal expense update',
    draft: { type: 'expense', category: 'food', amount: 12000, memo: '점심 변경', date: '2026-09-06T03:00:00.000Z' },
    knownCardIds: [],
    expect: {
      type: 'expense',
      category: 'food',
      amount: 12000,
      memo: '점심 변경',
      date: '2026-09-06T03:00:00.000Z',
      payment_method: null,
      card_id: null,
      installment_months: null,
      splits: null,
    },
  },
  {
    name: 'income update',
    draft: { type: 'income', category: 'salary', amount: 3300000, memo: '', date: '2026-09-01T00:00:00.000Z' },
    knownCardIds: [],
    expect: { type: 'income', category: 'salary', amount: 3300000, memo: '', payment_method: null, card_id: null },
  },
  {
    name: 'known credit card',
    draft: {
      type: 'expense', category: 'shopping', amount: 40000, memo: '', date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit', cardId: 'card-A',
    },
    knownCardIds: ['card-A', 'card-B'],
    expect: { payment_method: 'credit', card_id: 'card-A' },
  },
  {
    name: 'unknown / dangling card -> null',
    draft: {
      type: 'expense', category: 'shopping', amount: 40000, memo: '', date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit', cardId: 'card-DELETED',
    },
    knownCardIds: ['card-A'],
    expect: { payment_method: 'credit', card_id: null },
  },
  {
    name: 'installment off -> null',
    draft: {
      type: 'expense', category: 'shopping', amount: 40000, memo: '', date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit', cardId: 'card-A',
    },
    knownCardIds: ['card-A'],
    expect: { installment_months: null },
  },
  {
    name: 'installment 6 kept',
    draft: {
      type: 'expense', category: 'shopping', amount: 60000, memo: '', date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit', cardId: 'card-A', installment: { months: 6 },
    },
    knownCardIds: ['card-A'],
    expect: { installment_months: 6 },
  },
  {
    name: 'splits off -> null',
    draft: { type: 'expense', category: 'food', amount: 5000, memo: '', date: '2026-09-06T03:00:00.000Z', splits: [] },
    knownCardIds: [],
    expect: { splits: null },
  },
  {
    name: 'splits kept (order preserved)',
    draft: {
      type: 'expense', category: 'food', amount: 50000, memo: '마트', date: '2026-09-06T03:00:00.000Z',
      splits: [
        { category: 'food', amount: 30000 },
        { category: 'shopping', amount: 20000 },
      ],
    },
    knownCardIds: [],
    expect: {
      splits: [
        { category: 'food', amount: 30000 },
        { category: 'shopping', amount: 20000 },
      ],
    },
  },

  /* ---- STEP 16-G2-C2 §5: deleted-card link preservation on transaction edit ---- */
  {
    // Card was soft-deleted; read model shows cardId=undefined but the DB
    // row still points at it. A memo-only edit must NOT null that link.
    name: 'deleted card + memo-only edit -> card_id omitted (preserved)',
    draft: {
      type: 'expense', category: 'food', amount: 9000, memo: '메모만 변경', date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit',
    },
    knownCardIds: ['card-A'],
    originalRawCardId: 'card-DELETED',
    expect: { memo: '메모만 변경', payment_method: 'credit' },
    expectCardIdOmitted: true,
  },
  {
    name: 'credit -> cash change -> card_id null (even with dangling raw id)',
    draft: {
      type: 'expense', category: 'food', amount: 9000, memo: '', date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'cash',
    },
    knownCardIds: ['card-A'],
    originalRawCardId: 'card-DELETED',
    expect: { payment_method: 'cash', card_id: null },
  },
  {
    name: 'deleted card -> user picks a NEW active card -> new card_id',
    draft: {
      type: 'expense', category: 'shopping', amount: 40000, memo: '', date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit', cardId: 'card-B',
    },
    knownCardIds: ['card-A', 'card-B'],
    originalRawCardId: 'card-DELETED',
    expect: { payment_method: 'credit', card_id: 'card-B' },
  },
  {
    name: 'active card explicitly deselected -> card_id null (raw id was still active)',
    draft: {
      type: 'expense', category: 'shopping', amount: 40000, memo: '', date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit',
    },
    knownCardIds: ['card-A'],
    originalRawCardId: 'card-A',
    expect: { payment_method: 'credit', card_id: null },
  },
  {
    name: 'no raw card id + no selection -> card_id null (never had one)',
    draft: {
      type: 'expense', category: 'shopping', amount: 40000, memo: '', date: '2026-09-06T03:00:00.000Z',
      paymentMethod: 'credit',
    },
    knownCardIds: ['card-A'],
    originalRawCardId: null,
    expect: { payment_method: 'credit', card_id: null },
  },
];

export function runUpdateMapperCases(cases: UpdateMapperCase[] = UPDATE_MAPPER_CASES): {
  results: MapperCaseResult[];
  passed: number;
  failed: number;
} {
  const results = cases.map((c) => {
    const row = buildTransactionUpdate(c.draft, {
      knownCardIds: new Set(c.knownCardIds),
      originalRawCardId: c.originalRawCardId ?? null,
    });
    const keys = Object.keys(row);

    const forbidden = keys.filter((k) => UPDATE_FORBIDDEN_KEYS.includes(k));
    const unexpected = keys.filter((k) => !UPDATE_ALLOWED_KEYS.includes(k as keyof TransactionUpdateRow));

    let fieldMiss: string | null = null;
    for (const [k, v] of Object.entries(c.expect)) {
      const g = (row as unknown as Record<string, unknown>)[k];
      if (JSON.stringify(g) !== JSON.stringify(v)) {
        fieldMiss = `${k}: got ${JSON.stringify(g)}, want ${JSON.stringify(v)}`;
        break;
      }
    }

    const cardIdOmitOk =
      c.expectCardIdOmitted === true ? !('card_id' in row) : true;

    const pass =
      forbidden.length === 0 && unexpected.length === 0 && fieldMiss === null && cardIdOmitOk;
    return {
      name: c.name,
      pass,
      detail: pass
        ? 'ok'
        : [
            forbidden.length ? `forbidden keys: ${forbidden.join(',')}` : '',
            unexpected.length ? `unexpected keys: ${unexpected.join(',')}` : '',
            cardIdOmitOk ? '' : `card_id present (want omitted): ${JSON.stringify(row.card_id)}`,
            fieldMiss ?? '',
          ]
            .filter(Boolean)
            .join(' · '),
    };
  });

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
