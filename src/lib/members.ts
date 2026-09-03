/**
 * Shared-ledger (부부/가족) members — STEP 10 SKELETON.
 *
 * The app is single-user. No UI creates, edits or selects members, and no
 * aggregation (통계 / 거래 목록 / 예산 / 카드 / 할부 / 자연어 입력 / 분할지출)
 * filters by `Transaction.memberId` — every existing calculation still runs
 * over *all* transactions.
 *
 * This module only supplies a stable "who is in this ledger" list: whatever is
 * in `settings.members`, or a single default member when that field is absent
 * (every existing install and backup).
 */

import type { Member, Settings } from '@/store/types';

export type { Member } from '@/store/types';

/** The implicit user every pre-existing ledger already belongs to. */
export const DEFAULT_MEMBER: Member = { id: 'default', name: '나' };

/** Configured members, or `[DEFAULT_MEMBER]` when none are set. */
export function resolveMembers(settings: Pick<Settings, 'members'>): Member[] {
  const list = settings.members;
  return Array.isArray(list) && list.length > 0 ? list : [DEFAULT_MEMBER];
}

/** The member a new transaction belongs to. Always the default in STEP 10. */
export function currentMemberId(_settings: Pick<Settings, 'members'>): string {
  return DEFAULT_MEMBER.id;
}
