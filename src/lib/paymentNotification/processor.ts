/**
 * 결제 알림 자동입력 — STEP 6. One pass over the captured notifications,
 * shared by every place that triggers it (app start / back to foreground in
 * src/components/PaymentNotificationAutoProcess.tsx, the 결제 알림 screen,
 * /input after a candidate's save):
 *   1. register the 후보함 candidates with the server dedup (serverDedup.ts);
 *   2. link the transactions already saved for an event and not linked yet
 *      (manual saves — also one made BEFORE the candidate was registered,
 *      with an ordinary id — and automatic ones), and store the result;
 *   3. only if no link failed on the network in step 2: with "확실한 카드
 *      결제 자동입력" on, save the eligible card payments (autoSave.ts),
 *      chosen from the state AFTER step 2, each one re-checking on the
 *      server that its event is still unhandled right before its insert.
 * A candidate with a manual save recorded (or opened in /input) is never
 * saved automatically on this phone, whatever its link state — pending,
 * lost reply, offline-queued: the fail-safe is to wait for the link.
 * Every state change is a read-modify-write of the STORED 후보함 state, so a
 * tap on the screen meanwhile is never lost.
 *
 * Single flight: a pass already running is joined, and one more pass is run
 * after it if anything asked meanwhile (with the latest context) — so a
 * burst of foreground changes is at most two passes. Two passes overlapping
 * anyway (another JS runtime) would still make one transaction per event
 * (the derived id). Never throws. Pure apart from the injected IO.
 */
import { toDateKey } from '@/lib/format';
import {
  applyPaymentAutoSaveOutcomes,
  runPaymentAutoSaveJobs,
  selectPaymentAutoSaveJobs,
  selectPaymentLinkJobs,
  type PaymentAutoSaveIO,
} from '@/lib/paymentNotification/autoSave';
import {
  buildPaymentInbox,
  markCandidateRegistered,
  type PaymentCandidateState,
} from '@/lib/paymentNotification/candidateInbox';
import { buildPaymentEventRegistrations, type PaymentEventRegistration } from '@/lib/paymentNotification/serverDedup';
import type { CapturedNotification } from '@/lib/paymentNotificationBuffer';

export interface PaymentProcessingContext {
  householdId: string;
  userId: string;
}

export interface PaymentProcessingIO {
  supported: () => boolean;
  getCaptured: () => Promise<CapturedNotification[]>;
  loadState: () => Promise<PaymentCandidateState>;
  /** Read-modify-write of the stored state; resolves to the stored result. */
  updateState: (change: (state: PaymentCandidateState) => PaymentCandidateState) => Promise<PaymentCandidateState>;
  register: (householdId: string, regs: readonly PaymentEventRegistration[]) => Promise<{ fingerprint: string; eventId: string }[]>;
  /** `null` = 자동입력 off. */
  loadAutoSaveSince: () => Promise<number | null>;
  autoSave: (ctx: PaymentProcessingContext) => PaymentAutoSaveIO;
  now: () => number;
}

export interface PaymentAutoSavedItem {
  fingerprint: string;
  merchant: string;
  amount: number;
}

export interface PaymentProcessingResult {
  /** The stored 후보함 state changed (a screen showing it should reload). */
  changed: boolean;
  /**
   * Transactions this pass INSERTED automatically — not link retries, not a
   * re-confirmed transaction that existed already. What the user is told.
   */
  saved: PaymentAutoSavedItem[];
}

const EMPTY = (): PaymentProcessingResult => ({ changed: false, saved: [] });

