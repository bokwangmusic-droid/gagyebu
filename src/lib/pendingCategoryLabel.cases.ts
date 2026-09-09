/**
 * Static verification for the CATEGORY-management offline-queue row label —
 * STEP 16-H2-C2-B2 §11/§12/§28. Plain data + runner; the helper is pure.
 * Mirrors src/lib/pendingCardLabel.cases.ts.
 */
import {
  isCategoryCrossDeviceConflict,
  isPendingCategoryRowReadOnly,
  pendingCategoryRowLabel,
} from '@/lib/pendingCategoryLabel';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runPendingCategoryLabelCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // 23 — pending CREATE
  {
    const s = pendingCategoryRowLabel({ op: 'create', failed: false });
    check('CASE 23 pending CREATE -> "전송 대기"', s === '전송 대기', s);
  }
  // 24 — pending UPDATE
  {
    const s = pendingCategoryRowLabel({ op: 'update', failed: false });
    check('CASE 24 pending UPDATE -> "수정 전송 대기"', s === '수정 전송 대기', s);
  }
  // pending DELETE (helper completeness — no offline category DELETE in B2)
  {
    const s = pendingCategoryRowLabel({ op: 'delete', failed: false });
    check('CASE 24b pending DELETE -> "삭제 전송 대기"', s === '삭제 전송 대기', s);
  }
  // 25 — failed CREATE, generic
  {
    const s = pendingCategoryRowLabel({ op: 'create', failed: true, reason: 'error' });
    check(
      'CASE 25 failed CREATE -> "전송 실패 · 아래로 당겨 다시 시도"',
      s === '전송 실패 · 아래로 당겨 다시 시도',
      s,
    );
  }
  // failed CREATE with no reason -> still generic
  {
    const s = pendingCategoryRowLabel({ op: 'create', failed: true });
    check('CASE 25b failed CREATE (no reason) -> generic copy', s === '전송 실패 · 아래로 당겨 다시 시도', s);
  }
  // 26 — failed UPDATE, conflict
  {
    const s = pendingCategoryRowLabel({ op: 'update', failed: true, reason: 'conflict' });
    check(
      'CASE 26 failed UPDATE (conflict) -> "수정 전송 실패 · 다른 기기 변경 확인 필요"',
      s === '수정 전송 실패 · 다른 기기 변경 확인 필요',
      s,
    );
  }
  // 27 — failed UPDATE, deleted
  {
    const s = pendingCategoryRowLabel({ op: 'update', failed: true, reason: 'deleted' });
    check(
      'CASE 27 failed UPDATE (deleted) -> "수정 전송 실패 · 다른 기기에서 삭제된 카테고리예요"',
      s === '수정 전송 실패 · 다른 기기에서 삭제된 카테고리예요',
      s,
    );
  }
  // 28 — failed UPDATE, gone
  {
    const s = pendingCategoryRowLabel({ op: 'update', failed: true, reason: 'gone' });
    check(
      'CASE 28 failed UPDATE (gone) -> "수정 전송 실패 · 카테고리를 찾을 수 없어요"',
      s === '수정 전송 실패 · 카테고리를 찾을 수 없어요',
      s,
    );
  }
  // 29 — failed UPDATE, generic / identity / missing -> plain retry copy
  {
    const L = (r?: 'identity' | 'conflict' | 'deleted' | 'gone' | 'error') =>
      pendingCategoryRowLabel({ op: 'update', failed: true, reason: r });
    check(
      'CASE 29 failed UPDATE reason table: deleted/gone/conflict specific, rest generic',
      L('deleted') === '수정 전송 실패 · 다른 기기에서 삭제된 카테고리예요' &&
        L('gone') === '수정 전송 실패 · 카테고리를 찾을 수 없어요' &&
        L('conflict') === '수정 전송 실패 · 다른 기기 변경 확인 필요' &&
        L('error') === '수정 전송 실패 · 아래로 당겨 다시 시도' &&
        L('identity') === '수정 전송 실패 · 아래로 당겨 다시 시도' &&
        L(undefined) === '수정 전송 실패 · 아래로 당겨 다시 시도',
      'table',
    );
  }
  // failed DELETE labels (helper completeness)
  {
    const c = pendingCategoryRowLabel({ op: 'delete', failed: true, reason: 'conflict' });
    const g = pendingCategoryRowLabel({ op: 'delete', failed: true, reason: 'error' });
    check(
      'CASE 29b failed DELETE labels (completeness)',
      c === '삭제 전송 실패 · 다른 기기 변경 확인 필요' && g === '삭제 전송 실패 · 아래로 당겨 다시 시도',
      `${c} | ${g}`,
    );
  }
  // isCategoryCrossDeviceConflict truth table
  {
    const t =
      isCategoryCrossDeviceConflict('conflict') === true &&
      isCategoryCrossDeviceConflict('deleted') === true &&
      isCategoryCrossDeviceConflict('gone') === true &&
      isCategoryCrossDeviceConflict('identity') === false &&
      isCategoryCrossDeviceConflict('error') === false &&
      isCategoryCrossDeviceConflict(undefined) === false;
    check('CASE 29c isCategoryCrossDeviceConflict classifies conflict/deleted/gone only', t, 'table');
  }
  // §12 / §28.20 — every pending/failed row state is read-only
  {
    const states = [
      { op: 'create' as const, failed: false },
      { op: 'update' as const, failed: false },
      { op: 'create' as const, failed: true, reason: 'error' as const },
      { op: 'update' as const, failed: true, reason: 'conflict' as const },
    ];
    check(
      'CASE 20 every pending/failed category row is read-only',
      states.every((s) => isPendingCategoryRowReadOnly(s) === true),
      'table',
    );
  }
  // §11/§28.30 — the label helper NEVER returns an empty string / raw server text
  {
    const ops = ['create', 'update', 'delete'] as const;
    const reasons = [undefined, 'identity', 'conflict', 'deleted', 'gone', 'error'] as const;
    let allNonEmpty = true;
    for (const op of ops) {
      for (const failed of [false, true]) {
        for (const reason of reasons) {
          const s = pendingCategoryRowLabel({ op, failed, reason });
          if (typeof s !== 'string' || s.length === 0) allNonEmpty = false;
        }
      }
    }
    check('CASE 30 label helper total (never empty / never raw server text)', allNonEmpty, 'exhaustive');
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
