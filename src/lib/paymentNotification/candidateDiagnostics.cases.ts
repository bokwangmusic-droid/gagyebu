/**
 * Static verification for the read-only 후보 상태 진단 (candidateDiagnostics.ts).
 * Same convention as the other *.cases.ts files: plain data + a runner,
 * never imported by the app. Each case checks the liveness / source the
 * diagnostics report, and that they match what /input's existing-payment
 * check (checkExistingPayment over the same queue + server answers) decides.
 */
import {
  diagnosePaymentCandidate,
  type CandidateDiagnosticIO,
  type QueuedTransactionDiagnostic,
} from '@/lib/paymentNotification/candidateDiagnostics';
import type { PaymentCandidateStateEntry } from '@/lib/paymentNotification/candidateInbox';
import {
  checkExistingPayment,
  queuedTransactionLiveness,
  type ExistingPaymentIO,
  type PaymentTransactionLiveness,
} from '@/lib/paymentNotification/existingPayment';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NOW = 1_800_000_000_000;
const HH = '11111111-1111-4111-8111-111111111111';
const FP = 'pc1_abc123';
const TXN = 'txn-1800000000000-abcd';

const saved = (extra: PaymentCandidateStateEntry = {}): PaymentCandidateStateEntry => ({
  sentAt: NOW - 5000,
  handledAt: NOW - 1000,
  manualTxnId: TXN,
  manualHouseholdId: HH,
  manualSavedAt: NOW - 1000,
  ...extra,
});

const op = (over: Partial<QueuedTransactionDiagnostic>): QueuedTransactionDiagnostic => ({
  op: 'create',
  failed: false,
  attemptCount: 3,
  enqueuedAt: '2026-11-11T01:00:00.000Z',
  lastAttemptAt: '2026-11-11T01:05:00.000Z',
  lastError: null,
  lastErrorReason: null,
  ...over,
});

/** Fake queue + server; counts server reads. */
function world(queue: Record<string, QueuedTransactionDiagnostic>, server: Record<string, PaymentTransactionLiveness>) {
  const calls = { server: 0 };
  const serverLiveness = async (id: string): Promise<PaymentTransactionLiveness> => {
    calls.server += 1;
    return server[id] ?? 'missing';
  };
  const diag: CandidateDiagnosticIO = { queued: (id) => queue[id] ?? null, serverLiveness };
  // /input's existingPaymentIO over the same answers (no event: getLink unused).
  const input: ExistingPaymentIO = {
    getLink: async () => ({ ok: false, transport: false }),
    liveness: async (id) => {
      const q = queue[id];
      return queuedTransactionLiveness(q ? { op: q.op, failed: q.failed } : null) ?? serverLiveness(id);
    },
    confirm: async () => 'unknown',
  };
  return { diag, input, calls };
}

export async function runCandidateDiagnosticsCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  // DIAG-1 — no manualTxnId: state shown, no liveness asked.
  {
    const w = world({}, {});
    const d = await diagnosePaymentCandidate(FP, { sentAt: NOW - 5000 }, HH, w.diag);
    const verdict = await checkExistingPayment({ manualTxnId: null, eventId: null }, w.input);
    check(
      'DIAG-1 no manualTxnId → manual null, nothing read; /input check says new',
      d.manual === null && d.manualTxnId === null && d.sentAt === NOW - 5000 && d.handledAt === null &&
        w.calls.server === 0 && verdict.kind === 'new',
      JSON.stringify({ d, verdict }),
    );
  }

  // DIAG-2 — manualTxnId, no queue op, server row alive.
  {
    const w = world({}, { [TXN]: 'live' });
    const d = await diagnosePaymentCandidate(FP, saved(), HH, w.diag);
    const verdict = await checkExistingPayment({ manualTxnId: TXN, eventId: null }, w.input);
    check(
      'DIAG-2 manualTxnId + server live → live · source server · queue none; /input says exists',
      d.manual?.liveness === 'live' && d.manual.source === 'server' && d.manual.queued === null &&
        d.manual.sameHousehold && verdict.kind === 'exists',
      JSON.stringify({ d, verdict }),
    );
  }

  // DIAG-3 — manualTxnId with a pending queued create (server never asked).
  {
    const w = world({ [TXN]: op({}) }, {});
    const d = await diagnosePaymentCandidate(FP, saved(), HH, w.diag);
    const verdict = await checkExistingPayment({ manualTxnId: TXN, eventId: null }, w.input);
    check(
      'DIAG-3 manualTxnId + queue pending create → live · source queue · pending, attempts shown, server not read; /input says exists',
      d.manual?.liveness === 'live' && d.manual.source === 'queue' && d.manual.queued?.op === 'create' &&
        d.manual.queued.failed === false && d.manual.queued.attemptCount === 3 && w.calls.server === 0 &&
        verdict.kind === 'exists',
      JSON.stringify({ d, verdict }),
    );
  }

  // DIAG-4 — manualTxnId with a terminal-failed (held) queued create.
  {
    const w = world({ [TXN]: op({ failed: true, lastError: '거래를 저장하지 못했어요.', lastErrorReason: 'error' }) }, {});
    const d = await diagnosePaymentCandidate(FP, saved(), HH, w.diag);
    const verdict = await checkExistingPayment({ manualTxnId: TXN, eventId: null }, w.input);
    check(
      'DIAG-4 manualTxnId + queue terminal-failed create → STILL live · source queue · failed + lastError shown; /input says exists',
      d.manual?.liveness === 'live' && d.manual.source === 'queue' && d.manual.queued?.failed === true &&
        d.manual.queued.lastError === '거래를 저장하지 못했어요.' && d.manual.queued.lastErrorReason === 'error' &&
        w.calls.server === 0 && verdict.kind === 'exists',
      JSON.stringify({ d, verdict }),
    );
  }

  // DIAG-5 — manualTxnId, no queue op, no server row.
  {
    const w = world({}, {});
    const d = await diagnosePaymentCandidate(FP, saved(), HH, w.diag);
    const serverReads = w.calls.server;
    const verdict = await checkExistingPayment({ manualTxnId: TXN, eventId: null }, w.input);
    check(
      'DIAG-5 manualTxnId + nothing anywhere → missing · source server; /input says stale (asks to re-enter), not exists',
      d.manual?.liveness === 'missing' && d.manual.source === 'server' && d.manual.queued === null &&
        serverReads === 1 && verdict.kind === 'stale',
      JSON.stringify({ d, verdict }),
    );
  }

  // DIAG-6 — the other answers keep their source: a pending delete decides
  // `deleted` from the queue; a server read failure is `unknown`; another
  // household's record is flagged.
  {
    const w = world({ [TXN]: op({ op: 'delete' }) }, { [TXN]: 'live' });
    const del = await diagnosePaymentCandidate(FP, saved(), HH, w.diag);
    const failing: CandidateDiagnosticIO = {
      queued: () => null,
      serverLiveness: async () => {
        throw new Error('offline');
      },
    };
    const unk = await diagnosePaymentCandidate(FP, saved(), HH, failing);
    const other = await diagnosePaymentCandidate(FP, saved({ manualHouseholdId: 'other-hh' }), HH, world({}, { [TXN]: 'live' }).diag);
    check(
      'DIAG-6 pending delete → deleted · queue; server throws → unknown · server; other household flagged',
      del.manual?.liveness === 'deleted' && del.manual.source === 'queue' &&
        unk.manual?.liveness === 'unknown' && unk.manual.source === 'server' &&
        other.manual?.sameHousehold === false,
      JSON.stringify({ del: del.manual, unk: unk.manual, other: other.manual }),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
