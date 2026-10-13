/**
 * 결제 알림 자동입력 — STEP 1. JS surface of the local Expo module
 * `modules/payment-notification-listener` (Android NotificationListenerService).
 *
 * Android only. On iOS / web — and on an Android binary that predates the
 * native module but received this JS as an OTA update — the module is simply
 * absent: `isPaymentNotificationSupported()` is false and every call below is
 * a no-op with an empty / false result. Nothing here throws for that reason.
 *
 * Captured notifications stay on the device. This file never sends them
 * anywhere and never creates a transaction.
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import {
  normalizeAllowedPackages,
  sanitizeCapturedNotifications,
  type CapturedNotification,
} from '@/lib/paymentNotificationBuffer';

interface NativePaymentNotificationListener {
  isNotificationAccessGranted(): Promise<boolean>;
  openNotificationAccessSettings(): Promise<void>;
  getAllowedPackages(): Promise<string[]>;
  setAllowedPackages(packages: string[]): Promise<string[]>;
  getCapturedNotifications(): Promise<unknown>;
  clearCapturedNotifications(): Promise<unknown>;
}

let cached: NativePaymentNotificationListener | null | undefined;

function native(): NativePaymentNotificationListener | null {
  if (cached !== undefined) return cached;
  if (Platform.OS !== 'android') {
    cached = null;
    return cached;
  }
  try {
    cached = requireOptionalNativeModule<NativePaymentNotificationListener>('PaymentNotificationListener');
  } catch {
    cached = null;
  }
  return cached;
}

/** Android with the native module in this binary. */
export function isPaymentNotificationSupported(): boolean {
  return native() != null;
}

/** Has the user turned system notification access on for this app? */
export async function isNotificationAccessGranted(): Promise<boolean> {
  const mod = native();
  if (!mod) return false;
  try {
    return (await mod.isNotificationAccessGranted()) === true;
  } catch {
    return false;
  }
}

/** Opens the system notification-access screen. `false` = could not be opened. */
export async function openNotificationAccessSettings(): Promise<boolean> {
  const mod = native();
  if (!mod) return false;
  try {
    await mod.openNotificationAccessSettings();
    return true;
  } catch {
    return false;
  }
}

/** The packages whose notifications the listener keeps right now. */
export async function getAllowedPackages(): Promise<string[]> {
  const mod = native();
  if (!mod) return [];
  try {
    return normalizeAllowedPackages(await mod.getAllowedPackages());
  } catch {
    return [];
  }
}

/** Replaces the allowlist. Resolves the list actually stored (`[]` when unsupported). */
export async function setAllowedPackages(packages: readonly string[]): Promise<string[]> {
  const mod = native();
  if (!mod) return [];
  try {
    return normalizeAllowedPackages(await mod.setAllowedPackages(normalizeAllowedPackages(packages)));
  } catch {
    return [];
  }
}

/** Newest first, at most 50, nothing older than 7 days. */
export async function getCapturedNotifications(): Promise<CapturedNotification[]> {
  const mod = native();
  if (!mod) return [];
  try {
    return sanitizeCapturedNotifications(await mod.getCapturedNotifications(), Date.now());
  } catch {
    return [];
  }
}

export async function clearCapturedNotifications(): Promise<boolean> {
  const mod = native();
  if (!mod) return false;
  try {
    await mod.clearCapturedNotifications();
    return true;
  } catch {
    return false;
  }
}
