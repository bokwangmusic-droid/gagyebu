/**
 * Static verification for "우리집 가계부 데이터 전체 초기화":
 *   - src/lib/householdResetFlow.ts        (button gating + step order)
 *   - src/services/remoteHouseholdReset.ts (RPC result / error mapping)
 *   - the flow driven against the REAL offline-queue coordinator, to prove
 *     the freeze / purge / marker steps do what the flow assumes.
 *
 * Same convention as the other `.cases.ts` files: plain data + runners,
 * never imported by the app. The RPC itself is always faked — nothing here
 * can reach a database.
 */
import {
  RESET_CONFIRM_PHRASE,
  canSubmitHouseholdReset,
  createHouseholdResetRunner,
  isResetPhraseConfirmed,
  type HouseholdResetDeps,
  type ResetCallResult,
  type ResetMarkerRead,
} from '@/lib/householdResetFlow';
import {
  createResetMarkerStore,
  createResetPendingStore,
  resetMarkerKey,
  resetMarkerReached,
  type ResetMarkerMap,
  type ResetPendingMap,
  type ResetVerdictRead,
} from '@/lib/householdResetMarker';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
} from '@/services/offlineQueue/coordinator';
import type { QueueStorage } from '@/services/offlineQueue/persistence';
import type { CreateTransactionResult } from '@/services/remoteFinanceWrite';
import {
  HOUSEHOLD_RESET_MESSAGES,
  describeHouseholdResetError,
  isResetRequestId,
  parseHouseholdResetResult,
  parseHouseholdResetVerdict,
  verdictAfterOwnerLoss,
} from '@/services/remoteHouseholdReset';
import type { Transaction } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const T1 = '2026-10-08T03:21:45.123456+00:00';
const T2 = '2026-10-09T10:00:00.000001+00:00';

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

/* ------------------------------------------------------------------ *
 * 1. Button gating
 * ------------------------------------------------------------------ */

export function runHouseholdResetGateCases(): { results: CaseResult[]; passed: number; failed: number } {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const can = (role: 'owner' | 'member' | null | undefined, confirmText: string, running = false) =>
    canSubmitHouseholdReset({ role, confirmText, running });

  check('G1 phrase constant is 초기화', RESET_CONFIRM_PHRASE === '초기화', RESET_CONFIRM_PHRASE);
  check('G2 owner + exact phrase -> enabled', can('owner', '초기화') === true, String(can('owner', '초기화')));
  check('G3 owner + empty input -> disabled', can('owner', '') === false, String(can('owner', '')));
  {
    const wrong = ['초기', '초기화!', '초기화합니다', '초 기 화', 'reset', '삭제', 'ㅊㄱㅎ', '초기화\n초기화'];
    check(
      'G4 owner + any other string -> disabled',
      wrong.every((w) => can('owner', w) === false),
      wrong.filter((w) => can('owner', w)).join('|') || 'all disabled',
    );
  }
  check(
    'G5 surrounding whitespace only (IME trailing space) is forgiven',
    isResetPhraseConfirmed(' 초기화 ') && isResetPhraseConfirmed('초기화\n') && !isResetPhraseConfirmed('초 기화'),
    'trim only',
  );
  check(
    'G6 member with the exact phrase -> disabled (also null / undefined role)',
    can('member', '초기화') === false && can(null, '초기화') === false && can(undefined, '초기화') === false,
    `${can('member', '초기화')}/${can(null, '초기화')}/${can(undefined, '초기화')}`,
  );
  check('G7 owner + exact phrase but a run in flight -> disabled', can('owner', '초기화', true) === false, 'running');

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}

/* ------------------------------------------------------------------ *
 * 2. RPC result / error mapping
 * ------------------------------------------------------------------ */

