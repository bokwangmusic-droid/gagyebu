/**
 * Dev verification for the local-draft -> assets INSERT/UPDATE-row mappers
 * and `isValidAssetDraft` (전체자산/순자산 STEP 4).
 *
 * Same rationale as remoteCardWriteMapping.cases.ts: no test framework is
 * set up in this project, so these are plain data + a runner. Nothing in
 * the app imports this file, so it is not bundled; `tsc --noEmit` still
 * type-checks it. It performs NO Supabase call — it only exercises the
 * pure `buildAssetInsert()` / `buildAssetUpdate()` / `isValidAssetDraft()`
 * functions.
 */
import {
  buildAssetInsert,
  buildAssetUpdate,
  isValidAssetDraft,
  type AssetInsertRow,
  type AssetUpdateRow,
  type NewAssetDraft,
} from '@/lib/remoteAssetWriteMapping';

const HID = 'hh-1111';
const AID = 'asset-1700000000000-abc123';

/** Every column the app is allowed to send for a new asset. */
const INSERT_ALLOWED_KEYS: (keyof AssetInsertRow)[] = [
  'id',
  'household_id',
  'name',
  'type',
  'balance',
];

/** Server-managed columns that must NEVER appear in an asset payload. */
const FORBIDDEN_KEYS = ['created_by', 'created_at', 'updated_at', 'deleted_at'];

/** Every column allowed in an asset PATCH body (no id / household_id here). */
const UPDATE_ALLOWED_KEYS: (keyof AssetUpdateRow)[] = ['name', 'type', 'balance'];

const UPDATE_FORBIDDEN_KEYS = ['id', 'household_id', 'created_by', 'created_at', 'updated_at', 'deleted_at'];

export interface AssetMapperCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface InsertCase {
  name: string;
  draft: NewAssetDraft;
  expect: Partial<AssetInsertRow>;
}

const INSERT_CASES: InsertCase[] = [
  {
    name: 'normal — cash',
    draft: { name: '지갑 현금', type: 'cash', balance: 150_000 },
    expect: { id: AID, household_id: HID, name: '지갑 현금', type: 'cash', balance: 150_000 },
  },
  {
    name: 'normal — bank, zero balance',
    draft: { name: '월급통장', type: 'bank', balance: 0 },
    expect: { name: '월급통장', type: 'bank', balance: 0 },
  },
  {
    name: 'id / household_id are injected from context, not the draft',
    draft: { name: 'X', type: 'other', balance: 1 },
    expect: { id: AID, household_id: HID },
  },
  {
    name: 'name is trimmed',
    draft: { name: '  삼성전자 주식  ', type: 'investment', balance: 2_000_000 },
    expect: { name: '삼성전자 주식' },
  },
];

interface UpdateCase {
  name: string;
  draft: NewAssetDraft;
  expect: Partial<AssetUpdateRow>;
}

const UPDATE_CASES: UpdateCase[] = [
  {
    name: 'normal update',
    draft: { name: '새 이름', type: 'savings', balance: 500_000 },
    expect: { name: '새 이름', type: 'savings', balance: 500_000 },
  },
];

/** name / balance / type — each in isolation should reject the draft. */
interface ValidityCase {
  name: string;
  draft: NewAssetDraft;
  wantValid: boolean;
}

const VALIDITY_CASES: ValidityCase[] = [
  { name: '정상 draft', draft: { name: '현금', type: 'cash', balance: 10_000 }, wantValid: true },
  { name: 'balance 0 허용', draft: { name: '현금', type: 'cash', balance: 0 }, wantValid: true },
  { name: 'balance 음수 -> 차단', draft: { name: '현금', type: 'cash', balance: -1 }, wantValid: false },
  { name: 'balance NaN -> 차단', draft: { name: '현금', type: 'cash', balance: NaN }, wantValid: false },
  {
    name: 'balance Infinity -> 차단',
    draft: { name: '현금', type: 'cash', balance: Infinity },
    wantValid: false,
  },
  {
    name: 'balance 소수 -> 차단 (원화는 정수)',
    draft: { name: '현금', type: 'cash', balance: 100.5 },
    wantValid: false,
  },
  {
    name: '이름 빈 문자열 -> 차단',
    draft: { name: '   ', type: 'cash', balance: 1 },
    wantValid: false,
  },
  {
    name: '잘못된 type -> 차단',
    draft: { name: '현금', type: 'crypto' as unknown as NewAssetDraft['type'], balance: 1 },
    wantValid: false,
  },
];

function fieldMatch(got: Record<string, unknown>, want: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(want)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(v)) {
      return `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`;
    }
  }
  return null;
}

export function runAssetMapperCases(): {
  results: AssetMapperCaseResult[];
  passed: number;
  failed: number;
} {
  const results: AssetMapperCaseResult[] = [];

  for (const c of INSERT_CASES) {
    const row = buildAssetInsert(c.draft, { id: AID, householdId: HID });
    const keys = Object.keys(row);
    const forbidden = keys.filter((k) => FORBIDDEN_KEYS.includes(k));
    const unexpected = keys.filter((k) => !INSERT_ALLOWED_KEYS.includes(k as keyof AssetInsertRow));
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

  for (const c of UPDATE_CASES) {
    const row = buildAssetUpdate(c.draft);
    const keys = Object.keys(row);
    const forbidden = keys.filter((k) => UPDATE_FORBIDDEN_KEYS.includes(k));
    const unexpected = keys.filter((k) => !UPDATE_ALLOWED_KEYS.includes(k as keyof AssetUpdateRow));
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

  for (const c of VALIDITY_CASES) {
    const got = isValidAssetDraft(c.draft);
    results.push({
      name: `isValidAssetDraft · ${c.name}`,
      pass: got === c.wantValid,
      detail: `got ${got}, want ${c.wantValid}`,
    });
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
