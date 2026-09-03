/**
 * Dev verification for the STEP 10 extension skeleton.
 *
 * Same convention as `src/lib/*.cases.ts` (plain data + a runner, no test
 * framework). Not bundled; `npx tsc --noEmit` type-checks it. The runner is
 * `async` here because provider contracts return `Promise`s.
 *
 * Proves the skeleton is inert & safe:
 *  - RuleBasedProvider output === existing `buildInsights` output
 *  - OpenAIProvider stub is disabled and never throws
 *  - `getSpendingAnalysisProvider()` resolves to rule-based
 *  - every `PRO_FEATURES` entry is entitled (ProGate would pass children through)
 *  - `memberId`-less transactions are treated exactly like `memberId`-tagged ones
 *  - `members`-less settings resolve to a single default member
 *  - the sync provider is disabled and does nothing
 */

import { DEFAULT_CUSTOM_CATS } from '@/data/categories';
import { resolveEntitlements, PRO_FEATURES, type ProFeature } from '@/lib/entitlements';
import { buildInsights, type InsightInput } from '@/lib/insights';
import { DEFAULT_MEMBER, resolveMembers } from '@/lib/members';
import {
  getSpendingAnalysisProvider,
  openAIProvider,
  ruleBasedProvider,
} from '@/services/ai';
import { getSyncProvider } from '@/services/sync';
import type { Transaction } from '@/store/types';

const CATS = DEFAULT_CUSTOM_CATS;
const NOW = new Date(2026, 8, 15, 12, 0, 0); // 2026-09-15

const txn = (day: number, amount: number, category: string, memberId?: string): Transaction => ({
  id: `t${day}-${category}-${memberId ?? 'none'}`,
  type: 'expense',
  category,
  amount,
  memo: '',
  date: new Date(2026, 8, day, 12).toISOString(),
  ...(memberId ? { memberId } : {}),
});

const INPUT_EMPTY: InsightInput = { transactions: [], budgets: {}, customCats: CATS, now: NOW };
const INPUT_ONE: InsightInput = {
  transactions: [txn(3, 90_000, 'food'), txn(6, 30_000, 'transit')],
  budgets: {},
  customCats: CATS,
  now: NOW,
};
const INPUT_ONE_TAGGED: InsightInput = {
  transactions: [txn(3, 90_000, 'food', 'someone-else'), txn(6, 30_000, 'transit', 'me')],
  budgets: {},
  customCats: CATS,
  now: NOW,
};

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface SkeletonCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runSkeletonCases(): Promise<{
  results: SkeletonCaseResult[];
  passed: number;
  failed: number;
}> {
  const results: SkeletonCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---- RuleBasedProvider === buildInsights ---- */
  for (const [label, input] of [
    ['empty', INPUT_EMPTY],
    ['with data', INPUT_ONE],
  ] as const) {
    const viaProvider = await ruleBasedProvider.analyzeSpending(input);
    const direct = buildInsights(input);
    check(
      `RuleBasedProvider matches buildInsights (${label})`,
      eq(viaProvider, direct),
      `provider=${viaProvider.length} direct=${direct.length}`,
    );
  }

  /* ---- memberId is ignored by analysis ---- */
  {
    const plain = await ruleBasedProvider.analyzeSpending(INPUT_ONE);
    const tagged = await ruleBasedProvider.analyzeSpending(INPUT_ONE_TAGGED);
    check('memberId-tagged txns produce identical insights', eq(plain, tagged));
  }

  /* ---- OpenAIProvider stub is disabled & safe ---- */
  check('OpenAIProvider.isAvailable() === false', openAIProvider.isAvailable() === false);
  try {
    const out = await openAIProvider.analyzeSpending(INPUT_ONE);
    check('OpenAIProvider.analyzeSpending resolves to []', Array.isArray(out) && out.length === 0);
  } catch (e) {
    check('OpenAIProvider.analyzeSpending resolves to []', false, `threw: ${String(e)}`);
  }

  /* ---- active provider is rule-based ---- */
  check(
    `getSpendingAnalysisProvider().id === 'rule'`,
    getSpendingAnalysisProvider().id === 'rule',
    getSpendingAnalysisProvider().id,
  );

  /* ---- entitlements: every feature open ---- */
  {
    const ent = resolveEntitlements();
    const keys = Object.keys(PRO_FEATURES) as ProFeature[];
    const allOpen = keys.every((k) => ent.has(k) === true);
    check('every PRO_FEATURES entry is entitled', allOpen, keys.join(','));
    check(
      'ProGate would render children (has() true for a sample feature)',
      ent.has('advancedInsights') === true,
    );
  }

  /* ---- members: missing settings.members -> single default ---- */
  check('resolveMembers({}) -> [default]', eq(resolveMembers({}), [DEFAULT_MEMBER]));
  check(
    'resolveMembers({members: []}) -> [default]',
    eq(resolveMembers({ members: [] }), [DEFAULT_MEMBER]),
  );
  {
    const custom = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    check('resolveMembers passes a configured list through', eq(resolveMembers({ members: custom }), custom));
  }

  /* ---- sync provider is a disabled no-op ---- */
  {
    const sp = getSyncProvider();
    check('SyncProvider.isEnabled() === false', sp.isEnabled() === false, sp.id);
    const pushed = await sp.push({ updatedAt: NOW.toISOString(), data: {} as never });
    check(
      'SyncProvider.push resolves { ok:false, reason:"sync-disabled" }',
      eq(pushed, { ok: false, reason: 'sync-disabled' }),
    );
    const pulled = await sp.pull();
    check('SyncProvider.pull resolves null', pulled === null);
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
