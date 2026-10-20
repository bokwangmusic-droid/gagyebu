/**
 * 결제 알림 후보함 → /input: is this candidate's payment ALREADY in the
 * ledger? Decided on the transaction itself, never on the server event's
 * status alone.
 *
 * A server event stays 'handled' for good (migration 20261019002300): its
 * transaction may have been soft-deleted since (the user, 카드 결제 취소
 * refundMatch.ts) or be gone altogether (household reset), and it may be an
 * ordinary id rather than the derived 'txn-pn-<event id>'. So:
 *   1. the transaction this candidate recorded itself (manualTxnId) comes
 *      first — after a re-entry the event still points at the old, deleted
 *      one, and the new one must not be created a second time;
 *   2. then the event's LINKED transaction id (get_payment_notification_
 *      event_link's linked_transaction_id), never an id derived here;
 *   3. a transaction counts only when it is alive: in this household,
 *      deleted_at null (or still waiting in the offline queue as a create).
 * Verdicts:
 *   new      nothing saved for it — save as usual (derived id, link).
 *   exists   alive → nothing is saved; 처리 완료 recorded with THAT id.
 *   stale    saved before but deleted / gone → the user decides; a re-entry
 *            gets a NEW ordinary id (the deleted row may still hold the
 *            derived one) and is not linked to a handled event.
 *   unknown  could not be checked → nothing is saved, nothing is recorded.
 * The automatic save (autoSave.ts) is not affected: a handled event is never
 * saved again there. Pure apart from the injected IO; never throws.
 */
import type { PaymentEventLinkResult } from '@/lib/paymentNotification/autoSave';
import type { ManualLinkState } from '@/lib/paymentNotification/candidateInbox';

/** `missing` = no such row in this household; `unknown` = could not be read. */
export type PaymentTransactionLiveness = 'live' | 'deleted' | 'missing' | 'unknown';

/** This device's offline-queue op for the transaction (usePendingWrites; ≤1 per id). */
export interface QueuedTransactionOp {
  op: 'create' | 'update' | 'delete';
  /** Terminal failure, held for a manual retry (failedTransactionIds). */
  failed: boolean;
}

/**
 * What the offline queue says before the server is asked — the ledger's own
 * rule (composeFinance, src/lib/offlineQueue.ts), so "already in the ledger"
 * means what the user sees there:
 *   - a CREATE (pending or held after a terminal failure) keeps its synthetic
 *     row: alive, though not on the server yet;
 *   - a pending DELETE hides the row: deleted, whatever the server row says
 *     until the flush lands;
 *   - a terminal-failed DELETE keeps the server row visible ("삭제 전송
 *     실패"), an UPDATE changes no existence, no op = flushed / never queued:
 *     `null` — the server row decides.
 */
export function queuedTransactionLiveness(queued: QueuedTransactionOp | null): PaymentTransactionLiveness | null {
  if (!queued) return null;
  if (queued.op === 'create') return 'live';
  if (queued.op === 'delete' && !queued.failed) return 'deleted';
  return null;
}

export interface ExistingPaymentIO {
  getLink: (eventId: string) => Promise<PaymentEventLinkResult>;
  liveness: (transactionId: string) => Promise<PaymentTransactionLiveness>;
  /** complete_payment_notification_event(…, 'manual') — confirmPaymentEventTransaction. */
  confirm: (eventId: string, transactionId: string) => Promise<'exists' | 'missing' | 'unknown'>;
}

export type ExistingPaymentVerdict =
  | { kind: 'new' }
  /** `link` null = keep the candidate's own record as it is. */
  | { kind: 'exists'; transactionId: string; link: ManualLinkState | null }
  | { kind: 'stale'; link: ManualLinkState }
  | { kind: 'unknown' };

export const EXISTING_PAYMENT_MESSAGE = {
  exists: '이미 가계부에 입력된 결제예요',
  unknown: '기존 거래 확인이 필요해요. 인터넷 연결 후 다시 시도해 주세요.',
  staleTitle: '다시 입력할까요?',
  staleBody: '이 결제는 이전에 가계부에 입력됐지만 현재 거래가 삭제되어 있어요. 다시 입력할까요?',
} as const;

/**
 * Before the insert. `manualTxnId`: the candidate's own record in THIS
 * household; `eventId`: its registered server event in this household.
 */
export async function checkExistingPayment(
  known: { manualTxnId: string | null; eventId: string | null },
  io: ExistingPaymentIO,
): Promise<ExistingPaymentVerdict> {
  try {
    let savedBefore = false;
    if (known.manualTxnId) {
      const own = await io.liveness(known.manualTxnId);
      if (own === 'live') return { kind: 'exists', transactionId: known.manualTxnId, link: null };
      if (own === 'unknown') return { kind: 'unknown' };
      savedBefore = true;
    }
    if (!known.eventId) return savedBefore ? { kind: 'stale', link: 'never' } : { kind: 'new' };

    const link = await io.getLink(known.eventId);
    // Not readable: as before, a first save goes on (the insert itself is
    // the dedup) — but a candidate saved before is not re-entered blind.
    if (!link.ok) return savedBefore ? { kind: 'unknown' } : { kind: 'new' };
    // Pending: nothing linked. A re-entry may still be linked to it.
    if (link.status === 'pending') return savedBefore ? { kind: 'stale', link: 'pending' } : { kind: 'new' };

    const linked = link.transactionId;
    if (!linked) return { kind: 'stale', link: 'never' };
    if (linked === known.manualTxnId) return { kind: 'stale', link: 'never' };
    const state = await io.liveness(linked);
    if (state === 'live') return { kind: 'exists', transactionId: linked, link: 'linked' };
    if (state === 'unknown') return { kind: 'unknown' };
    return { kind: 'stale', link: 'never' };
  } catch {
    return { kind: 'unknown' };
  }
}

export type RefusedInsertVerdict = Exclude<ExistingPaymentVerdict, { kind: 'new' }> | { kind: 'failed' };

/**
 * After the insert with the derived id was refused (not a transport
 * failure): the derived id's row itself decides.
 *   live     the event's transaction — saved first elsewhere: exists (linked
 *            now if it can be; otherwise the link is retried later).
 *   deleted  it holds the id but was deleted: stale (a re-entry gets a new
 *            id). The event is never linked to a deleted row from here.
 *   missing  the refusal was something else: `failed` (the form's message).
 */
export async function checkRefusedPaymentInsert(
  eventId: string,
  transactionId: string,
  io: ExistingPaymentIO,
): Promise<RefusedInsertVerdict> {
  try {
    const state = await io.liveness(transactionId);
    if (state === 'unknown') return { kind: 'unknown' };
    if (state === 'missing') return { kind: 'failed' };
    if (state === 'deleted') return { kind: 'stale', link: 'never' };
    const confirmed = await io.confirm(eventId, transactionId);
    return { kind: 'exists', transactionId, link: confirmed === 'exists' ? 'linked' : 'pending' };
  } catch {
    return { kind: 'unknown' };
  }
}
