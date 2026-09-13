/**
 * Static verification for the loan offline-queue row label — STEP 16-H2-L2.
 * Mirrors src/lib/pendingGoalLabel.cases.ts.
 *
 * The core assertion (repeated per op/payment below): a TERMINAL reason that
 * a retry can NEVER fix (`conflict` / `gone` / `deleted` / `principal_low` /
 * `paid_off` / `stale`) must NEVER produce a label containing "다시 시도"
 * (the retry-suggesting suffix) — that phrasing is reserved for a genuinely
 * unclassified/unknown terminal failure only.
 */
import {
  isLoanCrossDeviceConflict,
  isPendingLoanRowReadOnly,
  pendingLoanRowLabel,
  type PendingLoanRowState,
} from '@/lib/pendingLoanLabel';
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NON_RETRYABLE: WriteConflictReason[] = ['conflict', 'gone', 'deleted', 'principal_low', 'paid_off', 'stale'];
const RETRY_SUFFIX = '아래로 당겨 다시 시도';

export async function runPendingLoanLabelCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  /* ============================ PENDING (not failed) ============================ */

  // A — pending loan create/update/delete wording
  {
    const c = pendingLoanRowLabel({ op: 'create', failed: false });
    const u = pendingLoanRowLabel({ op: 'update', failed: false });
    const d = pendingLoanRowLabel({ op: 'delete', failed: false });
    check(
      'A pending loan CREATE/UPDATE/DELETE — all carry the "· 인터넷 연결 후 자동 반영" suffix',
      c === '생성 전송 대기 · 인터넷 연결 후 자동 반영' &&
        u === '수정 전송 대기 · 인터넷 연결 후 자동 반영' &&
        d === '삭제 전송 대기 · 인터넷 연결 후 자동 반영',
      JSON.stringify({ c, u, d }),
    );
  }

  // D/E — pending payment create/delete, distinct from a plain update
  {
    const create = pendingLoanRowLabel({ op: 'update', failed: false, payment: { kind: 'create' } });
    const del = pendingLoanRowLabel({ op: 'update', failed: false, payment: { kind: 'delete' } });
    check(
      'D/E pending payment create/delete say 상환/상환 취소 (not a generic "수정 전송 대기")',
      create === '상환 전송 대기 · 인터넷 연결 후 자동 반영' &&
        del === '상환 취소 전송 대기 · 인터넷 연결 후 자동 반영',
      JSON.stringify({ create, del }),
    );
  }

  /* ==================== B/C. loan create/update/delete labels, failed ==================== */

  // B — pending loan UPDATE label (not failed) already covered in A; here: failed update label shape
  {
    const u = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'conflict' });
    check(
      'B loan UPDATE failed -> "수정 전송 실패 · ..." shape',
      u === '수정 전송 실패 · 다른 기기에서 변경된 내용이 있어요',
      u,
    );
  }

  // C — loan DELETE failed label shape
  {
    const d = pendingLoanRowLabel({ op: 'delete', failed: true, reason: 'gone' });
    check('C loan DELETE failed -> "삭제 전송 실패 · 이미 삭제된 대출이에요"', d === '삭제 전송 실패 · 이미 삭제된 대출이에요', d);
  }

  /* ==================== F. conflict ==================== */

  // F — failed create/update/delete/payment, conflict -> "다른 기기에서 변경된 내용이 있어요"
  {
    const c = pendingLoanRowLabel({ op: 'create', failed: true, reason: 'conflict' });
    const u = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'conflict' });
    const d = pendingLoanRowLabel({ op: 'delete', failed: true, reason: 'conflict' });
    const pc = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'conflict', payment: { kind: 'create' } });
    const pd = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'conflict', payment: { kind: 'delete' } });
    const clause = '다른 기기에서 변경된 내용이 있어요';
    check(
      'F conflict -> same clause across create/update/delete/payment-create/payment-delete, no retry suggestion',
      c === `전송 실패 · ${clause}` &&
        u === `수정 전송 실패 · ${clause}` &&
        d === `삭제 전송 실패 · ${clause}` &&
        pc === `상환 전송 실패 · ${clause}` &&
        pd === `상환 취소 전송 실패 · ${clause}` &&
        [c, u, d, pc, pd].every((s) => !s.includes('다시 시도')),
      JSON.stringify({ c, u, d, pc, pd }),
    );
  }

  /* ==================== gone/deleted — loan vs payment wording split ==================== */

  // gone/deleted for a plain loan op or a payment CREATE names the LOAN
  {
    const pairs: { op: PendingLoanRowState['op']; payment?: PendingLoanRowState['payment'] }[] = [
      { op: 'create' },
      { op: 'update' },
      { op: 'delete' },
      { op: 'update', payment: { kind: 'create' } },
    ];
    let ok = true;
    const detail: unknown[] = [];
    for (const p of pairs) {
      const gone = pendingLoanRowLabel({ ...p, failed: true, reason: 'gone' });
      const deleted = pendingLoanRowLabel({ ...p, failed: true, reason: 'deleted' });
      detail.push({ p, gone, deleted });
      if (!gone.endsWith('이미 삭제된 대출이에요') || !deleted.endsWith('이미 삭제된 대출이에요')) ok = false;
      if (gone !== deleted) ok = false; // gone and deleted are DELIBERATELY unified
    }
    check(
      'gone/deleted for loan create/update/delete/payment-create -> "이미 삭제된 대출이에요", gone === deleted',
      ok,
      JSON.stringify(detail),
    );
  }

  // gone/deleted for a payment DELETE names the PAYMENT ROW itself
  {
    const gone = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'gone', payment: { kind: 'delete' } });
    const deleted = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'deleted', payment: { kind: 'delete' } });
    check(
      'gone/deleted for a payment DELETE -> "이미 삭제된 상환 내역이에요" (names the payment, not the loan), gone === deleted',
      gone === '상환 취소 전송 실패 · 이미 삭제된 상환 내역이에요' && gone === deleted,
      JSON.stringify({ gone, deleted }),
    );
  }

  /* ==================== G. principal_low ==================== */

  // G — principal_low is loan-UPDATE-only in practice; wording check
  {
    const u = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'principal_low' });
    check(
      'G principal_low -> "현재 상환액보다 원금이 작을 수 없어요", no retry suggestion',
      u === '수정 전송 실패 · 현재 상환액보다 원금이 작을 수 없어요' && !u.includes('다시 시도'),
      u,
    );
  }

  /* ==================== H. paid_off ==================== */

  // H — paid_off is payment-CREATE-only in practice; wording check
  {
    const pc = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'paid_off', payment: { kind: 'create' } });
    check(
      'H paid_off -> "이미 상환이 완료된 대출이에요", no retry suggestion',
      pc === '상환 전송 실패 · 이미 상환이 완료된 대출이에요' && !pc.includes('다시 시도'),
      pc,
    );
  }

  /* ==================== I. stale ==================== */

  // I — stale is payment-CREATE-only in practice; wording check
  {
    const pc = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'stale', payment: { kind: 'create' } });
    check(
      'I stale -> "최신 대출 상태를 다시 확인해주세요", no retry-SUFFIX suggestion (the word 시도 legitimately does not appear here)',
      pc === '상환 전송 실패 · 최신 대출 상태를 다시 확인해주세요' && !pc.includes('아래로 당겨 다시 시도'),
      pc,
    );
  }

  /* ==================== unknown terminal failure ==================== */

  // identity/error keep the existing generic clause (mirrors goal §E)
  {
    const i = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'identity' });
    const e = pendingLoanRowLabel({ op: 'update', failed: true, reason: 'error' });
    const u = pendingLoanRowLabel({ op: 'update', failed: true, reason: undefined });
    check(
      'identity/error/undefined -> unchanged generic "아래로 당겨 다시 시도" clause (현재 앱의 일반 실패 문구)',
      i === `수정 전송 실패 · ${RETRY_SUFFIX}` &&
        e === `수정 전송 실패 · ${RETRY_SUFFIX}` &&
        u === `수정 전송 실패 · ${RETRY_SUFFIX}`,
      JSON.stringify({ i, e, u }),
    );
  }

  /* ==================== J. active pending never mixes with terminal wording ==================== */

  // J — a NOT-failed row (any reason present or not) NEVER shows a terminal clause
  {
    const states: PendingLoanRowState[] = [
      { op: 'create', failed: false },
      { op: 'update', failed: false, payment: { kind: 'create' } },
      { op: 'update', failed: false, payment: { kind: 'delete' } },
      { op: 'delete', failed: false },
    ];
    const labels = states.map((s) => pendingLoanRowLabel(s));
    check(
      'J (F/active) pending (not failed) rows never contain a terminal-failure clause',
      labels.every(
        (l) =>
          !l.includes('전송 실패') &&
          !l.includes('변경된 내용이 있어요') &&
          !l.includes('삭제된 대출이에요') &&
          !l.includes('삭제된 상환 내역이에요') &&
          !l.includes('원금이 작을 수 없어요') &&
          !l.includes('상환이 완료된') &&
          !l.includes('다시 확인해주세요'),
      ),
      JSON.stringify(labels),
    );
  }

  /* ==================== exhaustive: no non-retryable reason ever suggests retry ==================== */

  {
    const ops: PendingLoanRowState['op'][] = ['create', 'update', 'delete'];
    const paymentKinds: (PendingLoanRowState['payment'] | undefined)[] = [
      undefined,
      { kind: 'create' },
      { kind: 'delete' },
    ];
    let ok = true;
    const offenders: unknown[] = [];
    for (const op of ops) {
      for (const payment of paymentKinds) {
        for (const reason of NON_RETRYABLE) {
          const l = pendingLoanRowLabel({ op, failed: true, reason, payment });
          if (l.includes('다시 시도')) {
            ok = false;
            offenders.push({ op, payment, reason, l });
          }
        }
      }
    }
    check(
      'exhaustive: conflict/gone/deleted/principal_low/paid_off/stale NEVER suggest the generic retry clause, across every op + payment kind',
      ok,
      JSON.stringify(offenders),
    );
  }

  /* ==================== helpers unchanged ==================== */

  {
    const t =
      isLoanCrossDeviceConflict('conflict') === true &&
      isLoanCrossDeviceConflict('deleted') === true &&
      isLoanCrossDeviceConflict('gone') === true &&
      isLoanCrossDeviceConflict('principal_low') === false &&
      isLoanCrossDeviceConflict('paid_off') === false &&
      isLoanCrossDeviceConflict('stale') === false &&
      isLoanCrossDeviceConflict('identity') === false &&
      isLoanCrossDeviceConflict('error') === false &&
      isLoanCrossDeviceConflict(undefined) === false;
    check('isLoanCrossDeviceConflict classifies conflict/deleted/gone only', t, 'table');
  }

  {
    const states: PendingLoanRowState[] = [
      { op: 'create', failed: false },
      { op: 'update', failed: false },
      { op: 'delete', failed: false },
      { op: 'create', failed: true, reason: 'conflict' },
      { op: 'update', failed: true, reason: 'paid_off', payment: { kind: 'create' } },
      { op: 'delete', failed: true, reason: 'gone' },
    ];
    check(
      'every pending/failed loan row is read-only',
      states.every((s) => isPendingLoanRowReadOnly(s) === true),
      'table',
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
