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
  resetMarkerKey,
  resetMarkerReached,
  type ResetMarkerMap,
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
  parseHouseholdResetResult,
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

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}

/* ------------------------------------------------------------------ *
 * 3. Step order, with every dependency faked
 * ------------------------------------------------------------------ */

function fakeDeps(over: {
  markers?: ResetMarkerRead[];
  call?: () => Promise<ResetCallResult>;
  clearOk?: boolean;
  refreshOk?: boolean;
}) {
  const log: string[] = [];
  const markers = [...(over.markers ?? [{ ok: true, value: null } as ResetMarkerRead])];
  const deps: HouseholdResetDeps = {
    readMarker: () => {
      log.push('readMarker');
      return Promise.resolve(markers.length > 1 ? (markers.shift() as ResetMarkerRead) : markers[0]);
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
      return Promise.resolve({ ok: over.clearOk ?? true });
    },
    syncMarker: (resetAt) => {
      log.push(`sync:${resetAt}`);
      return Promise.resolve();
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

  // F1 — success: exact step order
  {
    const { deps, log } = fakeDeps({});
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F1 success order: readMarker -> pause -> rpc -> clear -> sync(marker) -> resume -> refresh',
      out.kind === 'done' &&
        log.join() === `readMarker,pause,rpc,clear,sync:${T1},resume,refresh:${T1}`,
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
      'F3 RPC failed (definitive) -> queue resumed; nothing cleared, no marker, no refresh, not a success',
      out.kind === 'failed' && log.join() === 'readMarker,pause,rpc,resume',
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
      out.kind === 'not-owner' && log.join() === 'readMarker,pause,rpc,resume',
      `${out.kind} ${log.join()}`,
    );
  }
  // F5 — no verdict, but the marker moved forward: it DID commit -> handled as success
  {
    const { deps, log } = fakeDeps({
      markers: [
        { ok: true, value: T1 },
        { ok: true, value: T2 },
      ],
      call: () => Promise.resolve({ ok: false, code: 'NETWORK', definitive: false }),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F5 transport error but server marker advanced T1 -> T2 -> treated as committed: clear + sync(T2) + refresh',
      out.kind === 'done' &&
        out.resetAt === T2 &&
        log.join() === `readMarker,pause,rpc,readMarker,clear,sync:${T2},resume,refresh:${T2}`,
      `${JSON.stringify(out)} ${log.join()}`,
    );
  }
  // F6 — no verdict, marker unchanged: nothing was deleted
  {
    const { deps, log } = fakeDeps({
      markers: [{ ok: true, value: T1 }],
      call: () => Promise.resolve({ ok: false, code: 'NETWORK', definitive: false }),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F6 transport error and marker unchanged -> failed (data intact), nothing cleared',
      out.kind === 'failed' && log.join() === 'readMarker,pause,rpc,readMarker,resume',
      `${out.kind} ${log.join()}`,
    );
  }
  // F7 — no verdict and the check itself fails: unconfirmed, never "data intact", never success
  {
    const { deps, log } = fakeDeps({
      markers: [{ ok: true, value: T1 }, { ok: false }],
      call: () => Promise.resolve({ ok: false, code: 'NETWORK', definitive: false }),
    });
    const out = await createHouseholdResetRunner()(deps);
    check(
      'F7 transport error and marker unreadable -> unconfirmed; queue resumed, nothing cleared',
      out.kind === 'unconfirmed' && log.join() === 'readMarker,pause,rpc,readMarker,resume',
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
      'F8 rpc throws -> verified against the marker, queue resumed exactly once',
      out.kind === 'failed' && log.filter((s) => s === 'resume').length === 1 && log.includes('readMarker'),
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
      'F10 RPC ok but local purge failed -> marker NOT synced; still reported as deleted',
      out.kind === 'done' && log.includes('clear') && !log.some((s) => s.startsWith('sync:')) && log.includes('resume'),
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

function makeIntegration(initialMarkers: ResetMarkerMap | null) {
  let queueValue: string | null = null;
  const storage = {
    getItem: () => Promise.resolve(queueValue),
    setItem: (_k: string, v: string) => {
      queueValue = v;
      return Promise.resolve();
    },
  };
  let markerStored: unknown = initialMarkers;
  const serverMarker: Record<string, string | null> = { 'h-A': null, 'h-A2': null };
  let online = false;
  let markerReadable = false;
  const createLog: string[] = [];
  const serverTxns = new Map<string, Transaction>();

  const coord = createPendingWriteCoordinator({
    storage: storage as unknown as QueueStorage,
    getScope: () => A,
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
        markerStored = JSON.parse(JSON.stringify(m)) as unknown;
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
  const flowDeps = (rpc: () => Promise<ResetCallResult>): HouseholdResetDeps => ({
    readMarker: () => Promise.resolve({ ok: true, value: serverMarker['h-A'] }),
    pauseQueue: coord.pauseForAccountDeletion,
    resumeQueue: coord.resumeAfterAccountDeletionFailure,
    callReset: rpc,
    clearPending: () => coord.clearPendingForHousehold(A.userId, A.householdId),
    syncMarker: (resetAt) => coord.syncResetMarker(A.userId, A.householdId, resetAt),
    refresh: () => Promise.resolve(true),
  });

  return {
    coord,
    createLog,
    serverMarker,
    flowDeps,
    queueDump: () => queueValue ?? '',
    markerOf: (key: string) => (markerStored as ResetMarkerMap | null)?.[key],
    goOnline: () => {
      online = true;
      markerReadable = true;
    },
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
      h.flowDeps(() => {
        h.serverMarker['h-A'] = T1; // what the RPC does on the server
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

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
