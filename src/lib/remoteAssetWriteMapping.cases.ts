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
import { describeAssetDetail, normalizeAssetDetail, normalizeAssetType } from '@/lib/asset';
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
  'subtype',
  'institution',
  'balance',
];

/** Server-managed columns that must NEVER appear in an asset payload. */
const FORBIDDEN_KEYS = ['created_by', 'created_at', 'updated_at', 'deleted_at'];

/** Every column allowed in an asset PATCH body (no id / household_id here). */
const UPDATE_ALLOWED_KEYS: (keyof AssetUpdateRow)[] = ['name', 'type', 'subtype', 'institution', 'balance'];

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
  /* ---- 자산 관리 BATCH 2 · 상세정보 (subtype / institution) ---- */
  {
    name: 'bank + institution',
    draft: { name: '생활비통장', type: 'bank', institution: 'kb', balance: 2_000_000 },
    expect: { type: 'bank', subtype: null, institution: 'kb' },
  },
  {
    name: 'savings + institution + subtype',
    draft: { name: '아이 적금', type: 'savings', institution: 'shinhan', subtype: 'installment', balance: 5_000_000 },
    expect: { type: 'savings', subtype: 'installment', institution: 'shinhan' },
  },
  {
    name: 'investment + subtype, free-text institution is trimmed',
    draft: { name: '투자계좌', type: 'investment', subtype: 'domestic_stock', institution: '  키움증권 ', balance: 8_000_000 },
    expect: { type: 'investment', subtype: 'domestic_stock', institution: '키움증권' },
  },
  {
    name: 'investment + subtype, no institution (optional)',
    draft: { name: '코인', type: 'investment', subtype: 'crypto', balance: 1 },
    expect: { subtype: 'crypto', institution: null },
  },
  {
    name: 'real_estate + subtype, no institution',
    draft: { name: '우리집', type: 'real_estate', subtype: 'apartment', balance: 300_000_000 },
    expect: { type: 'real_estate', subtype: 'apartment', institution: null },
  },
  {
    name: 'cash without extra fields -> explicit nulls',
    draft: { name: '지갑', type: 'cash', balance: 50_000 },
    expect: { subtype: null, institution: null },
  },
  {
    name: 'other without extra fields -> explicit nulls',
    draft: { name: '자동차', type: 'other', balance: 10_000_000 },
    expect: { subtype: null, institution: null },
  },
  {
    name: 'legacy-shaped draft (bank, no detail) still builds',
    draft: { name: '월급통장', type: 'bank', subtype: null, institution: null, balance: 1 },
    expect: { type: 'bank', subtype: null, institution: null },
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
  {
    name: 'type change — real_estate',
    draft: { name: '우리집 아파트', type: 'real_estate', balance: 300_000_000 },
    expect: { name: '우리집 아파트', type: 'real_estate', balance: 300_000_000 },
  },
  {
    name: 'detail update — savings',
    draft: { name: '청약통장', type: 'savings', institution: 'woori', subtype: 'subscription', balance: 3_000_000 },
    expect: { subtype: 'subscription', institution: 'woori' },
  },
  {
    // The form sends only what applies; the PATCH must still CLEAR the old
    // columns (explicit null), or a savings -> cash edit would keep them.
    name: 'type change to cash clears detail with explicit nulls',
    draft: { name: '비상금', type: 'cash', balance: 100_000 },
    expect: { type: 'cash', subtype: null, institution: null },
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
  // 20261004001900: balance sync can take an account below 0, so a negative
  // balance must round-trip through the edit form (was "음수 -> 차단").
  { name: 'balance 음수 허용 (잔액 자동 반영 이후)', draft: { name: '통장', type: 'bank', balance: -10_000 }, wantValid: true },
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
  ...(['bank', 'savings', 'investment', 'cash', 'real_estate', 'other'] as const).map(
    (type): ValidityCase => ({
      name: `type '${type}' 허용`,
      draft: { name: '자산', type, balance: 1_000 },
      wantValid: true,
    }),
  ),
  /* ---- 상세정보 validity ---- */
  { name: 'bank + 기관 code 허용', draft: { name: 'a', type: 'bank', institution: 'kakaobank', balance: 1 }, wantValid: true },
  { name: 'bank, 상세 없음(legacy) 허용', draft: { name: 'a', type: 'bank', subtype: null, institution: null, balance: 1 }, wantValid: true },
  { name: 'bank + 목록에 없는 기관 -> 차단', draft: { name: 'a', type: 'bank', institution: '키움증권', balance: 1 }, wantValid: false },
  { name: 'bank + subtype -> 차단 (은행계좌는 상세 종류 없음)', draft: { name: 'a', type: 'bank', subtype: 'deposit', balance: 1 }, wantValid: false },
  { name: 'savings + 기관 + subtype 허용', draft: { name: 'a', type: 'savings', institution: 'nh', subtype: 'deposit', balance: 1 }, wantValid: true },
  { name: 'savings + 투자용 subtype -> 차단', draft: { name: 'a', type: 'savings', subtype: 'etf', balance: 1 }, wantValid: false },
  { name: 'investment + subtype + 직접 입력 기관 허용', draft: { name: 'a', type: 'investment', subtype: 'etf', institution: '미래에셋증권', balance: 1 }, wantValid: true },
  { name: 'investment + 21자 기관 -> 차단', draft: { name: 'a', type: 'investment', institution: 'x'.repeat(21), balance: 1 }, wantValid: false },
  { name: 'real_estate + subtype 허용', draft: { name: 'a', type: 'real_estate', subtype: 'land', balance: 1 }, wantValid: true },
  { name: 'real_estate + 기관 -> 차단', draft: { name: 'a', type: 'real_estate', subtype: 'land', institution: 'kb', balance: 1 }, wantValid: false },
  { name: 'cash + 상세 -> 차단', draft: { name: 'a', type: 'cash', subtype: 'deposit', balance: 1 }, wantValid: false },
  { name: 'other + 기관 -> 차단', draft: { name: 'a', type: 'other', institution: 'kb', balance: 1 }, wantValid: false },
  {
    name: '잘못된 type -> 차단',
    draft: { name: '현금', type: 'crypto' as unknown as NewAssetDraft['type'], balance: 1 },
    wantValid: false,
  },
];

/** draft -> INSERT/UPDATE row -> read normalize -> the label the list row shows. */
const ROUND_TRIP_CASES: { name: string; draft: NewAssetDraft; label: string }[] = [
  { name: 'bank + institution', draft: { name: '생활비통장', type: 'bank', institution: 'kb', balance: 2_350_000 }, label: 'KB국민은행 · 은행계좌' },
  {
    name: 'savings + institution + subtype',
    draft: { name: '아이 적금', type: 'savings', institution: 'shinhan', subtype: 'installment', balance: 5_000_000 },
    label: '신한은행 · 적금',
  },
  {
    name: 'investment + subtype + institution',
    draft: { name: '투자계좌', type: 'investment', subtype: 'domestic_stock', institution: '키움증권', balance: 8_400_000 },
    label: '키움증권 · 국내주식',
  },
  { name: 'investment + subtype only', draft: { name: '연금', type: 'investment', subtype: 'pension_isa', balance: 1 }, label: '연금·ISA' },
  { name: 'real_estate + subtype', draft: { name: '우리집', type: 'real_estate', subtype: 'apartment', balance: 1 }, label: '아파트' },
  { name: 'cash without extra fields', draft: { name: '지갑', type: 'cash', balance: 1 }, label: '현금' },
  { name: 'other without extra fields', draft: { name: '자동차', type: 'other', balance: 1 }, label: '기타 자산' },
  { name: 'legacy asset with no subtype/institution', draft: { name: '월급통장', type: 'savings', balance: 1 }, label: '예·적금' },
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

  /* ---- round-trip: draft -> row -> (read) normalize -> list-row label ---- */
  for (const c of ROUND_TRIP_CASES) {
    const ins = buildAssetInsert(c.draft, { id: AID, householdId: HID });
    const upd = buildAssetUpdate(c.draft);
    // What mapRemoteFinance does with the stored row on the way back in.
    const read = normalizeAssetDetail(normalizeAssetType(ins.type), ins.subtype, ins.institution);
    const label = describeAssetDetail({ type: ins.type, ...read });
    const pass =
      isValidAssetDraft(c.draft) &&
      ins.subtype === upd.subtype &&
      ins.institution === upd.institution &&
      read.subtype === ins.subtype &&
      read.institution === ins.institution &&
      label === c.label;
    results.push({
      name: `round-trip · ${c.name}`,
      pass,
      detail: pass ? 'ok' : `label ${JSON.stringify(label)}, want ${JSON.stringify(c.label)} · ${JSON.stringify(read)}`,
    });
  }

  /* ---- read-side tolerance: legacy rows + detail left over from another type ---- */
  const READ_CASES: { name: string; got: string; want: string }[] = [
    { name: 'legacy bank (columns absent)', got: describeAssetDetail({ type: 'bank' }), want: '은행계좌' },
    { name: 'legacy savings (null/null)', got: describeAssetDetail({ type: 'savings', subtype: null, institution: null }), want: '예·적금' },
    { name: 'bank 기관 기타 -> type label만', got: describeAssetDetail({ type: 'bank', institution: 'other' }), want: '은행계좌' },
    { name: 'savings subtype 기타 -> type label', got: describeAssetDetail({ type: 'savings', institution: 'kb', subtype: 'other' }), want: 'KB국민은행 · 예·적금' },
    { name: 'cash에 남은 savings 상세 -> 무시', got: describeAssetDetail({ type: 'cash', subtype: 'installment', institution: 'shinhan' }), want: '현금' },
    { name: 'investment에 남은 savings subtype -> 무시', got: describeAssetDetail({ type: 'investment', subtype: 'installment' }), want: '투자' },
    { name: 'investment에 남은 은행 code -> 은행 이름으로', got: describeAssetDetail({ type: 'investment', institution: 'kb' }), want: 'KB국민은행 · 투자' },
    { name: 'bank에 남은 직접 입력 기관 -> 무시', got: describeAssetDetail({ type: 'bank', institution: '키움증권' }), want: '은행계좌' },
  ];
  for (const c of READ_CASES) {
    results.push({ name: `read · ${c.name}`, pass: c.got === c.want, detail: `got ${c.got}, want ${c.want}` });
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
