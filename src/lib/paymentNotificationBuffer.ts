/**
 * 결제 알림 자동입력 — STEP 1 (native skeleton). The rules of the on-device
 * captured-notification buffer, as pure logic.
 *
 * The buffer itself is written by the Android listener service, in Kotlin
 * (modules/payment-notification-listener/.../CapturedNotificationBuffer.kt).
 * This file mirrors those rules 1:1 so they can be case-tested with the
 * repo's `.cases.ts` convention, and `sanitizeCapturedNotifications` applies
 * them once more to whatever the native side hands back — change both
 * together.
 *
 * Nothing here parses a payment, talks to the server or creates a
 * transaction.
 */

export interface CapturedNotification {
  /** Android's `StatusBarNotification.getKey()` — device-local, NOT a payment id. */
  notificationKey: string;
  /** The posting app's Android package name. */
  packageName: string;
  title: string;
  text: string;
  /** Epoch milliseconds the notification was posted. */
  postedAt: number;
}

export const CAPTURED_MAX_ENTRIES = 50;
export const CAPTURED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CAPTURED_MAX_TITLE_LENGTH = 200;
export const CAPTURED_MAX_TEXT_LENGTH = 1000;

/** Trimmed, non-empty, de-duplicated, first occurrence kept. */
export function normalizeAllowedPackages(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Exact, case-sensitive package match. An empty allowlist admits nothing. */
export function isPackageAllowed(packageName: string, allowed: readonly string[]): boolean {
  return packageName !== '' && allowed.includes(packageName);
}

const clean = (value: unknown, max: number): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\r\n/g, '\n').trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

/** `null` = nothing worth keeping (no key / package, or no title and no text). */
export function normalizeCapturedNotification(
  raw: {
    notificationKey?: unknown;
    packageName?: unknown;
    title?: unknown;
    text?: unknown;
    postedAt?: unknown;
  },
  now: number,
): CapturedNotification | null {
  const notificationKey = typeof raw.notificationKey === 'string' ? raw.notificationKey.trim() : '';
  const packageName = typeof raw.packageName === 'string' ? raw.packageName.trim() : '';
  if (notificationKey === '' || packageName === '') return null;
  const title = clean(raw.title, CAPTURED_MAX_TITLE_LENGTH);
  const text = clean(raw.text, CAPTURED_MAX_TEXT_LENGTH);
  if (title === '' && text === '') return null;
  const postedAt =
    typeof raw.postedAt === 'number' && Number.isFinite(raw.postedAt) && raw.postedAt > 0 ? raw.postedAt : now;
  return { notificationKey, packageName, title, text, postedAt };
}

/** Drops entries older than 7 days, newest first, at most 50. */
export function purgeCapturedNotifications(
  entries: readonly CapturedNotification[],
  now: number,
): CapturedNotification[] {
  return entries
    .filter((entry) => now - entry.postedAt <= CAPTURED_MAX_AGE_MS)
    .sort((a, b) => b.postedAt - a.postedAt)
    .slice(0, CAPTURED_MAX_ENTRIES);
}

/**
 * The same notification re-posted (same key, same title and text) is NOT
 * added again — the first arrival stays. The same key with DIFFERENT content
 * is kept as its own entry: some apps reuse one key for every payment, and
 * replacing would silently lose the earlier one.
 */
export function upsertCapturedNotification(
  entries: readonly CapturedNotification[],
  incoming: CapturedNotification,
  now: number,
): CapturedNotification[] {
  const repeated = entries.some(
    (entry) =>
      entry.notificationKey === incoming.notificationKey &&
      entry.title === incoming.title &&
      entry.text === incoming.text,
  );
  return purgeCapturedNotifications(repeated ? entries : [...entries, incoming], now);
}

/**
 * What the listener service does with one posted notification: nothing
 * unless its package is allowlisted, then normalize + upsert.
 */
export function captureNotification(
  entries: readonly CapturedNotification[],
  raw: Parameters<typeof normalizeCapturedNotification>[0],
  allowed: readonly string[],
  now: number,
): CapturedNotification[] {
  const packageName = typeof raw.packageName === 'string' ? raw.packageName.trim() : '';
  if (!isPackageAllowed(packageName, allowed)) return [...entries];
  const incoming = normalizeCapturedNotification(raw, now);
  return incoming ? upsertCapturedNotification(entries, incoming, now) : [...entries];
}

/** Validates the native module's reply — anything malformed is dropped, never trusted. */
export function sanitizeCapturedNotifications(raw: unknown, now: number): CapturedNotification[] {
  if (!Array.isArray(raw)) return [];
  const out: CapturedNotification[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const entry = normalizeCapturedNotification(item as Record<string, unknown>, now);
    if (entry) out.push(entry);
  }
  return purgeCapturedNotifications(out, now);
}
