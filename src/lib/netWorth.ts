/**
 * Net-worth maths — pure, no store/UI/Supabase imports (전체자산/순자산 STEP 2).
 *
 * `balance`(Asset)는 1차 스코프에서 전부 수동입력이라 여기서 검증/보정할
 * 것이 없다 — 단순 합계. 총부채는 `src/lib/loan.ts`의 `viewLoan(...).remaining`
 * (= `Math.max(0, principal - paid)`)을 그대로 재사용한다: 그 클램프 덕분에
 * 완납 대출은 항상 0으로 들어오고, `remaining`이 음수가 될 가능성 자체가
 * 없다 — 이 파일에서 별도의 음수 보정 로직을 두지 않는다.
 *
 * soft-delete 필터링은 이 레이어의 책임이 아니다: `Asset`/`Loan` 도메인
 * 타입 둘 다 `deletedAt` 필드를 아예 갖지 않는다(Card/Goal과 동일한 기존
 * 컨벤션 — 삭제된 행은 remote 매핑 레이어에서 `deleted_at is null` 조건으로
 * 걸러진 뒤에야 도메인 배열에 실린다, src/lib/remoteFinanceMapping.ts 참고).
 * 즉 이 함수들에 들어오는 배열은 이미 "활성" 행만 담고 있다는 것이 타입
 * 수준에서 보장되므로, 여기서 다시 deletedAt을 걸러낼 필요도, 걸러낼 방법도
 * 없다.
 */
import { ASSET_TYPE_OPTIONS, normalizeAssetType } from '@/lib/asset';
import { viewLoan } from '@/lib/loan';
import type { Asset, AssetType, Loan } from '@/store/types';

/** 활성 Asset 잔액의 합. */
export function calculateTotalAssets(assets: readonly Asset[]): number {
  return assets.reduce((sum, a) => sum + a.balance, 0);
}

export interface AssetTypeTotal {
  type: AssetType;
  total: number;
  count: number;
}

/**
 * 자산 종류별 합계 — `ASSET_TYPE_OPTIONS` 표시 순서, 합계가 0인 종류는 제외.
 * (거래 자동 반영으로 계좌 잔액이 음수가 될 수 있으므로 음수 합계도 표시한다.)
 * 알 수 없는 종류는 `normalizeAssetType`으로 기타 자산에 합산하므로, 반환된
 * `total`의 합은 항상 `calculateTotalAssets(assets)`와 같다.
 */
export function summarizeAssetsByType(assets: readonly Asset[]): AssetTypeTotal[] {
  const byType = new Map<AssetType, AssetTypeTotal>();
  for (const a of assets) {
    const type = normalizeAssetType(a.type);
    const cur = byType.get(type) ?? { type, total: 0, count: 0 };
    cur.total += a.balance;
    cur.count += 1;
    byType.set(type, cur);
  }
  return ASSET_TYPE_OPTIONS.flatMap((o) => {
    const t = byType.get(o.value);
    return t && t.total !== 0 ? [t] : [];
  });
}

/** 활성 Loan의 남은 원금(`viewLoan(...).remaining`) 합. 완납 대출은 0으로 반영. */
export function calculateTotalDebt(loans: readonly Loan[]): number {
  return loans.reduce((sum, l) => sum + viewLoan(l).remaining, 0);
}

export function calculateNetWorth(assets: readonly Asset[], loans: readonly Loan[]): number {
  return calculateTotalAssets(assets) - calculateTotalDebt(loans);
}

export interface NetWorthSummary {
  totalAssets: number;
  totalDebt: number;
  netWorth: number;
}

/** 홈 카드 등 한 번에 세 값이 다 필요한 소비처를 위한 묶음 계산. */
export function summarizeNetWorth(
  assets: readonly Asset[],
  loans: readonly Loan[],
): NetWorthSummary {
  const totalAssets = calculateTotalAssets(assets);
  const totalDebt = calculateTotalDebt(loans);
  return { totalAssets, totalDebt, netWorth: totalAssets - totalDebt };
}
