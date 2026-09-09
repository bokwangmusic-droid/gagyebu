/**
 * Static verification for the STEP 16-G3-B2 finance-realtime PURE parts
 * (the table registry, the household filter, and the invalidation
 * debouncer). The `RealtimeChannel` transport itself is NOT mocked — see
 * splits.cases.ts for the "plain data + runner, no framework" convention.
 * `tsc --noEmit` type-checks this; run ad-hoc with node after a transpile.
 */
import {
  FINANCE_REALTIME_TABLES,
  REALTIME_INVALIDATION_DEBOUNCE_MS,
  createInvalidationDebouncer,
  createRealtimeReconnectTracker,
  householdFilter,
} from '@/services/remoteFinanceRealtime';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runRealtimeCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // CASE 1 — a single event -> exactly one invalidation
  {
    let flushes = 0;
    const d = createInvalidationDebouncer({ delayMs: 20, onFlush: () => (flushes += 1) });
    d.schedule();
    await wait(40);
    d.dispose();
    check('CASE 1 single event -> 1 invalidation', flushes === 1, `flushes=${flushes}`);
  }

  // CASE 2 — burst of 5 within the debounce window -> one invalidation
  {
    let flushes = 0;
    const d = createInvalidationDebouncer({ delayMs: 30, onFlush: () => (flushes += 1) });
    d.schedule();
    d.schedule();
    d.schedule();
    d.schedule();
    d.schedule();
    await wait(60);
    d.dispose();
    check('CASE 2 burst of 5 -> 1 invalidation (coalesced)', flushes === 1, `flushes=${flushes}`);
  }

  // CASE 3 — a new burst after the timer fired -> one more invalidation
  {
    let flushes = 0;
    const d = createInvalidationDebouncer({ delayMs: 20, onFlush: () => (flushes += 1) });
    d.schedule();
    await wait(40); // flush #1
    d.schedule();
    d.schedule();
    await wait(40); // flush #2
    d.dispose();
    check('CASE 3 burst -> flush -> new burst -> flush (2 total)', flushes === 2, `flushes=${flushes}`);
  }

  // CASE 4 — dispose() before the timer fires -> NO invalidation
  {
    let flushes = 0;
    const d = createInvalidationDebouncer({ delayMs: 30, onFlush: () => (flushes += 1) });
    d.schedule();
    d.schedule();
    d.dispose(); // cancel the pending flush
    await wait(60);
    check('CASE 4 dispose cancels the pending flush', flushes === 0, `flushes=${flushes}`);
  }

  // CASE 5 — schedule() after dispose() is a no-op
  {
    let flushes = 0;
    const d = createInvalidationDebouncer({ delayMs: 20, onFlush: () => (flushes += 1) });
    d.dispose();
    d.schedule();
    await wait(40);
    check('CASE 5 schedule after dispose -> no-op', flushes === 0, `flushes=${flushes}`);
  }

  // CASE 6 — every finance table name is unique and non-empty
  {
    const set = new Set(FINANCE_REALTIME_TABLES);
    const allNonEmpty = FINANCE_REALTIME_TABLES.every((t) => typeof t === 'string' && t.length > 0);
    check(
      'CASE 6 finance table registry: unique, non-empty',
      set.size === FINANCE_REALTIME_TABLES.length && allNonEmpty && set.size === 11,
      `count=${FINANCE_REALTIME_TABLES.length} unique=${set.size}`,
    );
  }

  // CASE 7 — householdFilter builds the exact PostgREST clause
  {
    const f = householdFilter('h-123');
    check(
      'CASE 7 householdFilter -> household_id=eq.<id>',
      f === 'household_id=eq.h-123',
      `got "${f}"`,
    );
  }

  // CASE 8 — registry excludes membership/identity tables (finance-only scope, §4)
  {
    const excluded = ['household_members', 'households', 'profiles', 'invites'];
    const leaked = excluded.filter((t) => (FINANCE_REALTIME_TABLES as readonly string[]).includes(t));
    check(
      'CASE 8 registry is finance-only (no membership/identity tables)',
      leaked.length === 0,
      `leaked=${JSON.stringify(leaked)}`,
    );
  }

  // CASE 9 — the exported debounce constant is a sane trailing window
  {
    check(
      'CASE 9 debounce window is 400ms',
      REALTIME_INVALIDATION_DEBOUNCE_MS === 400,
      `value=${REALTIME_INVALIDATION_DEBOUNCE_MS}`,
    );
  }

  // CASE 10 — STEP 16-G3-B3 §3: the very first SUBSCRIBED is
  // 'first-subscribed', never 'reconnected' (no reconnect-only refresh
  // fires on initial load; the B2 §15 catch-up still does, separately).
  {
    const t = createRealtimeReconnectTracker();
    const p1 = t.observe('SUBSCRIBED');
    check('CASE 10 first SUBSCRIBED -> first-subscribed', p1 === 'first-subscribed', `phase=${p1}`);
  }

  // CASE 11 — a repeated SUBSCRIBED with no disruption between is noise
  // (does not count as a reconnect, does not log).
  {
    const t = createRealtimeReconnectTracker();
    t.observe('SUBSCRIBED');
    const again = t.observe('SUBSCRIBED');
    check('CASE 11 repeated SUBSCRIBED (no disruption) -> noise', again === 'noise', `phase=${again}`);
  }

  // CASE 12 — SUBSCRIBED -> CHANNEL_ERROR -> SUBSCRIBED is exactly one
  // 'disrupted' then one 'reconnected'.
  {
    const t = createRealtimeReconnectTracker();
    t.observe('SUBSCRIBED');
    const d = t.observe('CHANNEL_ERROR');
    const r = t.observe('SUBSCRIBED');
    check(
      'CASE 12 SUBSCRIBED -> CHANNEL_ERROR -> SUBSCRIBED -> disrupted, reconnected',
      d === 'disrupted' && r === 'reconnected',
      `disrupt=${d} recon=${r}`,
    );
  }

  // CASE 13 — TIMED_OUT and CLOSED also count as a disruption, so the next
  // SUBSCRIBED is a reconnect.
  {
    const viaTimeout = createRealtimeReconnectTracker();
    viaTimeout.observe('SUBSCRIBED');
    viaTimeout.observe('TIMED_OUT');
    const rt = viaTimeout.observe('SUBSCRIBED');

    const viaClosed = createRealtimeReconnectTracker();
    viaClosed.observe('SUBSCRIBED');
    viaClosed.observe('CLOSED');
    const rc = viaClosed.observe('SUBSCRIBED');

    check(
      'CASE 13 TIMED_OUT / CLOSED before SUBSCRIBED -> reconnected',
      rt === 'reconnected' && rc === 'reconnected',
      `timeout=${rt} closed=${rc}`,
    );
  }

  // CASE 14 — STEP 16-G3-B3 §15: a flapping connection (many error
  // callbacks) yields a SINGLE 'disrupted' then a SINGLE 'reconnected' —
  // repeats are noise, so logs/refreshes can't be spammed.
  {
    const t = createRealtimeReconnectTracker();
    t.observe('SUBSCRIBED');
    const phases = [
      t.observe('CHANNEL_ERROR'),
      t.observe('CHANNEL_ERROR'),
      t.observe('TIMED_OUT'),
      t.observe('CHANNEL_ERROR'),
      t.observe('SUBSCRIBED'),
      t.observe('SUBSCRIBED'),
    ];
    const disrupted = phases.filter((p) => p === 'disrupted').length;
    const reconnected = phases.filter((p) => p === 'reconnected').length;
    check(
      'CASE 14 flapping connection -> exactly 1 disrupted + 1 reconnected',
      disrupted === 1 && reconnected === 1,
      `phases=${JSON.stringify(phases)}`,
    );
  }

  // CASE 15 — an error BEFORE the channel ever came up is not a reconnect
  // setup: the first successful SUBSCRIBED is still 'first-subscribed'.
  {
    const t = createRealtimeReconnectTracker();
    const pre = t.observe('CHANNEL_ERROR');
    const first = t.observe('SUBSCRIBED');
    check(
      'CASE 15 error before first SUBSCRIBED -> noise, then first-subscribed',
      pre === 'noise' && first === 'first-subscribed',
      `pre=${pre} first=${first}`,
    );
  }

  // CASE 16 — a second real reconnect later is detected again (the tracker
  // re-arms after each reconnect).
  {
    const t = createRealtimeReconnectTracker();
    t.observe('SUBSCRIBED');
    t.observe('CHANNEL_ERROR');
    const r1 = t.observe('SUBSCRIBED');
    t.observe('TIMED_OUT');
    const r2 = t.observe('SUBSCRIBED');
    check(
      'CASE 16 tracker re-arms: a later disruption -> another reconnected',
      r1 === 'reconnected' && r2 === 'reconnected',
      `r1=${r1} r2=${r2}`,
    );
  }

  // CASE 17 — integration of the two pure pieces the way
  // `subscribeHouseholdFinance` wires them: a status callback schedules an
  // invalidation only when the phase is NOT noise. First subscribe +
  // reconnect each yield one catch-up; a redundant repeat SUBSCRIBED and
  // every error callback yield none. Sequence:
  //   SUBSCRIBED, SUBSCRIBED, CHANNEL_ERROR, CHANNEL_ERROR, SUBSCRIBED
  //   -> catch-ups: first-subscribed + reconnected = 2 (never 3+).
  {
    const t = createRealtimeReconnectTracker();
    let flushes = 0;
    const d = createInvalidationDebouncer({ delayMs: 10, onFlush: () => (flushes += 1) });
    for (const s of ['SUBSCRIBED', 'SUBSCRIBED', 'CHANNEL_ERROR', 'CHANNEL_ERROR', 'SUBSCRIBED'] as const) {
      const phase = t.observe(s);
      if (s === 'SUBSCRIBED' && phase !== 'noise') d.schedule();
      await wait(20); // let each debounce window elapse independently
    }
    d.dispose();
    check(
      'CASE 17 tracker+debouncer: 1 catch-up per (first subscribe | reconnect), no more',
      flushes === 2,
      `flushes=${flushes}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
