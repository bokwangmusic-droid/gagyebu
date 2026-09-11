/**
 * Static verification for the Planned-tab offline-queue row label —
 * STEP 16-H2-E2 §16. `pendingPlannedRowLabel` returns `{ primary, detail }`
 * (two short lines, never one truncation-prone string). Mirrors
 * src/lib/pendingBudgetLabel.cases.ts.
 */
import {
  isPlannedCrossDeviceConflict,
  isPendingPlannedRowReadOnly,
  pendingPlannedRowLabel,
} from '@/lib/pendingPlannedLabel';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runPendingPlannedLabelCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  // 1/2/3 — pending: primary only, no detail
  {
    const c = pendingPlannedRowLabel({ op: 'create', failed: false });
    const u = pendingPlannedRowLabel({ op: 'update', failed: false });
    const d = pendingPlannedRowLabel({ op: 'delete', failed: false });
    check(
      '1/2/3 pending CREATE/UPDATE/DELETE -> "전송 대기" / "수정 전송 대기" / "삭제 전송 대기", detail null',
      c.primary === '전송 대기' && c.detail === null &&
        u.primary === '수정 전송 대기' && u.detail === null &&
        d.primary === '삭제 전송 대기' && d.detail === null,
      JSON.stringify({ c, u, d }),
    );
  }

  // 4 — failed CREATE generic
  {
    const e = pendingPlannedRowLabel({ op: 'create', failed: true, reason: 'error' });
    const n = pendingPlannedRowLabel({ op: 'create', failed: true });
    check(
      '4 failed CREATE (error / no reason) -> "전송 실패" + "아래로 당겨 다시 시도"',
      e.primary === '전송 실패' && e.detail === '아래로 당겨 다시 시도' &&
        n.primary === '전송 실패' && n.detail === '아래로 당겨 다시 시도',
      JSON.stringify({ e, n }),
    );
  }

  // 5 — failed CREATE conflict (§9: same id, different server payload)
  {
    const l = pendingPlannedRowLabel({ op: 'create', failed: true, reason: 'conflict' });
    check(
      '5 failed CREATE (conflict) -> "전송 실패" + "다른 기기에서 변경됐어요"',
      l.primary === '전송 실패' && l.detail === '다른 기기에서 변경됐어요',
      JSON.stringify(l),
    );
  }

  // 6 — failed UPDATE reason table (§8/§16)
  {
    const L = (r?: 'identity' | 'conflict' | 'deleted' | 'gone' | 'error') =>
      pendingPlannedRowLabel({ op: 'update', failed: true, reason: r });
    const deleted = L('deleted');
    const gone = L('gone');
    const conflict = L('conflict');
    const generic = L('error');
    const noReason = L(undefined);
    check(
      '6 failed UPDATE: conflict -> "변경됐어요", deleted/gone -> "삭제됐어요", rest -> pull-to-refresh',
      conflict.primary === '수정 전송 실패' && conflict.detail === '다른 기기에서 변경됐어요' &&
        deleted.detail === '다른 기기에서 삭제됐어요' &&
        gone.detail === '다른 기기에서 삭제됐어요' &&
        generic.detail === '아래로 당겨 다시 시도' &&
        noReason.detail === '아래로 당겨 다시 시도',
      JSON.stringify({ deleted, gone, conflict, generic, noReason }),
    );
  }

  // 6b — the §8 scenario: A(120,000) offline vs B(150,000) online. The label
  // NEVER carries an amount — the caller shows "시도한 금액" from
  // attemptedDraft separately — and both lines are short.
  {
    const l = pendingPlannedRowLabel({ op: 'update', failed: true, reason: 'conflict' });
    check(
      '6b failed UPDATE conflict label is amount-free and short on both lines',
      !/\d/.test(l.primary) && l.detail !== null && !/\d/.test(l.detail) &&
        l.primary.length <= 8 && l.detail.length <= 14,
      JSON.stringify(l),
    );
  }

  // 7 — failed DELETE (§11)
  {
    const c = pendingPlannedRowLabel({ op: 'delete', failed: true, reason: 'conflict' });
    const g = pendingPlannedRowLabel({ op: 'delete', failed: true, reason: 'error' });
    check(
      '7 failed DELETE -> "삭제 전송 실패" + (conflict) "다른 기기에서 변경됐어요" / (else) pull-to-refresh',
      c.primary === '삭제 전송 실패' && c.detail === '다른 기기에서 변경됐어요' &&
        g.primary === '삭제 전송 실패' && g.detail === '아래로 당겨 다시 시도',
      JSON.stringify({ c, g }),
    );
  }

  // 8 — isPlannedCrossDeviceConflict truth table
  {
    const t =
      isPlannedCrossDeviceConflict('conflict') === true &&
      isPlannedCrossDeviceConflict('deleted') === true &&
      isPlannedCrossDeviceConflict('gone') === true &&
      isPlannedCrossDeviceConflict('identity') === false &&
      isPlannedCrossDeviceConflict('error') === false &&
      isPlannedCrossDeviceConflict(undefined) === false;
    check('8 isPlannedCrossDeviceConflict classifies conflict/deleted/gone only', t, 'table');
  }

  // 9 — every pending/failed row state is read-only (§13)
  {
    const states = [
      { op: 'create' as const, failed: false },
      { op: 'update' as const, failed: false },
      { op: 'delete' as const, failed: false },
      { op: 'create' as const, failed: true, reason: 'conflict' as const },
      { op: 'update' as const, failed: true, reason: 'conflict' as const },
      { op: 'delete' as const, failed: true, reason: 'conflict' as const },
    ];
    check(
      '9 every pending/failed planned row is read-only',
      states.every((s) => isPendingPlannedRowReadOnly(s) === true),
      'table',
    );
  }

  // 10 — exhaustive: primary always non-empty; detail present iff failed; no digits leak in
  {
    const ops = ['create', 'update', 'delete'] as const;
    const reasons = [undefined, 'identity', 'conflict', 'deleted', 'gone', 'error'] as const;
    let ok = true;
    for (const op of ops) {
      for (const failed of [false, true]) {
        for (const reason of reasons) {
          const l = pendingPlannedRowLabel({ op, failed, reason });
          if (typeof l.primary !== 'string' || l.primary.length === 0) ok = false;
          if (failed && (l.detail === null || l.detail.length === 0)) ok = false;
          if (!failed && l.detail !== null) ok = false;
          if (/\d/.test(l.primary) || (l.detail && /\d/.test(l.detail))) ok = false;
        }
      }
    }
    check('10 exhaustive: primary non-empty; detail iff failed; never carries a number', ok, 'exhaustive');
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
