/**
 * Static verification for the STEP 16-G3-B1 refresh scheduler.
 *
 * No test framework in this repo (see splits.cases.ts / naturalInput.cases.ts)
 * — plain data + an async runner. `tsc --noEmit` type-checks this file; run
 * ad-hoc with node after a transpile. It drives the 9 AUDIT scenarios against
 * a controllable fake `fetchSnapshot` that records how many fetches ran and
 * the peak concurrency. Nothing here imports React or Supabase.
 */
import {
  createRefreshScheduler,
  shouldForegroundRefresh,
  type RefreshScope,
  type SnapshotOutcome,
} from '@/lib/remoteFinanceRefreshScheduler';

const A: RefreshScope = { userId: 'u-owner', householdId: 'h-A' };
const B: RefreshScope = { userId: 'u-owner', householdId: 'h-B' };
const PITCHER: RefreshScope = { userId: 'u-pitcher', householdId: 'h-A' };

type Out = SnapshotOutcome<string>;
const ok = (tag: string): Out => ({ ok: true, data: tag });
const dataOf = (o: Out | undefined): string | null => (o && o.ok ? o.data : null);

interface Pending {
  scope: RefreshScope;
  settle: (o: Out) => void;
  boom: () => void;
}

function makeHarness() {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const queue: Pending[] = [];
  const commits: { scopeKey: string; outcome: Out }[] = [];

  const scheduler = createRefreshScheduler<string>({
    fetchSnapshot: (scope) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Out>((resolve, reject) => {
        queue.push({
          scope,
          settle: (o) => {
            inFlight -= 1;
            resolve(o);
          },
          boom: () => {
            inFlight -= 1;
            reject(new Error('fetch exploded'));
          },
        });
      });
    },
    commit: (scope, outcome) => {
      commits.push({ scopeKey: `${scope.userId}:${scope.householdId}`, outcome });
    },
  });

  return {
    scheduler,
    commits,
    get calls() {
      return calls;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    get queued() {
      return queue.length;
    },
    settleNext(o: Out) {
      queue.shift()?.settle(o);
    },
    boomNext() {
      queue.shift()?.boom();
    },
  };
}

