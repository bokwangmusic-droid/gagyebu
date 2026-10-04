/**
 * Asset display helpers — pure, no store/UI imports (전체자산/순자산 STEP 5).
 *
 * Same shape as `describeRepayType()` in src/lib/loan.ts: a small pure
 * label lookup next to the domain type it describes, not a general-purpose
 * component.
 */
import type { AssetType } from '@/store/types';

/** Display order everywhere a type list is shown (form chips, 종류별 합계). */
export const ASSET_TYPE_OPTIONS: { value: AssetType; label: string }[] = [
  { value: 'bank', label: '은행계좌' },
  { value: 'savings', label: '예·적금' },
  { value: 'investment', label: '투자' },
  { value: 'cash', label: '현금' },
  { value: 'real_estate', label: '부동산' },
  { value: 'other', label: '기타 자산' },
];

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  bank: '은행계좌',
  savings: '예·적금',
  investment: '투자',
  cash: '현금',
  real_estate: '부동산',
  other: '기타 자산',
};

export function describeAssetType(type: AssetType): string {
  return ASSET_TYPE_LABELS[type] ?? ASSET_TYPE_LABELS.other;
}

/**
 * Stored value -> a known `AssetType`. A missing / unknown value (a row
 * written by a newer app version, or anything the CHECK ever lets through)
 * is shown as 기타 자산 instead of breaking the list; saving the edit form
 * then writes a real type.
 */
export function normalizeAssetType(raw: unknown): AssetType {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(ASSET_TYPE_LABELS, raw)
    ? (raw as AssetType)
    : 'other';
}

/** AppIcon semantic name per asset type — see src/components/AppIcon.tsx's MAP. */
const ASSET_TYPE_ICONS: Record<AssetType, string> = {
  bank: 'landmark',
  savings: 'shield',
  investment: 'briefcase',
  cash: 'won',
  real_estate: 'home',
  other: 'sparkle',
};

export function assetTypeIcon(type: AssetType): string {
  return ASSET_TYPE_ICONS[type] ?? 'sparkle';
}

/* ------------------------------------------------------------------ *
 * 상세정보 (자산 관리 BATCH 2) — `assets.subtype` / `assets.institution`.
 *
 * The top-level `AssetType` stays the 6 values above; these two optional
 * columns only refine it. Both are stored as plain nullable text:
 *   - subtype     : a code from `assetSubtypeOptions(type)`
 *   - institution : bank / savings -> a code from BANK_INSTITUTION_OPTIONS
 *                   investment     -> free text (증권사·거래소 직접 입력)
 * A legacy row (both null) and a row whose detail no longer fits its type
 * (an older app version changed `type` without knowing these columns) are
 * both valid input everywhere below — the detail is simply dropped.
 * ------------------------------------------------------------------ */

type DetailOption = { value: string; label: string };

/** 은행계좌 / 예·적금에서 고르는 기본 금융기관. */
export const BANK_INSTITUTION_OPTIONS: DetailOption[] = [
  { value: 'kb', label: 'KB국민은행' },
  { value: 'shinhan', label: '신한은행' },
  { value: 'hana', label: '하나은행' },
  { value: 'woori', label: '우리은행' },
  { value: 'nh', label: 'NH농협은행' },
  { value: 'ibk', label: 'IBK기업은행' },
  { value: 'kakaobank', label: '카카오뱅크' },
  { value: 'tossbank', label: '토스뱅크' },
  { value: 'kbank', label: '케이뱅크' },
  { value: 'epost', label: '우체국' },
  { value: 'mg', label: '새마을금고' },
  { value: 'cu', label: '신협' },
  { value: 'savings_bank', label: '저축은행' },
  { value: 'other', label: '기타' },
];

const ASSET_SUBTYPE_OPTIONS: Partial<Record<AssetType, DetailOption[]>> = {
  savings: [
    { value: 'deposit', label: '예금' },
    { value: 'installment', label: '적금' },
    { value: 'subscription', label: '청약' },
    { value: 'other', label: '기타' },
  ],
  investment: [
    { value: 'domestic_stock', label: '국내주식' },
    { value: 'overseas_stock', label: '해외주식' },
    { value: 'etf', label: 'ETF' },
    { value: 'fund', label: '펀드' },
    { value: 'bond', label: '채권' },
    { value: 'crypto', label: '가상자산' },
    { value: 'pension_isa', label: '연금·ISA' },
    { value: 'other', label: '기타' },
  ],
  real_estate: [
    { value: 'apartment', label: '아파트' },
    { value: 'officetel', label: '오피스텔' },
    { value: 'commercial', label: '상가' },
    { value: 'land', label: '토지' },
    { value: 'other', label: '기타' },
  ],
};

