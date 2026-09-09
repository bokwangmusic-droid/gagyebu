/**
 * Static verification for the CARD-management offline-queue row label —
 * STEP 16-H2-C2-A2 §10/§11/§19/§20/§25. Plain data + runner; the helper is
 * pure. Mirrors src/lib/pendingTransactionLabel.cases.ts.
 */
import {
  isCardCrossDeviceConflict,
  isPendingCardRowReadOnly,
  pendingCardRowLabel,
} from '@/lib/pendingCardLabel';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runPendingCardLabelCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // 22 — pending CREATE (§10)
  {
    const s = pendingCardRowLabel({ op: 'create', failed: false });
    check('CASE 22 pending CREATE -> "전송 대기"', s === '전송 대기', s);
  }
  // 23 — pending UPDATE (§10)
  {
    const s = pendingCardRowLabel({ op: 'update', failed: false });
    check('CASE 23 pending UPDATE -> "수정 전송 대기"', s === '수정 전송 대기', s);
  }
  // pending DELETE (normally hidden by composeCardManagement, still labelled)
  {
    const s = pendingCardRowLabel({ op: 'delete', failed: false });
    check('CASE 23b pending DELETE -> "삭제 전송 대기"', s === '삭제 전송 대기', s);
  }
  // 24 — failed CREATE, generic (§10)
  {
    const s = pendingCardRowLabel({ op: 'create', failed: true, reason: 'error' });
    check(
      'CASE 24 failed CREATE -> "전송 실패 · 아래로 당겨 다시 시도"',
      s === '전송 실패 · 아래로 당겨 다시 시도',
      s,
    );
  }
  // failed CREATE with no reason -> still generic (no crash)
  {
    const s = pendingCardRowLabel({ op: 'create', failed: true });
    check('CASE 24b failed CREATE (no reason) -> generic copy', s === '전송 실패 · 아래로 당겨 다시 시도', s);
  }
  // 25 — failed UPDATE, conflict -> cross-device copy (§10/§18)
  {
    const s = pendingCardRowLabel({ op: 'update', failed: true, reason: 'conflict' });
    check(
      'CASE 25 failed UPDATE (conflict) -> "수정 전송 실패 · 다른 기기 변경 확인 필요"',
      s === '수정 전송 실패 · 다른 기기 변경 확인 필요',
      s,
    );
  }
  // 26 — failed UPDATE, deleted -> reason-specific copy (§10)
  {
    const s = pendingCardRowLabel({ op: 'update', failed: true, reason: 'deleted' });
    check(
      'CASE 26 failed UPDATE (deleted) -> "수정 전송 실패 · 다른 기기에서 삭제된 카드예요"',
      s === '수정 전송 실패 · 다른 기기에서 삭제된 카드예요',
      s,
    );
  }
  // 27 — failed UPDATE, gone -> reason-specific copy (§10)
  {
    const s = pendingCardRowLabel({ op: 'update', failed: true, reason: 'gone' });
    check(
      'CASE 27 failed UPDATE (gone) -> "수정 전송 실패 · 카드를 찾을 수 없어요"',
      s === '수정 전송 실패 · 카드를 찾을 수 없어요',
      s,
    );
  }
  // failed UPDATE, generic / identity / missing -> plain retry copy
  {
    const L = (r?: 'identity' | 'conflict' | 'deleted' | 'gone' | 'error') =>
      pendingCardRowLabel({ op: 'update', failed: true, reason: r });
    check(
      'CASE 27b failed UPDATE reason table: deleted/gone/conflict specific, rest generic',
      L('deleted') === '수정 전송 실패 · 다른 기기에서 삭제된 카드예요' &&
        L('gone') === '수정 전송 실패 · 카드를 찾을 수 없어요' &&
        L('conflict') === '수정 전송 실패 · 다른 기기 변경 확인 필요' &&
        L('error') === '수정 전송 실패 · 아래로 당겨 다시 시도' &&
        L('identity') === '수정 전송 실패 · 아래로 당겨 다시 시도' &&
        L(undefined) === '수정 전송 실패 · 아래로 당겨 다시 시도',
      'table',
    );
  }
  // 28 — failed DELETE, conflict -> cross-device copy (§10)
  {
    const s = pendingCardRowLabel({ op: 'delete', failed: true, reason: 'conflict' });
    check(
      'CASE 28 failed DELETE (conflict) -> "삭제 전송 실패 · 다른 기기 변경 확인 필요"',
      s === '삭제 전송 실패 · 다른 기기 변경 확인 필요',
      s,
    );
  }
  // 29 — failed DELETE, generic -> pull-to-refresh copy (§10)
  {
    const s = pendingCardRowLabel({ op: 'delete', failed: true, reason: 'error' });
    check(
      'CASE 29 failed DELETE (error) -> "삭제 전송 실패 · 아래로 당겨 다시 시도"',
      s === '삭제 전송 실패 · 아래로 당겨 다시 시도',
      s,
    );
  }

  // isCardCrossDeviceConflict truth table
  {
    const t =
      isCardCrossDeviceConflict('conflict') === true &&
      isCardCrossDeviceConflict('deleted') === true &&
      isCardCrossDeviceConflict('gone') === true &&
      isCardCrossDeviceConflict('identity') === false &&
      isCardCrossDeviceConflict('error') === false &&
      isCardCrossDeviceConflict(undefined) === false;
    check('CASE 29b isCardCrossDeviceConflict classifies conflict/deleted/gone only', t, 'table');
  }

  // §11/§30–32 — every pending/failed row state is read-only
  {
    const states = [
      { op: 'create' as const, failed: false },
      { op: 'update' as const, failed: false },
      { op: 'create' as const, failed: true, reason: 'error' as const },
      { op: 'update' as const, failed: true, reason: 'conflict' as const },
      { op: 'delete' as const, failed: true, reason: 'conflict' as const },
    ];
    check(
      'CASE 30–32 every pending/failed card row is read-only',
      states.every((s) => isPendingCardRowReadOnly(s) === true),
      'table',
    );
  }

  // §10 — the label helper NEVER returns an empty string for any input combo
  {
    const ops = ['create', 'update', 'delete'] as const;
    const reasons = [undefined, 'identity', 'conflict', 'deleted', 'gone', 'error'] as const;
    let allNonEmpty = true;
    for (const op of ops) {
      for (const failed of [false, true]) {
        for (const reason of reasons) {
          const s = pendingCardRowLabel({ op, failed, reason });
          if (typeof s !== 'string' || s.length === 0) allNonEmpty = false;
        }
      }
    }
    check('CASE 32b label helper total (never empty / never raw server text)', allNonEmpty, 'exhaustive');
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
