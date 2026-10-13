/**
 * 결제 알림 자동입력 — Android package names whose notifications the listener
 * may keep. Everything else is dropped in the native service before it is
 * stored anywhere.
 *
 * Deliberately EMPTY for now: a package name goes in here only after it has
 * been read off a real device (STEP 7 QA), never from memory. Until then QA
 * adds packages by hand on the 결제 알림 자동입력 (준비 중) screen.
 */
export const DEFAULT_PAYMENT_NOTIFICATION_PACKAGES: readonly string[] = [];
