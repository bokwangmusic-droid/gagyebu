/**
 * 결제 알림 자동입력 — STEP 6. Wiring for "확실한 카드 결제 자동입력"
 * (src/lib/paymentNotification/autoSave.ts): the device-local setting and
 * the three server calls — the ordinary createTransaction (no other insert
 * path) and the two event RPCs of migration 20261019002300.
 *
 * Never throws. Offline / any failure leaves the candidate in the 후보함;
 * nothing goes into the offline write queue — a transaction is created only
 * right after the server dedup answered for this event.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import type {
  PaymentAutoSaveIO,
  PaymentEventCompleteResult,
  PaymentEventLinkResult,
  PaymentLinkSource,
} from '@/lib/paymentNotification/autoSave';
import {
  matchPaymentTransactionRow,
  queuedTransactionLiveness,
  type ExistingPaymentIO,
  type PaymentCandidateExpected,
  type PaymentTransactionLiveness,
  type PaymentTransactionMatch,
  type QueuedTransactionOp,
} from '@/lib/paymentNotification/existingPayment';
import { loadItem, saveItem } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { isTransportError } from '@/lib/transportError';
import { createTransaction } from '@/services/remoteFinanceWrite';

const SETTING_KEY = 'paymentNotificationAutoSave.v1';

/**
 * `null` = off (the default: nothing stored, or anything but a valid "on").
 * When on: the epoch ms it was turned on — only notifications from then on
 * are saved automatically.
 */
export async function loadPaymentAutoSaveSince(): Promise<number | null> {
  const raw = await loadItem<unknown>(SETTING_KEY, null);
  if (raw == null || typeof raw !== 'object') return null;
  const since = (raw as { enabledSince?: unknown }).enabledSince;
  return typeof since === 'number' && Number.isFinite(since) && since > 0 ? since : null;
}

/** Returns the stored value (`null` = off). */
export async function savePaymentAutoSaveEnabled(enabled: boolean, now: number): Promise<number | null> {
  await saveItem(SETTING_KEY, enabled ? { enabledSince: now } : { enabledSince: null });
  return loadPaymentAutoSaveSince();
}

const COMPLETE_STATUSES = new Set([
  'linked',
  'already_linked',
  'conflict',
  'transaction_missing',
  'transaction_mismatch',
  'transaction_in_use',
]);

async function getLink(householdId: string, eventId: string): Promise<PaymentEventLinkResult> {
  try {
    const { data, error } = await supabase.rpc('get_payment_notification_event_link', {
      p_household_id: householdId,
      p_event_id: eventId,
    });
    if (error) return { ok: false, transport: isTransportError(error as PostgrestError) };
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
    if (!row || (row.event_status !== 'pending' && row.event_status !== 'handled')) {
      return { ok: false, transport: false };
    }
    const linked = typeof row.linked_transaction_id === 'string' ? row.linked_transaction_id : null;
    return { ok: true, status: row.event_status, transactionId: linked };
  } catch (e) {
    return { ok: false, transport: isTransportError(e) };
  }
}

async function complete(
  householdId: string,
  eventId: string,
  transactionId: string,
  source: PaymentLinkSource,
): Promise<PaymentEventCompleteResult> {
  try {
    const { data, error } = await supabase.rpc('complete_payment_notification_event', {
      p_household_id: householdId,
      p_event_id: eventId,
      p_transaction_id: transactionId,
      p_source: source,
    });
    if (error) return { ok: false, transport: isTransportError(error as PostgrestError) };
    if (typeof data !== 'string' || !COMPLETE_STATUSES.has(data)) return { ok: false, transport: false };
    return { ok: true, status: data as Extract<PaymentEventCompleteResult, { ok: true }>['status'] };
  } catch (e) {
    return { ok: false, transport: isTransportError(e) };
  }
}

