/**
 * Asset display helpers — pure, no store/UI imports (전체자산/순자산 STEP 5).
 *
 * Same shape as `describeRepayType()` in src/lib/loan.ts: a small pure
 * label lookup next to the domain type it describes, not a general-purpose
 * component.
 */
import type { AssetType } from '@/store/types';

export const ASSET_TYPE_OPTIONS: { value: AssetType; label: string }[] = [
  { value: 'cash', label: '현금' },
  { value: 'bank', label: '은행계좌' },
  { value: 'savings', label: '예적금' },
  { value: 'investment', label: '투자' },
  { value: 'other', label: '기타' },
];

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  cash: '현금',
  bank: '은행계좌',
  savings: '예적금',
  investment: '투자',
  other: '기타',
};

export function describeAssetType(type: AssetType): string {
  return ASSET_TYPE_LABELS[type] ?? '기타';
}

/** AppIcon semantic name per asset type — see src/components/AppIcon.tsx's MAP. */
const ASSET_TYPE_ICONS: Record<AssetType, string> = {
  cash: 'won',
  bank: 'landmark',
  savings: 'shield',
  investment: 'briefcase',
  other: 'sparkle',
};

export function assetTypeIcon(type: AssetType): string {
  return ASSET_TYPE_ICONS[type] ?? 'sparkle';
}