/** Let all pending microtasks (and the scheduler's drain loop) run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runSchedulerCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // CASE 1 — initial fetch -> ready
  {
    const h = makeHarness();
    h.scheduler.setScope(A);
    await flush();
    h.settleNext(ok('s1'));
    await flush();
    const last = h.commits[h.commits.length - 1];
    check(
      'CASE 1 initial fetch commits once as ready',
      h.calls === 1 && h.commits.length === 1 && dataOf(last?.outcome) === 's1',
      `calls=${h.calls} commits=${h.commits.length} last=${dataOf(last?.outcome)}`,
    );
  }

  // CASE 2 — refresh#2 during refresh#1: no parallel snapshot; trailing #2 wins
  {
    const h = makeHarness();
    h.scheduler.setScope(A);
    await flush();
    h.settleNext(ok('init'));
    await flush();
    const p1 = h.scheduler.request();
    await flush();
    const p2 = h.scheduler.request(); // while #1 is in flight
    await flush();
    h.settleNext(ok('r1'));
    await flush();
    h.settleNext(ok('r2')); // the single trailing fetch
    await Promise.all([p1, p2]);
    await flush();
    const last = h.commits[h.commits.length - 1];
    check(
      'CASE 2 coalesced trailing, no parallel fetch, newest result wins',
      h.maxInFlight === 1 && h.calls === 3 && dataOf(last?.outcome) === 'r2',
      `maxInFlight=${h.maxInFlight} calls=${h.calls} last=${dataOf(last?.outcome)}`,
    );
  }

  // CASE 3 — burst of 4 during one in-flight: coalesced to 1 trailing
  {
    const h = makeHarness();
    h.scheduler.setScope(A);
    await flush();
    h.settleNext(ok('init'));
    await flush();
    const ps = [
      h.scheduler.request(),
      h.scheduler.request(),
      h.scheduler.request(),
      h.scheduler.request(),
    ];
    await flush();
    h.settleNext(ok('r-first'));
    await flush();
    const trailingQueued = h.queued; // exactly one trailing fetch expected
    h.settleNext(ok('r-last'));
    await Promise.all(ps);
    await flush();
    check(
      'CASE 3 burst of 4 -> 1 in-flight + 1 trailing (not 4 parallel)',
      h.maxInFlight === 1 && h.calls === 3 && trailingQueued === 1 && h.queued === 0,
      `maxInFlight=${h.maxInFlight} calls=${h.calls} trailingQueued=${trailingQueued} queued=${h.queued}`,
    );
  }

  // CASE 4 — scope A in flight, switch to B: B fetch starts immediately, A discarded
  {
    const h = makeHarness();
    h.scheduler.setScope(A);
    await flush();
    const inFlightBeforeSwitch = h.queued; // A's initial fetch, unsettled
    h.scheduler.setScope(B);
    await flush();
    const callsAfterSwitch = h.calls; // B's fetch dispatched without waiting for A
    h.settleNext(ok('A-late')); // A's now-stale fetch
    await flush();
    h.settleNext(ok('B-fresh'));
    await flush();
    check(
      'CASE 4 scope switch: B fetch not blocked; A late result discarded',
      inFlightBeforeSwitch === 1 &&
        callsAfterSwitch === 2 &&
        h.commits.length === 1 &&
        h.commits[0].scopeKey === 'u-owner:h-B' &&
        dataOf(h.commits[0].outcome) === 'B-fresh',
      `inFlightBefore=${inFlightBeforeSwitch} callsAfterSwitch=${callsAfterSwitch} commits=${JSON.stringify(
        h.commits.map((c) => `${c.scopeKey}:${dataOf(c.outcome)}`),
      )}`,
    );
  }

  // CASE 5 — owner fetch in flight -> sign out -> pitcher: owner result never commits
  {
    const h = makeHarness();
    h.scheduler.setScope(A); // owner
    await flush();
    h.scheduler.setScope(null); // sign out
    await flush();
    h.scheduler.setScope(PITCHER); // different account
    await flush();
    h.settleNext(ok('owner-late')); // owner's orphaned fetch
    await flush();
    h.settleNext(ok('pitcher-fresh'));
    await flush();
    check(
      'CASE 5 account switch: stale owner response never commits to pitcher',
      h.commits.length === 1 &&
        h.commits[0].scopeKey === 'u-pitcher:h-A' &&
        dataOf(h.commits[0].outcome) === 'pitcher-fresh',
      `commits=${JSON.stringify(h.commits.map((c) => c.scopeKey))}`,
    );
  }

  // CASE 6 — request() (stand-in for the AppState foreground trigger) -> exactly one refresh
  {
    const h = makeHarness();
    h.scheduler.setScope(A);
    await flush();
    h.settleNext(ok('init'));
    await flush();
    const before = h.calls;
    const p = h.scheduler.request();
    await flush();
    h.settleNext(ok('fg'));
    await p;
    await flush();
    check(
      'CASE 6 foreground request -> exactly one authoritative refresh',
      h.calls === before + 1 && dataOf(h.commits[h.commits.length - 1]?.outcome) === 'fg',
      `calls ${before}->${h.calls}`,
    );
  }

  // CASE 7 — no spurious fetch without an explicit request (initial mount / active->active)
  {
    const h = makeHarness();
    h.scheduler.setScope(A);
    await flush();
    h.settleNext(ok('init'));
    await flush();
    await flush();
    await flush();
    check(
      'CASE 7 no extra fetch without an explicit request',
      h.calls === 1 && h.commits.length === 1,
      `calls=${h.calls} commits=${h.commits.length}`,
    );
  }

  // CASE 8 — current valid fetch throws: no crash, surfaces as an {ok:false} commit
  {
    const h = makeHarness();
    h.scheduler.setScope(A);
    await flush();
    h.boomNext(); // the initial fetch rejects
    await flush();
    const last = h.commits[h.commits.length - 1];
    check(
      'CASE 8 thrown fetch -> {ok:false} commit, no unhandled rejection',
      h.commits.length === 1 && last.outcome.ok === false,
      `commits=${h.commits.length} ok=${last?.outcome.ok}`,
    );
  }

  // CASE 9 — stale-scope fetch throws: must NOT pollute the current scope
  {
    const h = makeHarness();
    h.scheduler.setScope(A);
    await flush();
    h.scheduler.setScope(B);
    await flush();
    h.boomNext(); // A's orphaned fetch rejects
    await flush();
    h.settleNext(ok('B-ok')); // B resolves fine
    await flush();
    const errCommits = h.commits.filter((c) => c.outcome.ok === false);
    check(
      'CASE 9 stale-scope thrown fetch never commits an error',
      errCommits.length === 0 &&
        h.commits.length === 1 &&
        h.commits[0].scopeKey === 'u-owner:h-B',
      `errCommits=${errCommits.length} commits=${JSON.stringify(h.commits.map((c) => c.scopeKey))}`,
    );
  }

  // CASE 10 — STEP 16-G3-B3 §2/§10: the foreground-refresh predicate.
  // Only a real background/inactive -> active return with a live scope.
  {
    const uid = 'u-owner';
    const hid = 'h-A';
    const bgToActive = shouldForegroundRefresh({ prev: 'background', next: 'active', userId: uid, householdId: hid });
    const inactiveToActive = shouldForegroundRefresh({ prev: 'inactive', next: 'active', userId: uid, householdId: hid });
    const activeToActive = shouldForegroundRefresh({ prev: 'active', next: 'active', userId: uid, householdId: hid });
    const toBackground = shouldForegroundRefresh({ prev: 'active', next: 'background', userId: uid, householdId: hid });
    const noUser = shouldForegroundRefresh({ prev: 'background', next: 'active', userId: null, householdId: hid });
    const noHousehold = shouldForegroundRefresh({ prev: 'background', next: 'active', userId: uid, householdId: null });
    check(
      'CASE 10 foreground predicate: only bg/inactive->active with a live scope',
      bgToActive === true &&
        inactiveToActive === true &&
        activeToActive === false &&
        toBackground === false &&
        noUser === false &&
        noHousehold === false,
      `bg->active=${bgToActive} inactive->active=${inactiveToActive} active->active=${activeToActive} ->bg=${toBackground} noUser=${noUser} noHousehold=${noHousehold}`,
    );
  }

  // CASE 11 — STEP 16-G3-B3 §10 case 12: request() after dispose() is a
  // safe no-op — no fetch, and the returned promise still resolves (so a
  // late `await refresh()` from an unmounting screen can't hang).
  {
    const h = makeHarness();
    h.scheduler.setScope(A);
    await flush();
    h.settleNext(ok('init'));
    await flush();
    const before = h.calls;
    h.scheduler.dispose();
    const flags = { resolved: false };
    const p = h.scheduler.request().then(() => {
      flags.resolved = true;
    });
    await flush();
    await p;
    check(
      'CASE 11 request() after dispose -> no fetch, promise resolves',
      h.calls === before && flags.resolved,
      `calls ${before}->${h.calls} resolved=${flags.resolved}`,
    );
  }

  // CASE 12 — STEP 16-G3-B3 §10 case 8: a realtime reconnect catch-up and
  // an AppState foreground refresh landing together are just two request()s
  // — the scheduler coalesces them to one in-flight + one trailing, never
  // two parallel snapshots.
  {
    const h = makeHarness();
    h.scheduler.setScope(A);
    await flush();
    h.settleNext(ok('init'));
    await flush();
    const p1 = h.scheduler.request(); // e.g. realtime reconnect SUBSCRIBED
    const p2 = h.scheduler.request(); // e.g. AppState background->active
    await flush();
    h.settleNext(ok('r1'));
    await flush();
    h.settleNext(ok('r2'));
    await Promise.all([p1, p2]);
    await flush();
    const last = h.commits[h.commits.length - 1];
    check(
      'CASE 12 reconnect + foreground together -> coalesced, no parallel fetch',
      h.maxInFlight === 1 && h.calls === 3 && dataOf(last?.outcome) === 'r2',
      `maxInFlight=${h.maxInFlight} calls=${h.calls} last=${dataOf(last?.outcome)}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
