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

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
