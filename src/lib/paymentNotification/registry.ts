/**
 * 결제 알림 자동입력 — STEP 2. packageName → parser. Exact, case-sensitive
 * match, same as the native allowlist. An unsupported package yields `null`
 * (the UI shows it as "분석 대기"), never a generic best-effort guess.
 */
import { KAKAOBANK_PACKAGE, parseKakaoBankNotification } from '@/lib/paymentNotification/kakaoBankParser';
import type {
  ParsedPaymentCandidate,
  PaymentNotificationInput,
  PaymentNotificationParser,
} from '@/lib/paymentNotification/parserTypes';

const PARSERS: Readonly<Record<string, PaymentNotificationParser>> = {
  [KAKAOBANK_PACKAGE]: parseKakaoBankNotification,
};

export function isParserSupportedPackage(packageName: string): boolean {
  return Object.prototype.hasOwnProperty.call(PARSERS, packageName);
}

export function parsePaymentNotification(input: PaymentNotificationInput): ParsedPaymentCandidate | null {
  if (!isParserSupportedPackage(input.packageName)) return null;
  try {
    return PARSERS[input.packageName](input);
  } catch {
    return null;
  }
}