/** The server calls for the signed-in user in the active household. */
export function paymentAutoSaveIO(args: { householdId: string; userId: string }): PaymentAutoSaveIO {
  return {
    getLink: (eventId) => getLink(args.householdId, eventId),
    create: async (transactionId, draft) => {
      try {
        const res = await createTransaction({
          id: transactionId,
          householdId: args.householdId,
          expectedUserId: args.userId,
          draft,
          // No card is ever set on an automatic save.
          knownCardIds: new Set<string>(),
        });
        // `reconciled`: the same request had landed before — nothing new.
        return res.ok ? { ok: true, createdNow: res.reconciled !== true } : { ok: false, transport: res.transport === true };
      } catch (e) {
        return { ok: false, transport: isTransportError(e) };
      }
    },
    complete: (eventId, transactionId, source) => complete(args.householdId, eventId, transactionId, source),
  };
}

/**
 * Is this transaction alive in this household? Members may read the
 * household's rows, soft-deleted ones included (transactions_select), so a
 * deleted row reads as `deleted`; a row of another household / a reset one
 * as `missing`. Any read failure is `unknown`. Never throws.
 * Without a signed-in session the read runs as anon and RLS answers an
 * empty result, not an error — that is `unknown`, never `missing`.
 */
export async function paymentTransactionLiveness(
  householdId: string,
  transactionId: string,
): Promise<PaymentTransactionLiveness> {
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session?.user?.id) return 'unknown';
    const { data, error } = await supabase
      .from('transactions')
      .select('id,deleted_at')
      .eq('household_id', householdId)
      .eq('id', transactionId)
      .maybeSingle();
    if (error) return 'unknown';
    if (!data) return 'missing';
    return (data as { deleted_at: string | null }).deleted_at == null ? 'live' : 'deleted';
  } catch {
    return 'unknown';
  }
}

/**
 * The candidate's own record against the candidate (existingPayment.ts
 * matchPaymentTransactionRow): this household's row only, amount / type
 * compared, the memo never. Read only — the row is never changed. No session
 * / any read failure is `unknown`, as for paymentTransactionLiveness.
 * Never throws.
 */
export async function paymentTransactionMatch(
  householdId: string,
  transactionId: string,
  expected: PaymentCandidateExpected,
): Promise<PaymentTransactionMatch> {
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session?.user?.id) return { state: 'unknown' };
    const { data, error } = await supabase
      .from('transactions')
      .select('id,household_id,amount,type,deleted_at')
      .eq('household_id', householdId)
      .eq('id', transactionId)
      .maybeSingle();
    if (error) return { state: 'unknown' };
    const row = data as { household_id: string; amount: unknown; type: unknown; deleted_at: unknown } | null;
    return matchPaymentTransactionRow(row && row.household_id === householdId ? row : null, expected);
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * /input's "already in the ledger?" check (existingPayment.ts).
 * `queuedOp`: this device's offline-queue op for the id — a queued create
 * is alive and a pending delete is deleted before the server is asked
 * (queuedTransactionLiveness).
 */
export function existingPaymentIO(
  householdId: string,
  queuedOp: (transactionId: string) => QueuedTransactionOp | null,
): ExistingPaymentIO {
  return {
    queued: queuedOp,
    getLink: (eventId) => getLink(householdId, eventId),
    liveness: (transactionId) => {
      const queued = queuedTransactionLiveness(queuedOp(transactionId));
      return queued ? Promise.resolve(queued) : paymentTransactionLiveness(householdId, transactionId);
    },
    match: (transactionId, expected) => paymentTransactionMatch(householdId, transactionId, expected),
    confirm: (eventId, transactionId) => confirmPaymentEventTransaction(householdId, eventId, transactionId),
  };
}

/**
 * /input, after its insert with the derived id was refused: does the event
 * already have that transaction (saved first elsewhere)? Links it if not yet
 * linked. `'exists'` = it does — nothing must be saved again.
 */
export async function confirmPaymentEventTransaction(
  householdId: string,
  eventId: string,
  transactionId: string,
): Promise<'exists' | 'missing' | 'unknown'> {
  const res = await complete(householdId, eventId, transactionId, 'manual');
  if (!res.ok) return 'unknown';
  if (res.status === 'linked' || res.status === 'already_linked') return 'exists';
  return res.status === 'transaction_missing' ? 'missing' : 'unknown';
}
