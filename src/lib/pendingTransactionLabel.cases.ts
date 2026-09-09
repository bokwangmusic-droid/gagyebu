/**
 * Static verification for the offline-queue row label — STEP 16-H2-B2
 * §6/§11/§12/§20/§21. Plain data + runner; the helper is pure.
 */
import {
  isCrossDeviceConflict,
  pendingTransactionRowLabel,
} from '@/lib/pendingTransactionLabel';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runPendingLabelCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // 1 — pending CREATE
  {
    const s = pendingTransactionRowLabel({ op: 'create', failed: false });
    check('CASE 1 pending CREATE -> "전송 대기"', s === '전송 대기', s);
  }
  // 2 — pending UPDATE
  {
    const s = pendingTransactionRowLabel({ op: 'update', failed: false });
    check('CASE 2 pending UPDATE -> "수정 전송 대기"', s === '수정 전송 대기', s);
  }
  // 3 — pending DELETE (normally hidden, still labelled for completeness)
  {
    const s = pendingTransactionRowLabel({ op: 'delete', failed: false });
    check('CASE 3 pending DELETE -> "삭제 전송 대기"', s === '삭제 전송 대기', s);
  }
  // 4 — failed CREATE
  {
    const s = pendingTransactionRowLabel({ op: 'create', failed: true, reason: 'error' });
    check(
      'CASE 4 failed CREATE -> pull-to-refresh copy',
      s === '전송 실패 · 아래로 당겨 다시 시도',
      s,
    );
  }
  // 5 — failed UPDATE, generic (error) reason -> pull-to-refresh copy
  {
    const s = pendingTransactionRowLabel({ op: 'update', failed: true, reason: 'error' });
    check(
      'CASE 5 failed UPDATE (error) -> "수정 전송 실패 · 아래로 당겨 다시 시도"',
      s === '수정 전송 실패 · 아래로 당겨 다시 시도',
      s,
    );
  }
  // 6 — failed UPDATE, identity reason -> still generic copy
  {
    const s = pendingTransactionRowLabel({ op: 'update', failed: true, reason: 'identity' });
    check(
      'CASE 6 failed UPDATE (identity) -> generic retry copy',
      s === '수정 전송 실패 · 아래로 당겨 다시 시도',
      s,
    );
  }
  // 7 — failed UPDATE, conflict -> cross-device copy
  {
    const s = pendingTransactionRowLabel({ op: 'update', failed: true, reason: 'conflict' });
    check(
      'CASE 7 failed UPDATE (conflict) -> "수정 전송 실패 · 다른 기기 변경 확인 필요"',
      s === '수정 전송 실패 · 다른 기기 변경 확인 필요',
      s,
    );
  }
  // 8 — failed UPDATE, deleted -> reason-specific copy (STEP 16-H2-B2.1 §5)
  {
    const s = pendingTransactionRowLabel({ op: 'update', failed: true, reason: 'deleted' });
    check(
      'CASE 8 failed UPDATE (deleted) -> "수정 전송 실패 · 다른 기기에서 삭제된 거래예요"',
      s === '수정 전송 실패 · 다른 기기에서 삭제된 거래예요',
      s,
    );
  }
  // 8b — failed UPDATE, gone -> reason-specific copy
  {
    const s = pendingTransactionRowLabel({ op: 'update', failed: true, reason: 'gone' });
    check(
      'CASE 8b failed UPDATE (gone) -> "수정 전송 실패 · 거래를 찾을 수 없어요"',
      s === '수정 전송 실패 · 거래를 찾을 수 없어요',
      s,
    );
  }
  // 9 — failed UPDATE, reason missing -> generic copy (no crash)
  {
    const s = pendingTransactionRowLabel({ op: 'update', failed: true });
    check(
      'CASE 9 failed UPDATE (no reason) -> generic retry copy',
      s === '수정 전송 실패 · 아래로 당겨 다시 시도',
      s,
    );
  }
  // 10 — failed DELETE, generic -> pull-to-refresh copy (§11)
  {
    const s = pendingTransactionRowLabel({ op: 'delete', failed: true, reason: 'error' });
    check(
      'CASE 10 failed DELETE (error) -> "삭제 전송 실패 · 아래로 당겨 다시 시도"',
      s === '삭제 전송 실패 · 아래로 당겨 다시 시도',
      s,
    );
  }
  // 11 — failed DELETE, conflict -> cross-device copy (§21)
  {
    const s = pendingTransactionRowLabel({ op: 'delete', failed: true, reason: 'conflict' });
    check(
      'CASE 11 failed DELETE (conflict) -> "삭제 전송 실패 · 다른 기기 변경 확인 필요"',
      s === '삭제 전송 실패 · 다른 기기 변경 확인 필요',
      s,
    );
  }
  // 11b — full failed-UPDATE reason table in one place (STEP 16-H2-B2.1 §5)
  {
    const L = (r?: 'identity' | 'conflict' | 'deleted' | 'gone' | 'error') =>
      pendingTransactionRowLabel({ op: 'update', failed: true, reason: r });
    check(
      'CASE 11b failed UPDATE reason table: deleted/gone/conflict specific, rest generic',
      L('deleted') === '수정 전송 실패 · 다른 기기에서 삭제된 거래예요' &&
        L('gone') === '수정 전송 실패 · 거래를 찾을 수 없어요' &&
        L('conflict') === '수정 전송 실패 · 다른 기기 변경 확인 필요' &&
        L('error') === '수정 전송 실패 · 아래로 당겨 다시 시도' &&
        L('identity') === '수정 전송 실패 · 아래로 당겨 다시 시도' &&
        L(undefined) === '수정 전송 실패 · 아래로 당겨 다시 시도',
      'table',
    );
  }

  // 12 — isCrossDeviceConflict truth table
  {
    const t =
      isCrossDeviceConflict('conflict') === true &&
      isCrossDeviceConflict('deleted') === true &&
      isCrossDeviceConflict('gone') === true &&
      isCrossDeviceConflict('identity') === false &&
      isCrossDeviceConflict('error') === false &&
      isCrossDeviceConflict(undefined) === false;
    check('CASE 12 isCrossDeviceConflict classifies conflict/deleted/gone only', t, 'table');
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