export function runHouseholdResetServiceCases(): { results: CaseResult[]; passed: number; failed: number } {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const pg = (message: string, code: string) => ({ message, code, details: null, hint: null });

  {
    const ok = parseHouseholdResetResult({
      transactions: 812,
      recurring_rules: 4,
      planned_expenses: 2,
      cards: 3,
      assets: 5,
      goal_movements: 17,
      goals: 2,
      loan_payments: 9,
      loans: 1,
      budgets: 11,
      custom_categories: 6,
      reset_at: T1,
    });
    check(
      'V1 well-formed jsonb -> ok, reset_at + all 11 counts',
      ok.ok === true && ok.resetAt === T1 && ok.counts.transactions === 812 && Object.keys(ok.counts).length === 11,
      JSON.stringify(ok),
    );
  }
  {
    const bad = [null, undefined, 'x', [], {}, { transactions: 1 }, { reset_at: '' }, { reset_at: 5 }].map(
      parseHouseholdResetResult,
    );
    check(
      'V2 reply without a usable reset_at is never a success, and never "data intact" (not definitive)',
      bad.every((r) => r.ok === false && r.definitive === false && r.message === HOUSEHOLD_RESET_MESSAGES.unconfirmed),
      JSON.stringify(bad.map((r) => r.ok)),
    );
  }
  {
    const r = describeHouseholdResetError(pg('NOT_OWNER', '42501'));
    check(
      'V3 NOT_OWNER -> 방장 전용 copy, definitive',
      r.code === 'NOT_OWNER' && r.definitive && r.message === '방장만 우리집 데이터를 전체 초기화할 수 있어요',
      JSON.stringify(r),
    );
  }
  {
    const codes = [
      ['AUTH_REQUIRED', '28000'],
      ['HOUSEHOLD_NOT_FOUND', 'P0002'],
      ['HOUSEHOLD_SETTINGS_NOT_FOUND', 'P0002'],
    ] as const;
    const mapped = codes.map(([m, c]) => describeHouseholdResetError(pg(m, c)));
    check(
      'V4 AUTH_REQUIRED / HOUSEHOLD_NOT_FOUND / HOUSEHOLD_SETTINGS_NOT_FOUND -> own code, definitive, Korean copy',
      mapped.every((r, i) => r.code === codes[i][0] && r.definitive && !/[A-Z_]{6,}/.test(r.message)),
      JSON.stringify(mapped.map((r) => r.code)),
    );
    check(
      'V5 HOUSEHOLD_SETTINGS_NOT_FOUND is not mistaken for HOUSEHOLD_NOT_FOUND',
      mapped[2].code === 'HOUSEHOLD_SETTINGS_NOT_FOUND' && mapped[1].code === 'HOUSEHOLD_NOT_FOUND',
      `${mapped[1].code}/${mapped[2].code}`,
    );
  }
  {
    const r = describeHouseholdResetError(new TypeError('Network request failed'));
    check(
      'V6 transport failure -> NETWORK, offline copy, NOT definitive (the reset may have committed)',
      r.code === 'NETWORK' && r.definitive === false && r.message === '인터넷 연결 후 다시 시도해주세요',
      JSON.stringify(r),
    );
  }
  {
    const r = describeHouseholdResetError(pg('canceling statement due to statement timeout', '57014'));
    check(
      'V7 any other server verdict (statement timeout) -> UNKNOWN, definitive, "데이터는 그대로예요"',
      r.code === 'UNKNOWN' && r.definitive && r.message === '삭제하지 못했어요. 데이터는 그대로예요.',
      JSON.stringify(r),
    );
  }
  {
    const r = describeHouseholdResetError({ message: 'Bad Gateway' });
    check(
      'V8 a code-less error (gateway page, no Postgres verdict) -> UNKNOWN but NOT definitive: the call may still be running',
      r.code === 'UNKNOWN' && r.definitive === false,
      JSON.stringify(r),
    );
  }
  {
    const r = describeHouseholdResetError(pg('RESET_REQUEST_CLOSED', 'P0001'));
    check(
      'V9 RESET_REQUEST_CLOSED -> own code, NOT definitive: an earlier delivery of the same request may have committed',
      r.code === 'RESET_REQUEST_CLOSED' && r.definitive === false,
      JSON.stringify(r),
    );
  }
  {
    const committed = parseHouseholdResetVerdict({ data_reset_at: T2, committed: true, reset_at: T1 });
    const closed = parseHouseholdResetVerdict({ data_reset_at: null, committed: false, reset_at: null });
    check(
      'V10 serialized verdict: committed carries its reset_at + the current marker; not-committed is a real answer too',
      committed.ok === true &&
        committed.committed === true &&
        committed.resetAt === T1 &&
        committed.marker === T2 &&
        closed.ok === true &&
        closed.committed === false &&
        closed.marker === null,
      `${JSON.stringify(committed)} ${JSON.stringify(closed)}`,
    );
    const bad = [
      null,
      'x',
      [],
      {},
      { committed: false },
      { data_reset_at: T1 },
      { data_reset_at: 5, committed: false },
      { data_reset_at: T1, committed: 'no' },
      { data_reset_at: T1, committed: true, reset_at: null },
      { data_reset_at: T1, committed: true },
    ].map(parseHouseholdResetVerdict);
    check(
      'V11 a malformed verdict is NO answer — never "the reset did not happen"',
      bad.every((r) => r.ok === false),
      JSON.stringify(bad.map((r) => r.ok)),
    );
  }
  {
    const read = verdictAfterOwnerLoss({ ok: true, value: T1 });
    const unread = verdictAfterOwnerLoss({ ok: false });
    check(
      'V12 check refused with NOT_OWNER (ownership moved on) -> the plain marker decides; unreadable marker is still no answer',
      read.ok === true && read.committed === false && read.marker === T1 && unread.ok === false,
      `${JSON.stringify(read)} ${JSON.stringify(unread)}`,
    );
  }
  {
    const uuid = '3f2b8c1e-7a4d-4e0b-9c55-0d6a1f2e9b77';
    check(
      'V13 request id: a UUID fits the server rule (8..64 chars); null / empty / too short / too long do not',
      isResetRequestId(uuid) &&
        !isResetRequestId(null) &&
        !isResetRequestId('') &&
        !isResetRequestId('short') &&
        !isResetRequestId('x'.repeat(65)) &&
        isResetRequestId('x'.repeat(64)),
      `len=${uuid.length}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}

/* ------------------------------------------------------------------ *
 * 3. Step order, with every dependency faked
 * ------------------------------------------------------------------ */

function fakeDeps(over: {
  markers?: ResetMarkerRead[];
  call?: () => Promise<ResetCallResult>;
  /** one answer for every purge attempt, or one per attempt (the last repeats) */
  clearOk?: boolean | boolean[];
  refreshOk?: boolean;
  armOk?: boolean;
  syncThrows?: boolean;
  /** the serialized check's answer; default = "closed, did not run", marker unchanged */
  verdict?: () => Promise<ResetVerdictRead>;
}) {
  const log: string[] = [];
  const markers = [...(over.markers ?? [{ ok: true, value: null } as ResetMarkerRead])];
  const clears = Array.isArray(over.clearOk) ? [...over.clearOk] : [over.clearOk ?? true];
  const deps: HouseholdResetDeps = {
    readMarker: () => {
      log.push('readMarker');
      return Promise.resolve(markers.length > 1 ? (markers.shift() as ResetMarkerRead) : markers[0]);
    },
    armMarker: (current) => {
      log.push(`arm:${current}`);
      return Promise.resolve(over.armOk ?? true);
    },
    verifyReset: () => {
      log.push('verify');
      return over.verdict
        ? over.verdict()
        : Promise.resolve({ ok: true, committed: false, resetAt: null, marker: markers[0].ok ? markers[0].value : null });
    },
    settle: () => {
      log.push('settle');
      return Promise.resolve();
    },
    pauseQueue: () => {
      log.push('pause');
      return Promise.resolve();
    },
    resumeQueue: () => {
      log.push('resume');
    },
    callReset: () => {
      log.push('rpc');
      return over.call ? over.call() : Promise.resolve({ ok: true, resetAt: T1 });
    },
    clearPending: () => {
      log.push('clear');
      return Promise.resolve({ ok: clears.length > 1 ? (clears.shift() as boolean) : clears[0] });
    },
    syncMarker: (resetAt) => {
      log.push(`sync:${resetAt}`);
      return over.syncThrows ? Promise.reject(new Error('disk full')) : Promise.resolve();
    },
    refresh: (resetAt) => {
      log.push(`refresh:${resetAt}`);
      return Promise.resolve(over.refreshOk ?? true);
    },
  };
  return { deps, log };
}

export async function runHouseholdResetFlowCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const NETWORK: ResetCallResult = { ok: false, code: 'NETWORK', definitive: false };

  // F1 — success: exact step order
  {
    const { deps, log } = fakeDeps({});
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F1 success order: readMarker -> arm -> pause -> rpc -> clear -> sync(marker) -> settle -> resume -> refresh',
      out.kind === 'done' &&
        log.join() === `readMarker,arm:null,pause,rpc,clear,sync:${T1},settle,resume,refresh:${T1}`,
      `${out.kind} ${log.join()}`,
    );
  }
  // F2 — offline: nothing is frozen, the RPC is never called
  {
    const { deps, log } = fakeDeps({ markers: [{ ok: false }] });
    const out = await createHouseholdResetRunner()(deps);
    check('F2 offline -> no pause, no rpc', out.kind === 'offline' && log.join() === 'readMarker', `${out.kind} ${log.join()}`);
  }
  // F3 — server refused (definitive): resume, no clear, no marker, no refresh
  {
    const { deps, log } = fakeDeps({
      call: () => Promise.resolve({ ok: false, code: 'UNKNOWN', definitive: true }),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F3 RPC failed (definitive) -> attempt settled, queue resumed; nothing cleared, no marker, no refresh, no check needed',
      out.kind === 'failed' && log.join() === 'readMarker,arm:null,pause,rpc,settle,resume',
      `${out.kind} ${log.join()}`,
    );
  }
  // F4 — NOT_OWNER
  {
    const { deps, log } = fakeDeps({
      call: () => Promise.resolve({ ok: false, code: 'NOT_OWNER', definitive: true }),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F4 NOT_OWNER -> not-owner outcome, queue resumed, nothing cleared',
      out.kind === 'not-owner' && log.join() === 'readMarker,arm:null,pause,rpc,settle,resume',
      `${out.kind} ${log.join()}`,
    );
  }
  // F5 — no verdict, the serialized check says THIS attempt committed -> handled as success
  {
    const { deps, log } = fakeDeps({
      markers: [{ ok: true, value: T1 }],
      call: () => Promise.resolve(NETWORK),
      verdict: () => Promise.resolve({ ok: true, committed: true, resetAt: T2, marker: T2 }),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F5 transport error, serialized check: committed at T2 -> clear + sync(T2) + settle + refresh; ONE check, no marker re-reads',
      out.kind === 'done' &&
        out.resetAt === T2 &&
        log.join() === `readMarker,arm:${T1},pause,rpc,verify,clear,sync:${T2},settle,resume,refresh:${T2}`,
      `${JSON.stringify(out)} ${log.join()}`,
    );
  }
  // F6 — no verdict, the serialized check says it did not run (and closed it): nothing was deleted
  {
    const { deps, log } = fakeDeps({
      markers: [{ ok: true, value: T1 }],
      call: () => Promise.resolve(NETWORK),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F6 transport error, serialized check: not committed, marker still T1 -> failed, settled, resumed; decided by the check, not by waiting',
      out.kind === 'failed' && log.join() === `readMarker,arm:${T1},pause,rpc,verify,settle,resume`,
      `${out.kind} ${log.join()}`,
    );
  }
  // F7 — no verdict and the check itself gets no answer: unconfirmed, never "data intact", never success
  {
    const { deps, log } = fakeDeps({
      markers: [{ ok: true, value: T1 }],
      call: () => Promise.resolve(NETWORK),
      verdict: () => Promise.resolve({ ok: false }),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F7 transport error and no answer from the serialized check -> unconfirmed; nothing cleared, attempt NOT settled',
      out.kind === 'unconfirmed' && log.join() === `readMarker,arm:${T1},pause,rpc,verify,resume`,
      `${out.kind} ${log.join()}`,
    );
  }
  // F8 — a THROWING rpc is "no verdict", and the queue is still resumed
  {
    const { deps, log } = fakeDeps({
      markers: [{ ok: true, value: T1 }],
      call: () => Promise.reject(new Error('boom')),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F8 rpc throws -> decided by the serialized check, queue resumed exactly once',
      out.kind === 'failed' && log.filter((s) => s === 'resume').length === 1 && log.includes('verify'),
      `${out.kind} ${log.join()}`,
    );
  }
  // F9 — refresh failure is its own outcome, after a completed delete
  {
    const { deps, log } = fakeDeps({ refreshOk: false });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F9 RPC ok but refresh failed -> done-refresh-failed (not failed), clear + sync still done',
      out.kind === 'done-refresh-failed' && log.includes('clear') && log.includes(`sync:${T1}`),
      `${out.kind} ${log.join()}`,
    );
  }
  // F10 — local purge failed: the marker must NOT be recorded (so the reset is re-detected later)
  {
    const { deps, log } = fakeDeps({ clearOk: false });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F10 RPC ok but local purge failed twice -> marker NOT synced, attempt NOT settled (the scope stays gated); still reported as deleted',
      out.kind === 'done' &&
        log.filter((s) => s === 'clear').length === 2 &&
        !log.some((s) => s.startsWith('sync:')) &&
        !log.includes('settle') &&
        log.includes('resume'),
      `${out.kind} ${log.join()}`,
    );
  }
  // F11 — duplicate tap: one RPC, the second call is refused untouched
  {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { deps, log } = fakeDeps({
      call: async () => {
        await gate;
        return { ok: true, resetAt: T1 };
      },
    });
    const run = createHouseholdResetRunner();
    const first = run(deps);
    await settle(2);
    const second = await run(deps);
    const third = await run(deps);
    release();
    const firstOut = await first;
    const again = await run(deps); // a NEW run is allowed once the first has finished
    check(
      'F11 taps while a run is in flight -> busy, exactly one RPC; a later run works again',
      second.kind === 'busy' &&
        third.kind === 'busy' &&
        firstOut.kind === 'done' &&
        again.kind === 'done' &&
        log.filter((s) => s === 'rpc').length === 2,
      `${second.kind}/${third.kind}/${firstOut.kind}/${again.kind} rpc=${log.filter((s) => s === 'rpc').length}`,
    );
  }
  // F12 — the refresh wait's predicate
  check(
    'F12 resetMarkerReached: old snapshot not yet, same / newer snapshot yes',
    !resetMarkerReached(null, T1) &&
      !resetMarkerReached(T1, T2) &&
      resetMarkerReached(T1, T1) &&
      resetMarkerReached(T2, T1) &&
      resetMarkerReached('2026-10-08T12:21:45.123456+09:00', T1),
    'ordering',
  );
  // F13 — the device marker cannot be armed: nothing is frozen, the RPC is never called
  {
    const { deps, log } = fakeDeps({ armOk: false });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F13 marker cannot be made durable -> storage outcome, no pause, no rpc',
      out.kind === 'storage' && log.join() === 'readMarker,arm:null',
      `${out.kind} ${log.join()}`,
    );
  }
  // F14 — this attempt did not commit, but the household WAS reset meanwhile (another device)
  {
    const { deps, log } = fakeDeps({
      markers: [{ ok: true, value: T1 }],
      call: () => Promise.resolve(NETWORK),
      verdict: () => Promise.resolve({ ok: true, committed: false, resetAt: null, marker: T2 }),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F14 not this attempt, but the marker moved past the baseline -> the queue is stale all the same: clear + sync(T2)',
      out.kind === 'done' && out.resetAt === T2 && log.includes('clear') && log.includes(`sync:${T2}`),
      `${JSON.stringify(out)} ${log.join()}`,
    );
  }
  // F15 — a THROWING check is "no answer", never "did not happen"
  {
    const { deps, log } = fakeDeps({
      markers: [{ ok: true, value: T1 }],
      call: () => Promise.resolve(NETWORK),
      verdict: () => Promise.reject(new Error('boom')),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F15 serialized check throws -> unconfirmed, not failed; nothing cleared, not settled, freeze still released',
      out.kind === 'unconfirmed' &&
        !log.includes('clear') &&
        !log.includes('settle') &&
        log[log.length - 1] === 'resume',
      `${out.kind} ${log.join()}`,
    );
  }
  // F16 — the purge fails once, then succeeds: the marker IS synced
  {
    const { deps, log } = fakeDeps({ clearOk: [false, true] });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F16 purge failed once, retry succeeded -> marker synced',
      out.kind === 'done' &&
        log.join() === `readMarker,arm:null,pause,rpc,clear,clear,sync:${T1},settle,resume,refresh:${T1}`,
      `${out.kind} ${log.join()}`,
    );
  }
  // F18..F20 — the RPC answers RESET_REQUEST_CLOSED: not a verdict, the serialized check decides
  {
    const CLOSED: ResetCallResult = { ok: false, code: 'RESET_REQUEST_CLOSED', definitive: false };
    const committed = fakeDeps({
      markers: [{ ok: true, value: T1 }],
      call: () => Promise.resolve(CLOSED),
      verdict: () => Promise.resolve({ ok: true, committed: true, resetAt: T2, marker: T2 }),
    });
    const a = await createHouseholdResetRunner()(committed.deps);
    check(
      'F18 CLOSED + check says committed (first delivery succeeded) -> the success path, exactly as a normal success',
      a.kind === 'done' &&
        a.resetAt === T2 &&
        committed.log.join() === `readMarker,arm:${T1},pause,rpc,verify,clear,sync:${T2},settle,resume,refresh:${T2}`,
      `${JSON.stringify(a)} ${committed.log.join()}`,
    );

    const closed = fakeDeps({ markers: [{ ok: true, value: T1 }], call: () => Promise.resolve(CLOSED) });
    const b = await createHouseholdResetRunner()(closed.deps);
    check(
      'F19 CLOSED + check says not committed -> definite failure: settled, resumed, nothing cleared',
      b.kind === 'failed' &&
        b.code === 'RESET_REQUEST_CLOSED' &&
        closed.log.join() === `readMarker,arm:${T1},pause,rpc,verify,settle,resume`,
      `${JSON.stringify(b)} ${closed.log.join()}`,
    );

    const unknown = fakeDeps({
      markers: [{ ok: true, value: T1 }],
      call: () => Promise.resolve(CLOSED),
      verdict: () => Promise.resolve({ ok: false }),
    });
    const c = await createHouseholdResetRunner()(unknown.deps);
    check(
      'F20 CLOSED + the check gets no answer -> unconfirmed: never "failed", attempt NOT settled',
      c.kind === 'unconfirmed' && unknown.log.join() === `readMarker,arm:${T1},pause,rpc,verify,resume`,
      `${c.kind} ${unknown.log.join()}`,
    );
  }
  // F17 — a THROWING marker sync never strands the freeze or the outcome
  {
    const { deps, log } = fakeDeps({ syncThrows: true });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F17 marker sync throws -> still done, queue resumed once, refresh still runs',
      out.kind === 'done' && log.filter((s) => s === 'resume').length === 1 && log.includes(`refresh:${T1}`),
      `${out.kind} ${log.join()}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}

/* ------------------------------------------------------------------ *
 * 4. The flow against the real coordinator + marker store
 * ------------------------------------------------------------------ */

const A: CoordinatorScope = { userId: 'u-A', householdId: 'h-A' };
const A2: CoordinatorScope = { userId: 'u-A', householdId: 'h-A2' };
const KEY_A = resetMarkerKey(A.userId, A.householdId);

const draft = (): NewTransactionDraft => ({
  type: 'expense',
  category: 'food',
  amount: 1000,
  memo: '',
  date: '2026-09-10T09:00:00.000Z',
});

function makeIntegration(initialMarkers: ResetMarkerMap | null, initialPending: ResetPendingMap | null = null) {
  let queueValue: string | null = null;
  let skipSets = 0;
  let failSets = 0;
  const storage = {
    getItem: () => Promise.resolve(queueValue),
    setItem: (_k: string, v: string) => {
      if (skipSets > 0) skipSets -= 1;
      else if (failSets > 0) {
        failSets -= 1;
        return Promise.reject(new Error('disk full'));
      }
      queueValue = v;
      return Promise.resolve();
    },
  };
  let scope: CoordinatorScope = A;
  let markerStored: unknown = initialMarkers;
  let pendingStored: unknown = initialPending;
  let failMarkerSave = false;
  let failPendingSave = false;
  const serverMarker: Record<string, string | null> = { 'h-A': null, 'h-A2': null };
  let online = false;
  let markerReadable = false;

  /**
   * The server side of migration 20261008002100, for household h-A: the
   * request ledger (committed / closed), and the household row lock the
   * serialized check has to wait on.
   */
  const requests = new Map<string, { committed: boolean; resetAt: string | null }>();
  let verdictReachable = true;
  let householdLock: Promise<void> | null = null;
  let verdictCalls = 0;
  /** the caller's role in h-A, as both RPCs check it */
  let role: 'owner' | 'member' = 'owner';
  /** the reset RPC's own checks, in the migration's order */
  const resetRpc = (
    requestId: string | null,
    at: string,
  ): 'ok' | 'INVALID_REQUEST_ID' | 'NOT_OWNER' | 'RESET_REQUEST_CLOSED' => {
    if (requestId == null || requestId.length < 8 || requestId.length > 64) return 'INVALID_REQUEST_ID';
    if (role !== 'owner') return 'NOT_OWNER';
    if (requests.has(requestId)) return 'RESET_REQUEST_CLOSED';
    requests.set(requestId, { committed: true, resetAt: at });
    serverMarker['h-A'] = at;
    return 'ok';
  };
  /** what the reset RPC does once it holds the lock; `false` = it deleted nothing */
  const commit = (requestId: string, at: string): boolean => resetRpc(requestId, at) === 'ok';
  const checkVerdict = async (householdId: string, requestId: string): Promise<ResetVerdictRead> => {
    verdictCalls += 1;
    if (!verdictReachable) return { ok: false };
    // NOT_OWNER: raised before the lock, nothing written; the service then
    // falls back to the plain marker read.
    if (role !== 'owner') return verdictAfterOwnerLoss({ ok: true, value: serverMarker[householdId] ?? null });
    if (householdLock) await householdLock; // FOR KEY SHARE behind the reset's FOR UPDATE
    if (!requests.has(requestId)) requests.set(requestId, { committed: false, resetAt: null });
    const row = requests.get(requestId) as { committed: boolean; resetAt: string | null };
    return { ok: true, committed: row.committed, resetAt: row.resetAt, marker: serverMarker[householdId] ?? null };
  };
  let lastRequestId = '';
  let requestSeq = 0;
  const createLog: string[] = [];
  const serverTxns = new Map<string, Transaction>();

  const coord = createPendingWriteCoordinator({
    storage: storage as unknown as QueueStorage,
    getScope: () => scope,
    getRemoteReady: () => true,
    getKnownCardIds: () => new Set<string>(),
    getServerTransactions: () => serverTxns,
    getServerCards: () => new Map(),
    getServerCategories: () => new Map(),
    getServerBudgets: () => new Map(),
    getServerPlanned: () => new Map(),
    getServerRecurring: () => new Map(),
    getServerGoals: () => new Map(),
    getServerLoans: () => new Map(),
    requestRefresh: () => Promise.resolve(),
    onChange: () => {},
    fetchResetMarker: (householdId) =>
      Promise.resolve(markerReadable ? { ok: true, value: serverMarker[householdId] ?? null } : { ok: false }),
    resetMarkers: createResetMarkerStore({
      load: () => Promise.resolve(markerStored),
      save: (m) => {
        if (failMarkerSave) return Promise.reject(new Error('disk full'));
        markerStored = JSON.parse(JSON.stringify(m)) as unknown;
        return Promise.resolve();
      },
    }),
    checkResetVerdict: checkVerdict,
    resetPending: createResetPendingStore({
      load: () => Promise.resolve(pendingStored),
      save: (p) => {
        if (failPendingSave) return Promise.reject(new Error('disk full'));
        pendingStored = JSON.parse(JSON.stringify(p)) as unknown;
        return Promise.resolve();
      },
    }),
    createTransaction: (args): Promise<CreateTransactionResult> => {
      const a = args as { id: string; draft: NewTransactionDraft };
      if (!online) return Promise.resolve({ ok: false, message: 'net', transport: true });
      createLog.push(a.id);
      serverTxns.set(a.id, { id: a.id, type: 'expense', category: 'food', amount: 1000, memo: '', date: a.draft.date });
      return Promise.resolve({ ok: true, id: a.id });
    },
    schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
    cancel: () => {},
  });

  /** the flow's deps, wired exactly like app/household-reset.tsx wires them */
  const flowDeps = (
    rpc: (ctx: { requestId: string }) => Promise<ResetCallResult>,
    over: Partial<HouseholdResetDeps> = {},
  ): HouseholdResetDeps => {
    let release: (() => void) | null = null;
    const requestId = `reset-test-${++requestSeq}`;
    lastRequestId = requestId;
    return {
      readMarker: () => Promise.resolve({ ok: true, value: serverMarker['h-A'] }),
      armMarker: (current) => coord.beginHouseholdReset(A.userId, A.householdId, requestId, current),
      verifyReset: () => checkVerdict(A.householdId, requestId),
      settle: () => coord.settleHouseholdReset(A.userId, A.householdId, requestId),
      pauseQueue: async () => {
        release = await coord.freezeQueue();
      },
      resumeQueue: () => release?.(),
      callReset: () => rpc({ requestId }),
      clearPending: () => coord.clearPendingForHousehold(A.userId, A.householdId),
      syncMarker: (resetAt) => coord.syncResetMarker(A.userId, A.householdId, resetAt),
      refresh: () => Promise.resolve(true),
      ...over,
    };
  };

  return {
    coord,
    createLog,
    serverMarker,
    flowDeps,
    queueDump: () => queueValue ?? '',
    markerOf: (key: string) => (markerStored as ResetMarkerMap | null)?.[key],
    pendingOf: (key: string) => (pendingStored as ResetPendingMap | null)?.[key],
    commit,
    resetRpc,
    checkVerdict,
    setRole: (r: 'owner' | 'member') => {
      role = r;
    },
    requestRow: (requestId: string) => requests.get(requestId),
    lastRequestId: () => lastRequestId,
    verdictCalls: () => verdictCalls,
    setVerdictReachable: (b: boolean) => {
      verdictReachable = b;
    },
    /** a reset holds the household row lock until the returned function is called */
    lockHousehold: () => {
      let unlock!: () => void;
      householdLock = new Promise<void>((r) => {
        unlock = r;
      });
      return () => {
        householdLock = null;
        unlock();
      };
    },
    failMarkerSave: (b: boolean) => {
      failMarkerSave = b;
    },
    failPendingSave: (b: boolean) => {
      failPendingSave = b;
    },
    goOnline: () => {
      online = true;
      markerReadable = true;
    },
    /** fail the next `n` durable queue writes, after letting `skip` succeed */
    failQueueWrites: (n: number, skip = 0) => {
      failSets = n;
      skipSets = skip;
    },
    setScope: (s: CoordinatorScope) => {
      scope = s;
      coord.setScope(s);
    },
    tryEnqueue: (entityId: string) =>
      coord.enqueueTransactionCreate({ scope: A, entityId, payload: draft() }),
    async seedOffline() {
      await coord.hydrate();
      await coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-old-1', payload: draft() });
      await coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-old-2', payload: draft() });
      await coord.enqueueTransactionCreate({ scope: A2, entityId: 'txn-other-household', payload: draft() });
      await settle();
    },
  };
}

export async function runHouseholdResetIntegrationCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const seen = (value: string | null): ResetMarkerMap => ({ [KEY_A]: { initialized: true, value } });

  // I1 — success: this household's queue is purged, the other household's is not, marker = reset_at,
  //      the queue is usable again, and the purged writes are never sent.
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    const out = await createHouseholdResetRunner()(
      h.flowDeps((c) => {
        h.commit(c.requestId, T1); // what the RPC does on the server
        return Promise.resolve({ ok: true, resetAt: T1 });
      }),
    );
    h.goOnline();
    const enq = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-new', payload: draft() });
    await settle(12);
    check(
      'I1 RPC success -> household queue cleared, other household kept, marker = reset_at',
      out.kind === 'done' &&
        !h.queueDump().includes('txn-old-1') &&
        !h.queueDump().includes('txn-old-2') &&
        h.queueDump().includes('txn-other-household') &&
        h.markerOf(KEY_A)?.value === T1,
      `${out.kind} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
    check(
      'I1b queue resumed afterwards: a new write is accepted and sent; the purged ones never are',
      enq.ok === true && h.createLog.join() === 'txn-new',
      `enq=${JSON.stringify(enq)} sent=${h.createLog.join()}`,
    );
  }

  // I2 — RPC refused: nothing purged, marker untouched, queue resumed and still holding the writes
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    const out = await createHouseholdResetRunner()(
      h.flowDeps(() => Promise.resolve({ ok: false, code: 'NOT_OWNER', definitive: true })),
    );
    const enq = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-after-fail', payload: draft() });
    check(
      'I2 RPC failed -> queue resumed (enqueue works), old writes kept, marker unchanged',
      out.kind === 'not-owner' &&
        enq.ok === true &&
        h.queueDump().includes('txn-old-1') &&
        h.queueDump().includes('txn-old-2') &&
        h.markerOf(KEY_A)?.value === null,
      `${out.kind} enq=${JSON.stringify(enq)} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // I3 — marker never initialized on this device: the queue is STILL purged (explicit clear), marker recorded
  {
    const h = makeIntegration(null);
    await h.seedOffline();
    const out = await createHouseholdResetRunner()(
      h.flowDeps(() => Promise.resolve({ ok: true, resetAt: T1 })),
    );
    check(
      'I3 uninitialized marker -> queue cleared anyway, marker recorded as reset_at',
      out.kind === 'done' && !h.queueDump().includes('txn-old-1') && h.markerOf(KEY_A)?.value === T1,
      `${out.kind} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // I4 — a second reset moves the marker forward again (T1 -> T2)
  {
    const h = makeIntegration(seen(T1));
    await h.seedOffline();
    const out = await createHouseholdResetRunner()(
      h.flowDeps(() => Promise.resolve({ ok: true, resetAt: T2 })),
    );
    check(
      'I4 marker T1, reset at T2 -> marker synced to the newest value',
      out.kind === 'done' && h.markerOf(KEY_A)?.value === T2 && !h.queueDump().includes('txn-old-1'),
      `${out.kind} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // I5 — while the RPC is in flight the queue refuses new writes; they are not lost silently
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    let during: { ok: boolean } = { ok: true };
    const out = await createHouseholdResetRunner()(
      h.flowDeps(async () => {
        during = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-during', payload: draft() });
        return { ok: true, resetAt: T1 };
      }),
    );
    check(
      'I5 enqueue during the RPC is refused (queue frozen), not silently accepted then wiped',
      out.kind === 'done' && during.ok === false && !h.queueDump().includes('txn-during'),
      `${out.kind} during=${JSON.stringify(during)}`,
    );
  }

  // I6 — the account-deletion queue controls still behave as before after a household reset
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    await createHouseholdResetRunner()(h.flowDeps(() => Promise.resolve({ ok: true, resetAt: T1 })));
    await h.coord.pauseForAccountDeletion();
    const frozen = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-frozen', payload: draft() });
    const cleared = await h.coord.clearPendingForAccount('u-A');
    check(
      'I6 account-delete pause / clearPendingForAccount unaffected: freezes, and still clears ALL the user\'s households',
      frozen.ok === false && cleared.ok === true && !h.queueDump().includes('txn-other-household'),
      `frozen=${JSON.stringify(frozen)} cleared=${JSON.stringify(cleared)}`,
    );
  }

  /* ---------- freeze ownership: reset vs account deletion ---------- */

  /** an RPC that stays in flight until `finish()` */
  const gatedRpc = (result: ResetCallResult) => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    return { rpc: () => gate.then(() => result), finish: () => finish() };
  };
  const OK_T1: ResetCallResult = { ok: true, resetAt: T1 };
  const NETWORK: ResetCallResult = { ok: false, code: 'NETWORK', definitive: false };

  // I7 — reset freezes first, account deletion pauses during it; the reset ending must not thaw the queue
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    const g = gatedRpc(OK_T1);
    const run = createHouseholdResetRunner()(h.flowDeps(g.rpc));
    await settle();
    await h.coord.pauseForAccountDeletion();
    g.finish();
    const out = await run;
    const afterReset = await h.tryEnqueue('txn-i7-a');
    h.coord.resumeAfterAccountDeletionFailure();
    const afterResume = await h.tryEnqueue('txn-i7-b');
    check(
      'I7 reset pause + account-delete pause: the reset finishing leaves the account-deletion freeze in place',
      out.kind === 'done' && afterReset.ok === false && afterResume.ok === true,
      `${out.kind} afterReset=${JSON.stringify(afterReset)} afterResume=${JSON.stringify(afterResume)}`,
    );
  }

  // I8 — account deletion pauses first, a reset runs start to finish under it
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    await h.coord.pauseForAccountDeletion();
    const out = await createHouseholdResetRunner()(h.flowDeps(() => Promise.resolve(OK_T1)));
    const afterReset = await h.tryEnqueue('txn-i8-a');
    h.coord.resumeAfterAccountDeletionFailure();
    const afterResume = await h.tryEnqueue('txn-i8-b');
    check(
      'I8 account-delete pause + reset pause: a whole reset under the account freeze does not thaw it',
      out.kind === 'done' &&
        afterReset.ok === false &&
        afterResume.ok === true &&
        !h.queueDump().includes('txn-old-1'),
      `${out.kind} afterReset=${JSON.stringify(afterReset)} afterResume=${JSON.stringify(afterResume)}`,
    );
  }

  // I9 — the account deletion FAILS (resumes) while the reset RPC is still in flight
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    const g = gatedRpc(OK_T1);
    const run = createHouseholdResetRunner()(h.flowDeps(g.rpc));
    await settle();
    await h.coord.pauseForAccountDeletion();
    h.coord.resumeAfterAccountDeletionFailure();
    const midReset = await h.tryEnqueue('txn-i9-a');
    g.finish();
    const out = await run;
    const afterReset = await h.tryEnqueue('txn-i9-b');
    check(
      'I9 account-delete resume during a reset does not thaw the reset freeze; the reset releases it itself',
      out.kind === 'done' && midReset.ok === false && afterReset.ok === true,
      `${out.kind} mid=${JSON.stringify(midReset)} after=${JSON.stringify(afterReset)}`,
    );
  }

  // I10 — a household switch during the reset neither thaws the queue nor is lost
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    const g = gatedRpc(OK_T1);
    const run = createHouseholdResetRunner()(h.flowDeps(g.rpc));
    await settle();
    h.setScope(A2);
    const midReset = await h.tryEnqueue('txn-i10-a');
    g.finish();
    const out = await run;
    await settle(); // the thaw's own flush halts offline; its retry is the (hand-driven) backoff timer
    h.goOnline();
    h.coord.requestFlush();
    await settle(12);
    check(
      'I10 scope change mid-reset: still frozen until the reset ends, then the live (other) household flushes normally',
      out.kind === 'done' && midReset.ok === false && h.createLog.join() === 'txn-other-household',
      `${out.kind} mid=${JSON.stringify(midReset)} sent=${h.createLog.join()}`,
    );
  }

  /* ---------- after the RPC committed: nothing deleted may be replayed ---------- */

  // I11 — purge fails (both attempts): marker stays old, and the first flush after the thaw
  //       re-detects the reset and purges BEFORE sending anything
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    h.goOnline();
    h.failQueueWrites(2);
    const out = await createHouseholdResetRunner()(
      h.flowDeps((c) => {
        h.commit(c.requestId, T1);
        return Promise.resolve(OK_T1);
      }),
    );
    const markerRightAfter = h.markerOf(KEY_A)?.value;
    await settle(20);
    check(
      'I11 RPC ok + purge failed -> marker not advanced; next flush purges first, old writes never sent',
      out.kind === 'done' &&
        markerRightAfter === null &&
        h.createLog.length === 0 &&
        !h.queueDump().includes('txn-old-1') &&
        h.queueDump().includes('txn-other-household') &&
        h.markerOf(KEY_A)?.value === T1,
      `${out.kind} markerAfter=${String(markerRightAfter)} sent=${h.createLog.join()} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // I12 — purge keeps failing: the old writes stay queued but are NEVER sent
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    h.goOnline();
    h.failQueueWrites(99);
    const out = await createHouseholdResetRunner()(
      h.flowDeps((c) => {
        h.commit(c.requestId, T1);
        return Promise.resolve(OK_T1);
      }),
    );
    await settle(20);
    h.coord.requestFlush();
    await settle(20);
    check(
      'I12 RPC ok + purge keeps failing -> records held, nothing sent across repeated flushes, marker still old',
      out.kind === 'done' &&
        h.createLog.length === 0 &&
        h.queueDump().includes('txn-old-1') &&
        h.markerOf(KEY_A)?.value === null,
      `${out.kind} sent=${h.createLog.join()} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // I13 — purge ok, marker sync fails (its own durable step): the old writes are already gone
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    h.goOnline();
    h.failQueueWrites(1, 1);
    const out = await createHouseholdResetRunner()(
      h.flowDeps((c) => {
        h.commit(c.requestId, T1);
        return Promise.resolve(OK_T1);
      }),
    );
    const markerRightAfter = h.markerOf(KEY_A)?.value;
    await settle(20);
    check(
      'I13 RPC ok + marker sync failed -> old writes purged and never sent; marker catches up on the next check',
      out.kind === 'done' &&
        markerRightAfter === null &&
        h.createLog.length === 0 &&
        !h.queueDump().includes('txn-old-1') &&
        !h.queueDump().includes('txn-old-2'),
      `${out.kind} markerAfter=${String(markerRightAfter)} sent=${h.createLog.join()}`,
    );
  }

  // I14 — refresh fails: its own outcome, with the queue already purged, the marker synced and the freeze lifted
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    const out = await createHouseholdResetRunner()(
      h.flowDeps(() => Promise.resolve(OK_T1), { refresh: () => Promise.resolve(false) }),
    );
    const enq = await h.tryEnqueue('txn-i14');
    check(
      'I14 refresh failed -> done-refresh-failed; queue purged, marker = reset_at, queue usable',
      out.kind === 'done-refresh-failed' &&
        !h.queueDump().includes('txn-old-1') &&
        h.markerOf(KEY_A)?.value === T1 &&
        enq.ok === true,
      `${out.kind} enq=${JSON.stringify(enq)} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  /* ---------- no verdict from the RPC: decided by the serialized check ---------- */

  // I15 — the reset is still RUNNING when its reply is lost: the check waits on the household
  //       lock, and only then reports T1 -> T2
  {
    const h = makeIntegration(seen(T1));
    h.serverMarker['h-A'] = T1;
    await h.seedOffline();
    const unlock = h.lockHousehold(); // the reset transaction holds the household row
    let finished = false;
    const run = createHouseholdResetRunner()(h.flowDeps(() => Promise.resolve(NETWORK))).then((o) => {
      finished = true;
      return o;
    });
    await settle(12);
    const waiting = !finished && h.verdictCalls() === 1;
    const mid = await h.tryEnqueue('txn-i15-mid');
    h.commit(h.lastRequestId(), T2); // ...and commits
    unlock();
    const out = await run;
    check(
      'I15 ambiguous, reset still in flight -> the check waits for the lock (queue frozen meanwhile), then T1 -> T2: success path',
      out.kind === 'done' &&
        out.resetAt === T2 &&
        waiting &&
        mid.ok === false &&
        !h.queueDump().includes('txn-old-1') &&
        h.markerOf(KEY_A)?.value === T2 &&
        h.pendingOf(KEY_A) === undefined,
      `${JSON.stringify(out)} waiting=${waiting} mid=${JSON.stringify(mid)} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // I16 — the reset never ran (or rolled back): the check answers T1 and closes the request
  {
    const h = makeIntegration(seen(T1));
    h.serverMarker['h-A'] = T1;
    await h.seedOffline();
    const out = await createHouseholdResetRunner()(h.flowDeps(() => Promise.resolve(NETWORK)));
    const enq = await h.tryEnqueue('txn-i16-after');
    const lateRan = h.commit(h.lastRequestId(), T2); // the lost request finally reaches the lock
    h.goOnline();
    h.coord.requestFlush();
    await settle(12);
    check(
      'I16 ambiguous, not committed -> failed + queue resumed at once; the late request is refused; the kept writes are sent normally',
      out.kind === 'failed' &&
        enq.ok === true &&
        lateRan === false &&
        h.serverMarker['h-A'] === T1 &&
        h.pendingOf(KEY_A) === undefined &&
        h.verdictCalls() === 1 &&
        h.createLog.join() === 'txn-old-1,txn-old-2,txn-i16-after',
      `${out.kind} enq=${JSON.stringify(enq)} late=${lateRan} checks=${h.verdictCalls()} sent=${h.createLog.join()}`,
    );
  }

  // I17 — the check itself gets no answer: unconfirmed. Everything works again EXCEPT sending this
  //       household's queue, which waits for the check — here the reset had committed.
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    h.setVerdictReachable(false);
    const out = await createHouseholdResetRunner()(h.flowDeps(() => Promise.resolve(NETWORK)));
    const enq = await h.tryEnqueue('txn-i17-new'); // the global freeze is gone
    await settle();
    h.goOnline(); // writes and the plain marker read work; the serialized check still does not
    h.coord.requestFlush();
    await settle(20);
    const sentWhileUnknown = h.createLog.length;
    const stillArmed = h.pendingOf(KEY_A)?.requestId === h.lastRequestId();
    h.setScope(A2); // another household is not held back
    await settle(12);
    const otherSent = h.createLog.join();
    h.setScope(A);
    await settle(12);
    const sentAfterReturn = h.createLog.length;
    h.commit(h.lastRequestId(), T1); // it had committed after all
    h.setVerdictReachable(true);
    h.coord.requestFlush();
    await settle(20);
    check(
      'I17 serialized check unreachable -> unconfirmed; this household is never sent while unknown (other household is), then purged unsent',
      out.kind === 'unconfirmed' &&
        enq.ok === true &&
        sentWhileUnknown === 0 &&
        stillArmed &&
        otherSent === 'txn-other-household' &&
        sentAfterReturn === 1 &&
        h.createLog.join() === 'txn-other-household' &&
        !h.queueDump().includes('txn-old-1') &&
        !h.queueDump().includes('txn-i17-new') &&
        h.markerOf(KEY_A)?.value === T1 &&
        h.pendingOf(KEY_A) === undefined,
      `${out.kind} enq=${JSON.stringify(enq)} unknownSent=${sentWhileUnknown} armed=${stillArmed} other=${otherSent} sent=${h.createLog.join()} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // I17b — same, but the check later says the reset never ran: the held writes are released and sent
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    h.setVerdictReachable(false);
    const out = await createHouseholdResetRunner()(h.flowDeps(() => Promise.resolve(NETWORK)));
    await settle();
    h.goOnline();
    h.coord.requestFlush();
    await settle(20);
    const held = h.createLog.length === 0 && h.queueDump().includes('txn-old-1');
    h.setVerdictReachable(true);
    h.coord.requestFlush();
    await settle(20);
    const lateRan = h.commit(h.lastRequestId(), T1);
    check(
      'I17b unconfirmed, then the check answers "not committed" -> no permanent hold: writes sent, attempt forgotten, request closed',
      out.kind === 'unconfirmed' &&
        held &&
        h.createLog.join() === 'txn-old-1,txn-old-2' &&
        h.pendingOf(KEY_A) === undefined &&
        lateRan === false,
      `${out.kind} held=${held} sent=${h.createLog.join()} late=${lateRan}`,
    );
  }

  // I17c — the app died mid-RPC: the attempt is on disk, and the first flush after the restart asks first
  {
    const h = makeIntegration(seen(null), { [KEY_A]: { requestId: 'reset-died-1' } });
    h.setVerdictReachable(false);
    await h.seedOffline();
    h.commit('reset-died-1', T1); // it had committed before the app died
    h.goOnline();
    h.coord.requestFlush();
    await settle(20);
    const heldWhileUnknown = h.createLog.length === 0 && h.queueDump().includes('txn-old-1');
    h.setVerdictReachable(true);
    h.coord.requestFlush();
    await settle(20);
    check(
      'I17c cold start with an unresolved attempt -> nothing sent before the check answers; committed -> purged unsent',
      heldWhileUnknown &&
        h.createLog.length === 0 &&
        !h.queueDump().includes('txn-old-1') &&
        h.queueDump().includes('txn-other-household') &&
        h.markerOf(KEY_A)?.value === T1 &&
        h.pendingOf(KEY_A) === undefined,
      `held=${heldWhileUnknown} sent=${h.createLog.join()} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  /* ---------- the durable arm before the RPC ---------- */

  // I17d — marker or attempt cannot be written: the reset is not started at all
  {
    const outcomes: string[] = [];
    let rpcCalls = 0;
    for (const which of ['marker', 'attempt'] as const) {
      const h = makeIntegration(seen(null));
      await h.seedOffline();
      if (which === 'marker') h.failMarkerSave(true);
      else h.failPendingSave(true);
      const out = await createHouseholdResetRunner()(
        h.flowDeps(() => {
          rpcCalls += 1;
          return Promise.resolve(OK_T1);
        }),
      );
      const enq = await h.tryEnqueue(`txn-i17d-${which}`);
      outcomes.push(`${out.kind}/${enq.ok}/${h.queueDump().includes('txn-old-1')}/${String(h.pendingOf(KEY_A))}`);
    }
    check(
      'I17d marker save or attempt save fails -> storage outcome, RPC never called, queue untouched and usable, nothing armed',
      rpcCalls === 0 && outcomes.every((o) => o === 'storage/true/true/undefined'),
      `rpc=${rpcCalls} ${outcomes.join(' ')}`,
    );
  }

  /* ---------- RESET_REQUEST_CLOSED: the same request id, asked about ---------- */

  const CLOSED: ResetCallResult = { ok: false, code: 'RESET_REQUEST_CLOSED', definitive: false };

  // I20a — the request was delivered twice: the first delivery committed, the reply that
  //        reached the device is the second one's CLOSED
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    let second = '';
    const out = await createHouseholdResetRunner()(
      h.flowDeps((c) => {
        h.commit(c.requestId, T1); // first delivery: deletes, commits
        second = h.resetRpc(c.requestId, T2); // duplicate delivery of the SAME id
        return Promise.resolve(CLOSED);
      }),
    );
    check(
      'I20a first delivery committed + duplicate CLOSED + check committed -> success; the duplicate deleted nothing (marker stays T1)',
      out.kind === 'done' &&
        out.resetAt === T1 &&
        second === 'RESET_REQUEST_CLOSED' &&
        h.serverMarker['h-A'] === T1 &&
        h.verdictCalls() === 1 &&
        !h.queueDump().includes('txn-old-1') &&
        h.markerOf(KEY_A)?.value === T1 &&
        h.pendingOf(KEY_A) === undefined,
      `${JSON.stringify(out)} second=${second} checks=${h.verdictCalls()} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // I20b — the request had been closed before it ran (an earlier check): CLOSED, and the check agrees
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    const out = await createHouseholdResetRunner()(
      h.flowDeps(async (c) => {
        await h.checkVerdict(A.householdId, c.requestId); // closes it first
        return CLOSED;
      }),
    );
    const enq = await h.tryEnqueue('txn-i20b');
    check(
      'I20b CLOSED + check not committed -> failed for certain: writes kept, queue resumed, attempt forgotten',
      out.kind === 'failed' &&
        enq.ok === true &&
        h.queueDump().includes('txn-old-1') &&
        h.serverMarker['h-A'] === null &&
        h.pendingOf(KEY_A) === undefined,
      `${JSON.stringify(out)} enq=${JSON.stringify(enq)}`,
    );
  }

  // I20c — CLOSED, and the check cannot be reached: unknown, so this household's queue is held
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    h.setVerdictReachable(false);
    const out = await createHouseholdResetRunner()(
      h.flowDeps((c) => {
        h.commit(c.requestId, T1);
        return Promise.resolve(CLOSED);
      }),
    );
    await settle();
    h.goOnline();
    h.coord.requestFlush();
    await settle(20);
    const held = h.createLog.length === 0 && h.pendingOf(KEY_A)?.requestId === h.lastRequestId();
    h.setVerdictReachable(true);
    h.coord.requestFlush();
    await settle(20);
    check(
      'I20c CLOSED + check unreachable -> unconfirmed, nothing sent while unknown; same request id asked again later -> purged unsent',
      out.kind === 'unconfirmed' &&
        held &&
        h.createLog.length === 0 &&
        !h.queueDump().includes('txn-old-1') &&
        h.markerOf(KEY_A)?.value === T1 &&
        h.pendingOf(KEY_A) === undefined,
      `${out.kind} held=${held} sent=${h.createLog.join()} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  /* ---------- server rules, as modelled by this harness (the SQL itself is not run here) ---------- */

  // I21 — a plain member cannot use the check: nothing is closed or written for them
  {
    const h = makeIntegration(seen(null));
    const id = 'reset-by-owner-0001';
    h.setRole('member');
    const refused = await h.checkVerdict(A.householdId, id);
    const rowAfterMember = h.requestRow(id);
    h.setRole('owner');
    const ownerReset = h.resetRpc(id, T1); // the owner's request is still runnable
    const ownerVerdict = await h.checkVerdict(A.householdId, id);
    check(
      'I21 member check refused (no row written, request NOT closed); owner check answers committed',
      refused.ok === true &&
        refused.committed === false &&
        rowAfterMember === undefined &&
        ownerReset === 'ok' &&
        ownerVerdict.ok === true &&
        ownerVerdict.committed === true &&
        ownerVerdict.resetAt === T1,
      `refused=${JSON.stringify(refused)} row=${JSON.stringify(rowAfterMember)} reset=${ownerReset} owner=${JSON.stringify(ownerVerdict)}`,
    );
  }

  // I22 — the reset needs a request id: none / malformed -> rejected before anything is deleted
  {
    const h = makeIntegration(seen(null));
    const results = [h.resetRpc(null, T1), h.resetRpc('', T1), h.resetRpc('short', T1), h.resetRpc('x'.repeat(65), T1)];
    check(
      'I22 reset without a (valid) request id -> INVALID_REQUEST_ID, marker untouched',
      results.every((r) => r === 'INVALID_REQUEST_ID') && h.serverMarker['h-A'] === null,
      results.join(),
    );
  }

  // I23 — ownership moved on while the attempt was unresolved: the check is refused, the plain
  //       marker decides, and the scope is never held forever
  {
    const done = makeIntegration(seen(null));
    await done.seedOffline();
    const a = await createHouseholdResetRunner()(
      done.flowDeps((c) => {
        done.commit(c.requestId, T1); // committed while still owner; reply lost
        done.setRole('member'); // ...then ownership was transferred
        return Promise.resolve(NETWORK);
      }),
    );
    const never = makeIntegration(seen(null));
    await never.seedOffline();
    const b = await createHouseholdResetRunner()(
      never.flowDeps(() => {
        never.setRole('member'); // transferred before the request ever ran
        return Promise.resolve(NETWORK);
      }),
    );
    const lateRan = never.commit(never.lastRequestId(), T1);
    check(
      'I23 ex-owner: committed-before-transfer -> success via the marker; never-ran -> failed, late request refused, no attempt left armed',
      a.kind === 'done' &&
        !done.queueDump().includes('txn-old-1') &&
        b.kind === 'failed' &&
        lateRan === false &&
        never.queueDump().includes('txn-old-1') &&
        never.pendingOf(KEY_A) === undefined &&
        done.pendingOf(KEY_A) === undefined,
      `${a.kind}/${b.kind} late=${lateRan}`,
    );
  }

  /* ---------- no screen / other households ---------- */

  // I18 — the screen is dismissed while the RPC is in flight: the run owns its cleanup
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    const g = gatedRpc(OK_T1);
    let mounted = true;
    const run = createHouseholdResetRunner()(
      // the screen's refresh wait gives up as soon as it is unmounted
      h.flowDeps(g.rpc, { refresh: () => Promise.resolve(!mounted) }),
    );
    await settle();
    mounted = false; // Android back: nothing of the screen is left to drive the run
    const midReset = await h.tryEnqueue('txn-i18-a');
    g.finish();
    const out = await run;
    const enq = await h.tryEnqueue('txn-i18-b');
    check(
      'I18 unmount mid-run -> the run still purges, records the marker and lifts its freeze',
      out.kind === 'done' &&
        midReset.ok === false &&
        enq.ok === true &&
        !h.queueDump().includes('txn-old-1') &&
        h.markerOf(KEY_A)?.value === T1,
      `${out.kind} mid=${JSON.stringify(midReset)} enq=${JSON.stringify(enq)}`,
    );
  }

  // I19 — another household's queue is neither purged nor blocked by the reset
  {
    const h = makeIntegration(seen(null));
    await h.seedOffline();
    const out = await createHouseholdResetRunner()(
      h.flowDeps((c) => {
        h.commit(c.requestId, T1);
        return Promise.resolve(OK_T1);
      }),
    );
    h.goOnline();
    h.setScope(A2);
    await settle(12);
    check(
      'I19 other household: its queued write survives the reset and is sent normally afterwards',
      out.kind === 'done' && h.createLog.join() === 'txn-other-household',
      `${out.kind} sent=${h.createLog.join()}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}

/* ------------------------------------------------------------------ *
 * 5. data_reset_at ordering under two concurrent resets — a MODEL of the
 *    SQL in 20261008002100, not the SQL itself (nothing here can reach a
 *    database). It pins down the arithmetic the migration relies on.
 * ------------------------------------------------------------------ */

/** `greatest(clock_timestamp(), coalesce(existing + 1us, clock_timestamp()))`, in microseconds. */
const nextResetAt = (existing: number | null, clock: number): number =>
  Math.max(clock, existing == null ? clock : existing + 1);

export function runHouseholdResetMarkerOrderCases(): { results: CaseResult[]; passed: number; failed: number } {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  // Reset A begins first (transaction start = 100) but gets the household lock SECOND;
  // reset B begins at 200 and gets it first. Each writes its marker while holding the lock.
  {
    const oldRule = { afterB: 200, afterA: 100 }; // v_reset_at := now() — the transaction START
    const afterB = nextResetAt(null, 250); // B's UPDATE runs at 250
    const afterA = nextResetAt(afterB, 300); // A's UPDATE runs later, at 300
    check(
      'O1 two concurrent resets, lock order opposite to start order -> the marker written last is the newest (the old rule went backwards)',
      afterA > afterB && oldRule.afterA < oldRule.afterB,
      `new: ${afterB} -> ${afterA}; old: ${oldRule.afterB} -> ${oldRule.afterA}`,
    );
  }
  check(
    'O2 server clock steps BACK between two resets -> still strictly newer than the stored marker',
    nextResetAt(500, 400) === 501,
    String(nextResetAt(500, 400)),
  );
  check(
    'O3 two resets inside the same microsecond -> distinct, increasing markers',
    nextResetAt(nextResetAt(null, 700), 700) === 701,
    String(nextResetAt(nextResetAt(null, 700), 700)),
  );
  check('O4 first reset ever (no stored marker) -> the clock value', nextResetAt(null, 42) === 42, String(nextResetAt(null, 42)));
  {
    let marker: number | null = null;
    const clocks = [10, 10, 9, 30, 30, 5, 31];
    const written = clocks.map((c) => (marker = nextResetAt(marker, c)));
    check(
      'O5 any sequence of serialized resets -> strictly increasing markers',
      written.every((v, i) => i === 0 || v > written[i - 1]),
      written.join(),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
