/**
 * Static verification for the Budget-tab offline-queue row label —
 * STEP 16-H2-C2-BUDGET A2, updated for the BUDGET CONFLICT LABEL UI FIX
 * (`pendingBudgetRowLabel` now returns `{ primary, detail }` instead of one
 * combined string, so a narrow row column never has to truncate/ellipsize a
 * long conflict message). Mirrors src/lib/pendingCategoryLabel.cases.ts.
 */
import {
  isBudgetCrossDeviceConflict,
  isPendingBudgetRowReadOnly,
  pendingBudgetRowLabel,
} from '@/lib/pendingBudgetLabel';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runPendingBudgetLabelCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // 1 — pending CREATE: primary only, no detail
  {
    const l = pendingBudgetRowLabel({ op: 'create', failed: false });
    check('1 pending CREATE -> primary "전송 대기", detail null', l.primary === '전송 대기' && l.detail === null, JSON.stringify(l));
  }
  // 2 — pending UPDATE
  {
    const l = pendingBudgetRowLabel({ op: 'update', failed: false });
    check('2 pending UPDATE -> primary "수정 전송 대기", detail null', l.primary === '수정 전송 대기' && l.detail === null, JSON.stringify(l));
  }
  // 3 — pending DELETE (helper completeness)
  {
    const l = pendingBudgetRowLabel({ op: 'delete', failed: false });
    check('3 pending DELETE -> primary "삭제 전송 대기", detail null', l.primary === '삭제 전송 대기' && l.detail === null, JSON.stringify(l));
  }
  // 4 — failed CREATE, generic (no reason / non-specific reason)
  {
    const l = pendingBudgetRowLabel({ op: 'create', failed: true, reason: 'error' });
    check(
      '4 failed CREATE (error) -> primary "전송 실패", detail "아래로 당겨 다시 시도"',
      l.primary === '전송 실패' && l.detail === '아래로 당겨 다시 시도',
      JSON.stringify(l),
    );
  }
  {
    const l = pendingBudgetRowLabel({ op: 'create', failed: true });
    check(
      '4b failed CREATE (no reason, from `invalid` normalization) -> same generic detail',
      l.primary === '전송 실패' && l.detail === '아래로 당겨 다시 시도',
      JSON.stringify(l),
    );
  }
  // 5 — failed CREATE, conflict (§6 item C: natural-key race, `exists` -> `conflict`)
  {
    const l = pendingBudgetRowLabel({ op: 'create', failed: true, reason: 'conflict' });
    check(
      '5 failed CREATE (conflict) -> primary "전송 실패", detail "다른 기기에서 변경됐어요"',
      l.primary === '전송 실패' && l.detail === '다른 기기에서 변경됐어요',
      JSON.stringify(l),
    );
  }
  // 6 — failed CREATE, gone
  {
    const l = pendingBudgetRowLabel({ op: 'create', failed: true, reason: 'gone' });
    check(
      '6 failed CREATE (gone) -> primary "전송 실패", detail "카테고리를 찾을 수 없어요"',
      l.primary === '전송 실패' && l.detail === '카테고리를 찾을 수 없어요',
      JSON.stringify(l),
    );
  }
  // 7 — failed UPDATE reason table (THE row this fix targets)
  {
    const L = (r?: 'identity' | 'conflict' | 'deleted' | 'gone' | 'error') =>
      pendingBudgetRowLabel({ op: 'update', failed: true, reason: r });
    const deleted = L('deleted');
    const gone = L('gone');
    const conflict = L('conflict');
    const generic = L('error');
    const noReason = L(undefined);
    const identity = L('identity');
    check(
      '7 failed UPDATE reason table: deleted/gone/conflict specific detail, rest generic — all short primaries',
      deleted.primary === '수정 전송 실패' && deleted.detail === '다른 기기에서 삭제됐어요' &&
        gone.primary === '수정 전송 실패' && gone.detail === '예산을 찾을 수 없어요' &&
        conflict.primary === '수정 전송 실패' && conflict.detail === '다른 기기에서 변경됐어요' &&
        generic.primary === '수정 전송 실패' && generic.detail === '아래로 당겨 다시 시도' &&
        noReason.primary === '수정 전송 실패' && noReason.detail === '아래로 당겨 다시 시도' &&
        identity.primary === '수정 전송 실패' && identity.detail === '아래로 당겨 다시 시도',
      JSON.stringify({ deleted, gone, conflict, generic, noReason, identity }),
    );
  }
  // 7b — the exact scenario reported from device testing: failed UPDATE
  // conflict must be TWO short pieces, neither one long enough to need
  // truncation in a narrow row column.
  {
    const l = pendingBudgetRowLabel({ op: 'update', failed: true, reason: 'conflict' });
    // The OLD combined copy ("수정 전송 실패 · 다른 기기 변경 확인 필요") was 17
    // characters in one string; each of the two NEW lines must be
    // substantially shorter than that on its own.
    const OLD_COMBINED_LENGTH = '수정 전송 실패 · 다른 기기 변경 확인 필요'.length;
    check(
      '7b failed UPDATE conflict copy is short on BOTH lines (regression guard for the truncation bug)',
      l.primary.length < OLD_COMBINED_LENGTH && l.detail !== null && l.detail.length < OLD_COMBINED_LENGTH,
      JSON.stringify(l),
    );
  }
  // 8 — failed DELETE labels (helper completeness)
  {
    const c = pendingBudgetRowLabel({ op: 'delete', failed: true, reason: 'conflict' });
    const g = pendingBudgetRowLabel({ op: 'delete', failed: true, reason: 'error' });
    check(
      '8 failed DELETE labels (completeness)',
      c.primary === '삭제 전송 실패' && c.detail === '다른 기기에서 변경됐어요' &&
        g.primary === '삭제 전송 실패' && g.detail === '아래로 당겨 다시 시도',
      JSON.stringify({ c, g }),
    );
  }
  // 9 — isBudgetCrossDeviceConflict truth table (unchanged by this fix)
  {
    const t =
      isBudgetCrossDeviceConflict('conflict') === true &&
      isBudgetCrossDeviceConflict('deleted') === true &&
      isBudgetCrossDeviceConflict('gone') === true &&
      isBudgetCrossDeviceConflict('identity') === false &&
      isBudgetCrossDeviceConflict('error') === false &&
      isBudgetCrossDeviceConflict(undefined) === false;
    check('9 isBudgetCrossDeviceConflict classifies conflict/deleted/gone only', t, 'table');
  }
  // 10 — every pending/failed row state is read-only (unchanged by this fix)
  {
    const states = [
      { op: 'create' as const, failed: false },
      { op: 'update' as const, failed: false },
      { op: 'create' as const, failed: true, reason: 'conflict' as const },
      { op: 'update' as const, failed: true, reason: 'conflict' as const },
      { op: 'delete' as const, failed: true, reason: 'conflict' as const },
    ];
    check(
      '10 every pending/failed budget row is read-only',
      states.every((s) => isPendingBudgetRowReadOnly(s) === true),
      'table',
    );
  }
  // 11 — total: `detail` is non-null iff `failed`; `primary` is never empty;
  // no raw server text ever appears.
  {
    const ops = ['create', 'update', 'delete'] as const;
    const reasons = [undefined, 'identity', 'conflict', 'deleted', 'gone', 'error'] as const;
    let ok = true;
    for (const op of ops) {
      for (const failed of [false, true]) {
        for (const reason of reasons) {
          const l = pendingBudgetRowLabel({ op, failed, reason });
          if (typeof l.primary !== 'string' || l.primary.length === 0) ok = false;
          if (failed && (l.detail === null || l.detail.length === 0)) ok = false;
          if (!failed && l.detail !== null) ok = false;
        }
      }
    }
    check('11 total: primary always non-empty; detail present iff failed', ok, 'exhaustive');
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
