/**
 * AI service entry point — STEP 10 skeleton.
 *
 * `getSpendingAnalysisProvider()` is the single seam a future step swaps.
 * Today it always resolves to the rule-based provider (the configured default,
 * and the fallback for any provider that reports itself unavailable), so app
 * behaviour is unchanged.
 */

export type {
  SpendingAnalysisProvider,
  SpendingSummary,
  Insight,
  InsightInput,
} from './types';
export { ruleBasedProvider } from './ruleBasedProvider';
export { openAIProvider } from './openAIProvider';

import { openAIProvider } from './openAIProvider';
import { ruleBasedProvider } from './ruleBasedProvider';
import type { SpendingAnalysisProvider } from './types';

/** Configured default. The app always runs rule-based in STEP 10. */
export const AI_PROVIDER: 'rule' | 'openai' = 'rule';

const REGISTRY: Record<string, SpendingAnalysisProvider> = {
  rule: ruleBasedProvider,
  openai: openAIProvider,
};

/**
 * The active provider. Never returns a dead one: falls back to rule-based
 * whenever the configured provider is unknown or `isAvailable()` is false.
 */
export function getSpendingAnalysisProvider(): SpendingAnalysisProvider {
  const chosen = REGISTRY[AI_PROVIDER];
  return chosen && chosen.isAvailable() ? chosen : ruleBasedProvider;
}
