/**
 * 결제 알림 자동입력 — STEP 5. The install id behind the server dedup's
 * device hash / local claim hash (src/lib/paymentNotification/serverDedup.ts).
 *
 * A random UUID made once and kept in AsyncStorage: stable for this app
 * install, new after a reinstall / app data clear (that phone then simply
 * claims as a new device). Not a hardware id, not the account, not the
 * Android notification key. Never sent as-is — only hashes of it. Not part
 * of the backup format.
 */
import { isPaymentInstallId } from '@/lib/paymentNotification/serverDedup';
import { loadItem, saveItem } from '@/lib/storage';

const KEY = 'paymentNotificationInstallId.v1';

let pending: Promise<string | null> | null = null;

async function loadOrCreate(): Promise<string | null> {
  const stored = await loadItem<unknown>(KEY, null);
  if (isPaymentInstallId(stored)) return stored;
  try {
    // Imported lazily, as in src/services/remoteHouseholdReset.ts.
    const Crypto = await import('expo-crypto');
    const id = Crypto.randomUUID().toLowerCase();
    if (!isPaymentInstallId(id)) return null;
    await saveItem(KEY, id);
    // saveItem swallows errors: only an id that is really stored is used,
    // otherwise every launch would claim as a new device.
    return (await loadItem<unknown>(KEY, null)) === id ? id : null;
  } catch {
    return null;
  }
}

/** `null` = unavailable right now (storage / crypto); registration is skipped and retried later. */
export function loadPaymentInstallId(): Promise<string | null> {
  if (!pending) {
    pending = loadOrCreate().then((id) => {
      if (!id) pending = null;
      return id;
    });
  }
  return pending;
}