async function processOnce(ctx: PaymentProcessingContext, io: PaymentProcessingIO): Promise<PaymentProcessingResult> {
  if (!io.supported()) return EMPTY();
  const captured = await io.getCaptured();
  let state = await io.loadState();
  let changed = false;
  const now = io.now();
  const todayKey = toDateKey(new Date(now));
  let inbox = buildPaymentInbox(captured, state, todayKey);

  const regs = buildPaymentEventRegistrations(inbox.items, ctx.householdId, state);
  if (regs.length > 0) {
    const done = await io.register(ctx.householdId, regs);
    if (done.length > 0) {
      const at = io.now();
      state = await io.updateState((s) =>
        done.reduce((acc, d) => markCandidateRegistered(acc, d.fingerprint, ctx.householdId, at, d.eventId), s),
      );
      changed = true;
      inbox = buildPaymentInbox(captured, state, todayKey);
    }
  }

  const autoSave = io.autoSave(ctx);
  const links = selectPaymentLinkJobs(state, ctx.householdId);
  if (links.length > 0) {
    const linked = await runPaymentAutoSaveJobs(links, [], autoSave, now);
    if (linked.length > 0) {
      const at = io.now();
      state = await io.updateState((s) => applyPaymentAutoSaveOutcomes(s, linked, at));
      changed = true;
    }
    // A link that could not reach the server: an existing transaction may
    // still be unlinked — no new transaction in this pass at all.
    if (linked.length < links.length || linked.some((o) => o.kind === 'link' && o.result === 'retry')) {
      return { changed, saved: [] };
    }
    inbox = buildPaymentInbox(captured, state, todayKey);
  }

  const since = await io.loadAutoSaveSince();
  const saves = selectPaymentAutoSaveJobs(inbox.items, state, ctx.householdId, since, now);
  if (saves.length === 0) return { changed, saved: [] };
  const outcomes = await runPaymentAutoSaveJobs([], saves, autoSave, now);
  if (outcomes.length > 0) {
    const at = io.now();
    await io.updateState((s) => applyPaymentAutoSaveOutcomes(s, outcomes, at));
    changed = true;
  }
  const saved: PaymentAutoSavedItem[] = [];
  for (const o of outcomes) {
    if (o.kind !== 'saved' || !o.createdNow) continue;
    const c = saves.find((j) => j.item.fingerprint === o.fingerprint)?.item.candidate;
    saved.push({ fingerprint: o.fingerprint, merchant: c?.merchantCandidate ?? '', amount: c?.amount ?? 0 });
  }
  return { changed, saved };
}

/**
 * Registers ONE candidate right away (for /input, before it picks the id of a
 * save from it). `true` = registered in this household (now or before).
 * Never throws.
 */
async function registerOne(ctx: PaymentProcessingContext, fingerprint: string, io: PaymentProcessingIO): Promise<boolean> {
  try {
    if (!io.supported()) return false;
    const captured = await io.getCaptured();
    const state = await io.loadState();
    const entry = state[fingerprint];
    if (entry?.registeredHouseholdId === ctx.householdId && entry.registeredEventId) return true;
    const items = buildPaymentInbox(captured, state, toDateKey(new Date(io.now()))).items.filter(
      (i) => i.fingerprint === fingerprint,
    );
    const regs = buildPaymentEventRegistrations(items, ctx.householdId, state);
    if (regs.length === 0) return false;
    const done = await io.register(ctx.householdId, regs);
    if (done.length === 0) return false;
    const at = io.now();
    await io.updateState((s) =>
      done.reduce((acc, d) => markCandidateRegistered(acc, d.fingerprint, ctx.householdId, at, d.eventId), s),
    );
    return true;
  } catch {
    return false;
  }
}

export interface PaymentNotificationProcessor {
  run: (ctx: PaymentProcessingContext) => Promise<PaymentProcessingResult>;
  registerCandidate: (ctx: PaymentProcessingContext, fingerprint: string) => Promise<boolean>;
  /**
   * Called once per pass that INSERTED something new (`saved` above) — and,
   * as a second guard, each candidate at most once per app run. Returns an
   * unsubscribe.
   */
  onSaved: (listener: (saved: PaymentAutoSavedItem[]) => void) => () => void;
}

export function createPaymentNotificationProcessor(io: PaymentProcessingIO): PaymentNotificationProcessor {
  let inFlight: Promise<PaymentProcessingResult> | null = null;
  let again = false;
  let latest: PaymentProcessingContext | null = null;
  const listeners = new Set<(saved: PaymentAutoSavedItem[]) => void>();
  const announced = new Set<string>();

  const run = (ctx: PaymentProcessingContext): Promise<PaymentProcessingResult> => {
    latest = ctx;
    if (inFlight) {
      again = true;
      return inFlight;
    }
    const pass = (async () => {
      const total = EMPTY();
      do {
        again = false;
        const current = latest;
        if (!current) break;
        try {
          const r = await processOnce(current, io);
          total.changed = total.changed || r.changed;
          total.saved.push(...r.saved);
        } catch {
          // A failed pass changes nothing it did not already store.
        }
      } while (again);
      const fresh = total.saved.filter((s) => !announced.has(s.fingerprint));
      fresh.forEach((s) => announced.add(s.fingerprint));
      if (fresh.length > 0) {
        for (const l of listeners) {
          try {
            l(fresh);
          } catch {
            // A listener's failure is its own.
          }
        }
      }
      return total;
    })();
    inFlight = pass.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    run,
    registerCandidate: (ctx, fingerprint) => registerOne(ctx, fingerprint, io),
    onSaved: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
