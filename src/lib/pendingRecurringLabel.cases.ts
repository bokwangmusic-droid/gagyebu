/**
 * Static verification for the Recurring-screen offline-queue row label —
 * STEP 16-H2-F2 §18/§23. `pendingRecurringRowLabel` returns
 * `{ primary, detail }` (two short lines) and is reused, row-less, for the
 * standalone orphan-ACTIVE failure notice. Mirrors
 * src/lib/pendingPlannedLabel.cases.ts.
 */
import {
  attemptedActiveLabel,
  isPendingRecurringRowReadOnly,
  isRecurringCrossDeviceConflict,
  pendingRecurringRowLabel,
} from '@/lib/pendingRecurringLabel';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runPendingRecurringLabelCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  // 1 — CREATE pending
  {
    const l = pendingRecurringRowLabel({ op: 'create', failed: false });
    check('1 CREATE pending -> "전송 대기", detail null', l.primary === '전송 대기' && l.detail === null, JSON.stringify(l));
  }

  // 2 — FULL UPDATE pending
  {
    const l = pendingRecurringRowLabel({ op: 'update', updateKind: 'full', failed: false });
    check('2 FULL UPDATE pending -> "수정 전송 대기", detail null', l.primary === '수정 전송 대기' && l.detail === null, JSON.stringify(l));
  }

  // 3 — ACTIVE pending
  {
    const l = pendingRecurringRowLabel({ op: 'update', updateKind: 'active', failed: false });
    check(
      '3 ACTIVE pending -> "상태 변경 전송 대기", detail null',
      l.primary === '상태 변경 전송 대기' && l.detail === null,
      JSON.stringify(l),
    );
  }

  // 4 — DELETE pending
  {
    const l = pendingRecurringRowLabel({ op: 'delete', failed: false });
    check('4 DELETE pending -> "삭제 전송 대기", detail null', l.primary === '삭제 전송 대기' && l.detail === null, JSON.stringify(l));
  }

  // 5 — FULL UPDATE conflict two-line copy
  {
    const conflict = pendingRecurringRowLabel({ op: 'update', updateKind: 'full', failed: true, reason: 'conflict' });
    const generic = pendingRecurringRowLabel({ op: 'update', updateKind: 'full', failed: true, reason: 'error' });
    check(
      '5 FULL UPDATE conflict -> "수정 전송 실패" + "다른 기기에서 변경됐어요"; generic -> pull-to-refresh',
      conflict.primary === '수정 전송 실패' && conflict.detail === '다른 기기에서 변경됐어요' &&
        generic.primary === '수정 전송 실패' && generic.detail === '아래로 당겨 다시 시도',
      JSON.stringify({ conflict, generic }),
    );
  }

  // 6 — ACTIVE conflict two-line copy
  {
    const conflict = pendingRecurringRowLabel({ op: 'update', updateKind: 'active', failed: true, reason: 'conflict' });
    check(
      '6 ACTIVE conflict -> "상태 변경 실패" + "다른 기기에서 변경됐어요"',
      conflict.primary === '상태 변경 실패' && conflict.detail === '다른 기기에서 변경됐어요',
      JSON.stringify(conflict),
    );
  }

  // 7 — server-deleted copy (both FULL and ACTIVE, orphan case reuses this exact state shape)
  {
    const fullDeleted = pendingRecurringRowLabel({ op: 'update', updateKind: 'full', failed: true, reason: 'deleted' });
    const fullGone = pendingRecurringRowLabel({ op: 'update', updateKind: 'full', failed: true, reason: 'gone' });
    const activeDeleted = pendingRecurringRowLabel({ op: 'update', updateKind: 'active', failed: true, reason: 'deleted' });
    const activeGone = pendingRecurringRowLabel({ op: 'update', updateKind: 'active', failed: true, reason: 'gone' });
    check(
      '7 server-deleted copy: FULL and ACTIVE both say "다른 기기에서 삭제됐어요" for deleted/gone',
      fullDeleted.detail === '다른 기기에서 삭제됐어요' &&
        fullGone.detail === '다른 기기에서 삭제됐어요' &&
        activeDeleted.detail === '다른 기기에서 삭제됐어요' &&
        activeGone.detail === '다른 기기에서 삭제됐어요' &&
        activeDeleted.primary === '상태 변경 실패',
      JSON.stringify({ fullDeleted, fullGone, activeDeleted, activeGone }),
    );
  }

  // 8 — failed DELETE copy
  {
    const c = pendingRecurringRowLabel({ op: 'delete', failed: true, reason: 'conflict' });
    const g = pendingRecurringRowLabel({ op: 'delete', failed: true, reason: 'error' });
    check(
      '8 failed DELETE -> "삭제 전송 실패" + (conflict) "다른 기기에서 변경됐어요" / (else) pull-to-refresh',
      c.primary === '삭제 전송 실패' && c.detail === '다른 기기에서 변경됐어요' &&
        g.primary === '삭제 전송 실패' && g.detail === '아래로 당겨 다시 시도',
      JSON.stringify({ c, g }),
    );
  }

  // 9 — attempted active metadata format: exact copy, no raw boolean/JSON
  {
    const on = attemptedActiveLabel(true);
    const off = attemptedActiveLabel(false);
    check(
      '9 attemptedActiveLabel -> "시도한 상태: 활성" / "시도한 상태: 일시정지" only',
      on === '시도한 상태: 활성' && off === '시도한 상태: 일시정지',
      JSON.stringify({ on, off }),
    );
  }

  // 10 — every pending/failed row state is read-only
  {
    const states = [
      { op: 'create' as const, failed: false },
      { op: 'update' as const, updateKind: 'full' as const, failed: false },
      { op: 'update' as const, updateKind: 'active' as const, failed: false },
      { op: 'delete' as const, failed: false },
      { op: 'create' as const, failed: true, reason: 'conflict' as const },
      { op: 'update' as const, updateKind: 'full' as const, failed: true, reason: 'conflict' as const },
      { op: 'update' as const, updateKind: 'active' as const, failed: true, reason: 'conflict' as const },
      { op: 'delete' as const, failed: true, reason: 'conflict' as const },
    ];
    check(
      '10 every pending/failed recurring row is read-only',
      states.every((s) => isPendingRecurringRowReadOnly(s) === true),
      'table',
    );
  }

  // 11 — ACTIVE failed -> label never mentions/implies the attempted state as
  // fact; it is presented as a FAILURE, distinctly worded from the pending
  // copy, so the UI cannot mistake a failed toggle for a landed one.
  {
    const pending = pendingRecurringRowLabel({ op: 'update', updateKind: 'active', failed: false });
    const failed = pendingRecurringRowLabel({ op: 'update', updateKind: 'active', failed: true, reason: 'conflict' });
    check(
      '11 ACTIVE failed label is distinct from ACTIVE pending label (authoritative-state presentation)',
      pending.primary !== failed.primary && failed.detail !== null,
      JSON.stringify({ pending, failed }),
    );
  }

  // 12 — isRecurringCrossDeviceConflict truth table
  {
    const t =
      isRecurringCrossDeviceConflict('conflict') === true &&
      isRecurringCrossDeviceConflict('deleted') === true &&
      isRecurringCrossDeviceConflict('gone') === true &&
      isRecurringCrossDeviceConflict('identity') === false &&
      isRecurringCrossDeviceConflict('error') === false &&
      isRecurringCrossDeviceConflict(undefined) === false;
    check('12 isRecurringCrossDeviceConflict classifies conflict/deleted/gone only', t, 'table');
  }

  // 13 — the orphan ACTIVE failure notice uses THIS SAME row-less label
  // function (no RecurringRule required) — confirms it works given only the
  // op-state, exactly what `attemptedActiveById` + `failedReasons` provide
  // with no row behind them.
  {
    const l = pendingRecurringRowLabel({ op: 'update', updateKind: 'active', failed: true, reason: 'gone' });
    check(
      '13 orphan ACTIVE state (row-less) -> "상태 변경 실패" + "다른 기기에서 삭제됐어요", no row/RecurringRule needed',
      l.primary === '상태 변경 실패' && l.detail === '다른 기기에서 삭제됐어요',
      JSON.stringify(l),
    );
  }

  // 14 — exhaustive: primary always non-empty; detail present iff failed; never carries a number
  {
    const ops: Array<{ op: 'create' | 'update' | 'delete'; updateKind?: 'full' | 'active' }> = [
      { op: 'create' },
      { op: 'update', updateKind: 'full' },
      { op: 'update', updateKind: 'active' },
      { op: 'delete' },
    ];
    const reasons = [undefined, 'identity', 'conflict', 'deleted', 'gone', 'error'] as const;
    let ok = true;
    for (const o of ops) {
      for (const failed of [false, true]) {
        for (const reason of reasons) {
          const l = pendingRecurringRowLabel({ ...o, failed, reason });
          if (typeof l.primary !== 'string' || l.primary.length === 0) ok = false;
          if (failed && (l.detail === null || l.detail.length === 0)) ok = false;
          if (!failed && l.detail !== null) ok = false;
          if (/\d/.test(l.primary) || (l.detail && /\d/.test(l.detail))) ok = false;
        }
      }
    }
    check('14 exhaustive: primary non-empty; detail iff failed; never carries a number', ok, 'exhaustive');
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
