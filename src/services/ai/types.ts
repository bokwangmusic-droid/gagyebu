/**
 * AI spending-analysis layer — STEP 10 skeleton.
 *
 * Interfaces only. The app keeps using the rule-based engine
 * (`src/lib/insights.ts`) exactly as before; this layer just lets a future
 * step drop in another provider behind the same contract.
 *
 * `SpendingSummary` and `Insight` are re-exported from STEP 7 verbatim — no
 * parallel types.
 */

import type { Insight, InsightInput } from '@/lib/insights';

export type { Insight, InsightInput } from '@/lib/insights';

/** Input to an analysis run — the STEP 7 `InsightInput` shape, unchanged. */
export type SpendingSummary = InsightInput;

/**
 * Every provider (rule-based today; OpenAI / others later) implements this.
 * `analyzeSpending` must never reject for a control-flow reason — callers
 * `await` it directly.
 */
export interface SpendingAnalysisProvider {
  /** Stable id, e.g. 'rule' | 'openai'. */
  readonly id: string;
  /** Whether this provider can actually run now (key present, enabled, …). */
  isAvailable(): boolean;
  analyzeSpending(summary: SpendingSummary): Promise<Insight[]>;
}