/** 상세 종류 선택지 — 상세 종류가 없는 type(은행계좌/현금/기타 자산)은 빈 배열. */
export function assetSubtypeOptions(type: AssetType): DetailOption[] {
  return ASSET_SUBTYPE_OPTIONS[type] ?? [];
}

/**
 * How `institution` is entered for a type: 'select' = pick from
 * BANK_INSTITUTION_OPTIONS, 'text' = optional free text, 'none' = not used.
 */
export type AssetInstitutionMode = 'select' | 'text' | 'none';

export function assetInstitutionMode(type: AssetType): AssetInstitutionMode {
  if (type === 'bank' || type === 'savings') return 'select';
  if (type === 'investment') return 'text';
  return 'none';
}

/** Free-text institution (투자) length cap — well inside the DB length CHECK. */
export const ASSET_INSTITUTION_MAX = 20;

export interface AssetDetail {
  subtype: string | null;
  institution: string | null;
}

/**
 * Stored / drafted detail -> only what is meaningful for `type`; anything
 * else (missing, unknown code, a value left over from another type, too
 * long) becomes null. Used on READ (never show a stale detail) and on
 * WRITE (a type change clears what no longer applies).
 */
export function normalizeAssetDetail(type: AssetType, subtype: unknown, institution: unknown): AssetDetail {
  const sub =
    typeof subtype === 'string' && assetSubtypeOptions(type).some((o) => o.value === subtype)
      ? subtype
      : null;

  const mode = assetInstitutionMode(type);
  const raw = typeof institution === 'string' ? institution.trim() : '';
  let inst: string | null = null;
  if (mode === 'select') {
    inst = BANK_INSTITUTION_OPTIONS.some((o) => o.value === raw) ? raw : null;
  } else if (mode === 'text') {
    inst = raw.length > 0 && raw.length <= ASSET_INSTITUTION_MAX ? raw : null;
  }
  return { subtype: sub, institution: inst };
}

/** A bank code -> its label; free text (투자) is shown as typed. */
export function describeAssetInstitution(institution: string): string {
  return BANK_INSTITUTION_OPTIONS.find((o) => o.value === institution)?.label ?? institution;
}

/**
 * An account's name for a payment picker / transaction row:
 * "KB국민은행 · 생활비통장", or just the asset name when no (or the 기타)
 * institution is set.
 */
export function describeAccount(asset: {
  type: AssetType;
  name: string;
  institution?: string | null;
}): string {
  const { institution } = normalizeAssetDetail(asset.type, null, asset.institution);
  const showInstitution =
    institution && !(assetInstitutionMode(asset.type) === 'select' && institution === 'other');
  return showInstitution ? `${describeAssetInstitution(institution)} · ${asset.name}` : asset.name;
}

/**
 * One-line detail for a list row: "KB국민은행 · 은행계좌", "신한은행 · 적금",
 * "키움증권 · 국내주식", "아파트". A missing detail — or the catch-all
 * 기타 choice — falls back to the plain type label, so a legacy asset reads
 * exactly as before ("은행계좌").
 */
export function describeAssetDetail(asset: {
  type: AssetType;
  subtype?: string | null;
  institution?: string | null;
}): string {
  const { subtype, institution } = normalizeAssetDetail(asset.type, asset.subtype, asset.institution);
  const subLabel =
    subtype && subtype !== 'other'
      ? assetSubtypeOptions(asset.type).find((o) => o.value === subtype)?.label
      : undefined;
  const instLabel =
    institution && !(assetInstitutionMode(asset.type) === 'select' && institution === 'other')
      ? describeAssetInstitution(institution)
      : undefined;
  return [instLabel, subLabel ?? describeAssetType(asset.type)].filter(Boolean).join(' · ');
}
