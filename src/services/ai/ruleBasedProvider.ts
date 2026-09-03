/**
 * The default (and only active) spending-analysis provider.
 *
 * A thin async wrapper over STEP 7's pure `buildInsights`. Output is
 * byte-for-byte the existing rule-based result — the wrapper adds nothing but
 * the `Promise` the contract asks for.
 */

import { buildInsights, type Insight } from '@/lib/insights';

import type { SpendingAnalysisProvider, SpendingSummary } from './types';

export const ruleBasedProvider: SpendingAnalysisProvider = {
  id: 'rule',
  isAvailable: () => true,
  analyzeSpending: (summary: SpendingSummary): Promise<Insight[]> =>
    Promise.resolve(buildInsights(summary)),
};
