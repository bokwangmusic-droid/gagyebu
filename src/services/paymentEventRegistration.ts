/**
 * 결제 알림 자동입력 — STEP 5. Registers 후보함 candidates with the server
 * dedup (public.register_payment_notification_event, migration
 * 20261019002200). Registration only: no transaction is created.
 *
 * Best effort, never throws. A failure (offline, server error, missing
 * crypto module) only leaves the candidate unregistered — the local 후보함
 * is unaffected and the next screen visit tries again. The RPC is
 * insert-or-get, so a retry after a lost reply returns the SAME event.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import {
  parsePaymentEventRegisterReply,
  type PaymentEventRegisterResult,
  type PaymentEventRegistration,
} from '@/lib/paymentNotification/serverDedup';
import { supabase } from '@/lib/supabase';
import { isTransportError } from '@/lib/transportError';

type Sha256Hex = (data: string) => Promise<string>;

/**
 * Imported lazily, as in src/services/remoteHouseholdReset.ts: `expo-crypto`
 * resolves its native module at import time. `null` = unavailable.
 */
async function loadSha256(): Promise<Sha256Hex | null> {
  try {
    const Crypto = await import('expo-crypto');
    return (data) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, data);
  } catch {
    return null;
  }
}

const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

export async function registerPaymentEvent(
  householdId: string,
  reg: PaymentEventRegistration,
  sha256?: Sha256Hex,
): Promise<PaymentEventRegisterResult> {
  try {
    const hash = sha256 ?? (await loadSha256());
    if (!hash) return { ok: false, transport: false };
    const dedupKey = (await hash(reg.preimage)).toLowerCase();
    if (!isHex64(dedupKey)) return { ok: false, transport: false };
    const { data, error } = await supabase.rpc('register_payment_notification_event', {
      p_household_id: householdId,
      p_dedup_key: dedupKey,
      p_source_package: reg.sourcePackage,
      p_parser_id: reg.parserId,
      p_parser_version: reg.parserVersion,
      p_event_type: reg.eventType,
      p_amount: reg.amount,
      p_last4: reg.last4,
      p_occurred_at: new Date(reg.occurredAt).toISOString(),
    });
    if (error) return { ok: false, transport: isTransportError(error as PostgrestError) };
    return parsePaymentEventRegisterReply(data);
  } catch (e) {
    return { ok: false, transport: isTransportError(e) };
  }
}

/**
 * Registers each one in turn; stops at the first transport failure (the
 * rest would fail the same way). Returns the fingerprints that registered.
 */
export async function registerPaymentEvents(
  householdId: string,
  regs: readonly PaymentEventRegistration[],
): Promise<string[]> {
  const sha256 = await loadSha256();
  if (!sha256) return [];
  const done: string[] = [];
  for (const reg of regs) {
    const res = await registerPaymentEvent(householdId, reg, sha256);
    if (res.ok) done.push(reg.fingerprint);
    else if (res.transport) break;
  }
  return done;
}
