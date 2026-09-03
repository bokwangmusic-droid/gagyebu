/**
 * OpenAI spending-analysis provider — STEP 10 SKELETON ONLY.
 *
 * There is deliberately no SDK, no `fetch`, no API-key storage and no network
 * here. `isAvailable()` is hard-`false`, so `getSpendingAnalysisProvider()`
 * never selects it and the rule-based provider is always used. `analyzeSpending`
 * resolves to `[]` (never throws) so that even a direct call is safe.
 *
 * A future step replaces the body with a real, key-guarded request and flips
 * `isAvailable()` to check for that key.
 */

import type { Insight } from '@/lib/insights';

import type { SpendingAnalysisProvider, SpendingSummary } from './types';

/** No key wiring in STEP 10 — always false. */
function hasApiKey(): boolean {
  return false;
}

export const openAIProvider: SpendingAnalysisProvider = {
  id: 'openai',
  isAvailable: () => hasApiKey(),
  analyzeSpending: (_summary: SpendingSummary): Promise<Insight[]> => Promise.resolve([]),
};
