/**
 * Static verification for the savings-goal offline-queue row label —
 * STEP 16-H2-G3 (created), reason wording refined in STEP 16-H2-G6.
 * Mirrors src/lib/pendingPlannedLabel.cases.ts / pendingCardLabel.cases.ts.
 *
 * The core STEP 16-H2-G6 assertion (repeated per op/movement below): a
 * TERMINAL reason that a retry can NEVER fix (`conflict` / `gone` /
 * `deleted` / `insufficient`) must NEVER produce a label containing "다시
 * 시도" (the retry-suggesting suffix) — that phrasing is reserved for a
 * genuinely unclassified/unknown terminal failure only.
 */
import {
  isGoalCrossDeviceConflict,
  isPendingGoalRowReadOnly,
  pendingGoalRowLabel,
  type PendingGoalRowState,
} from '@/lib/pendingGoalLabel';
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NON_RETRYABLE: WriteConflictReason[] = ['conflict', 'gone', 'deleted', 'insufficient'];
const RETRY_SUFFIX = '아래로 당겨 다시 시도';

export async function runPendingGoalLabelCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  /* ============================ PENDING (not failed) ============================ */

  // 1 — pending create/update/delete, untouched wording
  {
    const c = pendingGoalRowLabel({ op: 'create', failed: false });
    const u = pendingGoalRowLabel({ op: 'update', failed: false });
    const d = pendingGoalRowLabel({ op: 'delete', failed: false });
    check(
      '1 pending CREATE/UPDATE/DELETE wording unchanged by STEP 16-H2-G6',
      c === '전송 대기 · 인터넷에 연결되면 자동으로 반영할게요' &&
        u === '수정 전송 대기' &&
        d === '삭제 전송 대기',
      JSON.stringify({ c, u, d }),
    );
  }

  // 2 — pending movement (deposit/withdraw), distinct from a plain update
  {
    const dep = pendingGoalRowLabel({ op: 'update', failed: false, movement: { mode: 'deposit' } });
    const wd = pendingGoalRowLabel({ op: 'update', failed: false, movement: { mode: 'withdraw' } });
    check(
      '2 pending movement says 저축/인출 (not a generic "수정 전송 대기"), both auto-반영 worded',
      dep === '저축 전송 대기 · 인터넷 연결 후 자동 반영' &&
        wd === '인출 전송 대기 · 인터넷 연결 후 자동 반영',
      JSON.stringify({ dep, wd }),
    );
  }

  /* ==================== A. insufficient ==================== */

  // 3 — failed movement, insufficient -> dedicated wording, no retry suggestion
  {
    const dep = pendingGoalRowLabel({ op: 'update', failed: true, reason: 'insufficient', movement: { mode: 'deposit' } });
    const wd = pendingGoalRowLabel({ op: 'update', failed: true, reason: 'insufficient', movement: { mode: 'withdraw' } });
    check(
      '3 (A) insufficient -> "인출 가능한 금액이 부족해요", no "다시 시도" wording, for BOTH deposit/withdraw framing',
      dep === '저축 전송 실패 · 인출 가능한 금액이 부족해요' &&
        wd === '인출 전송 실패 · 인출 가능한 금액이 부족해요' &&
        !dep.includes('다시 시도') &&
        !wd.includes('다시 시도'),
      JSON.stringify({ dep, wd }),
    );
  }

  /* ==================== B. conflict ==================== */

  // 4 — failed create/update/delete/movement, conflict -> "다른 기기에서 변경된 내용이 있어요"
  {
    const c = pendingGoalRowLabel({ op: 'create', failed: true, reason: 'conflict' });
    const u = pendingGoalRowLabel({ op: 'update', failed: true, reason: 'conflict' });
    const d = pendingGoalRowLabel({ op: 'delete', failed: true, reason: 'conflict' });
    const m = pendingGoalRowLabel({ op: 'update', failed: true, reason: 'conflict', movement: { mode: 'deposit' } });
    const clause = '다른 기기에서 변경된 내용이 있어요';
    check(
      '4 (B) conflict -> same clause across create/update/delete/movement, no retry suggestion',
      c === `전송 실패 · ${clause}` &&
        u === `수정 전송 실패 · ${clause}` &&
        d === `삭제 전송 실패 · ${clause}` &&
        m === `저축 전송 실패 · ${clause}` &&
        [c, u, d, m].every((s) => !s.includes('다시 시도')),
      JSON.stringify({ c, u, d, m }),
    );
  }

  /* ==================== C. gone / deleted (unified) ==================== */

  // 5 — failed create/update/delete/movement, gone AND deleted -> the SAME unified clause
  {
    const clause = '이미 삭제된 목표예요';
    const pairs: { op: PendingGoalRowState['op']; movement?: PendingGoalRowState['movement'] }[] = [
      { op: 'create' },
      { op: 'update' },
      { op: 'delete' },
      { op: 'update', movement: { mode: 'withdraw' } },
    ];
    let ok = true;
    const detail: unknown[] = [];
    for (const p of pairs) {
      const gone = pendingGoalRowLabel({ ...p, failed: true, reason: 'gone' });
      const deleted = pendingGoalRowLabel({ ...p, failed: true, reason: 'deleted' });
      detail.push({ p, gone, deleted });
      if (!gone.endsWith(clause) || !deleted.endsWith(clause)) ok = false;
      if (gone !== deleted) ok = false; // gone and deleted are DELIBERATELY unified
    }
    check(
      '5 (C) gone/deleted unified into "이미 삭제된 목표예요" across every op, gone === deleted wording',
      ok,
      JSON.stringify(detail),
    );
  }

  /* ==================== D. invalid (never reaches here — documents the boundary) ==================== */

  // 6 — 'invalid' is not part of WriteConflictReason (runOp.ts flattens it to
  // `undefined` before it ever reaches this label) — this case documents
  // that boundary rather than asserting new wording for it (STEP 16-H2-G6
  // deliberately leaves it in the generic bucket; see file header).
  {
    const u = pendingGoalRowLabel({ op: 'update', failed: true, reason: undefined });
    check(
      '6 (D) undefined reason (incl. the flattened-away invalid) -> generic pull-to-refresh clause, unchanged',
      u === `수정 전송 실패 · ${RETRY_SUFFIX}`,
      JSON.stringify(u),
    );
  }

  /* ==================== E. unknown terminal failure ==================== */

  // 7 — identity/error keep the existing generic clause (STEP 16-H2-G6 §2 allows this)
  {
    const i = pendingGoalRowLabel({ op: 'update', failed: true, reason: 'identity' });
    const e = pendingGoalRowLabel({ op: 'update', failed: true, reason: 'error' });
    check(
      '7 (E) identity/error -> unchanged generic "아래로 당겨 다시 시도" clause',
      i === `수정 전송 실패 · ${RETRY_SUFFIX}` && e === `수정 전송 실패 · ${RETRY_SUFFIX}`,
      JSON.stringify({ i, e }),
    );
  }

  /* ==================== F. active pending never mixes with terminal wording ==================== */

  // 8 — a NOT-failed row (any reason present or not) NEVER shows a terminal clause
  {
    const states: PendingGoalRowState[] = [
      { op: 'create', failed: false },
      { op: 'update', failed: false, movement: { mode: 'deposit' } },
      { op: 'update', failed: false, movement: { mode: 'withdraw' } },
      { op: 'delete', failed: false },
    ];
    const labels = states.map((s) => pendingGoalRowLabel(s));
    check(
      '8 (F) pending (not failed) rows never contain a terminal-failure clause',
      labels.every(
        (l) =>
          !l.includes('전송 실패') &&
          !l.includes('부족해요') &&
          !l.includes('변경된 내용이 있어요') &&
          !l.includes('삭제된 목표예요'),
      ),
      JSON.stringify(labels),
    );
  }

  /* ==================== exhaustive: no non-retryable reason ever suggests retry ==================== */

  // 9 — exhaustive sweep: NONE of the non-retryable reasons ever produce the
  // "다시 시도" suffix, across every op and both movement modes (§2's central
  // guarantee, restated exhaustively rather than case-by-case).
  {
    const ops: PendingGoalRowState['op'][] = ['create', 'update', 'delete'];
    const movementModes: (PendingGoalRowState['movement'] | undefined)[] = [
      undefined,
      { mode: 'deposit' },
      { mode: 'withdraw' },
    ];
    let ok = true;
    const offenders: unknown[] = [];
    for (const op of ops) {
      for (const movement of movementModes) {
        for (const reason of NON_RETRYABLE) {
          const l = pendingGoalRowLabel({ op, failed: true, reason, movement });
          if (l.includes('다시 시도')) {
            ok = false;
            offenders.push({ op, movement, reason, l });
          }
        }
      }
    }
    check(
      '9 exhaustive: conflict/gone/deleted/insufficient NEVER suggest retry, across every op + movement mode',
      ok,
      JSON.stringify(offenders),
    );
  }

  /* ==================== helpers unchanged ==================== */

  // 10 — isGoalCrossDeviceConflict: conflict/deleted/gone only; insufficient
  // is a LOCAL state issue, not a cross-device one, so it stays false.
  {
    const t =
      isGoalCrossDeviceConflict('conflict') === true &&
      isGoalCrossDeviceConflict('deleted') === true &&
      isGoalCrossDeviceConflict('gone') === true &&
      isGoalCrossDeviceConflict('insufficient') === false &&
      isGoalCrossDeviceConflict('identity') === false &&
      isGoalCrossDeviceConflict('error') === false &&
      isGoalCrossDeviceConflict(undefined) === false;
    check('10 isGoalCrossDeviceConflict classifies conflict/deleted/gone only (insufficient excluded)', t, 'table');
  }

  // 11 — every pending/failed row state is read-only
  {
    const states: PendingGoalRowState[] = [
      { op: 'create', failed: false },
      { op: 'update', failed: false },
      { op: 'delete', failed: false },
      { op: 'create', failed: true, reason: 'conflict' },
      { op: 'update', failed: true, reason: 'insufficient', movement: { mode: 'withdraw' } },
      { op: 'delete', failed: true, reason: 'gone' },
    ];
    check(
      '11 every pending/failed goal row is read-only',
      states.every((s) => isPendingGoalRowReadOnly(s) === true),
      'table',
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
