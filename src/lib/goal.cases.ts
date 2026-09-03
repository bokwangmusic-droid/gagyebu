/**
 * Dev verification for the savings-goal maths (STEP 9).
 *
 * Same convention as `splits.cases.ts` / `insights.cases.ts`: no test
 * framework is set up, so these are plain data + a runner. Nothing imports
 * this file in the app, so it is not bundled; `npx tsc --noEmit` still
 * type-checks it. Run ad-hoc:
 *
 *   npx tsc src/lib/goal.ts src/lib/goal.cases.ts src/store/types.ts \
 *     --outDir /tmp/goalcheck --module commonjs --moduleResolution node \
 *     --target es2020 --skipLibCheck --baseUrl . --paths '{"@/*":["src/*"]}'
 *   node -e "const {runGoalCases}=require('/tmp/goalcheck/src/lib/goal.cases.js');
 *            const r=runGoalCases(); console.log(r.results.map(x=>(x.pass?'OK  ':'FAIL')+' '+x.name+'  '+x.detail).join('\n'));
 *            console.log(r.passed+'/'+(r.passed+r.failed)+' passed'); process.exit(r.failed?1:0)"
 */

import { goalStats, type GoalPace } from '@/lib/goal';
import type { Goal } from '@/store/types';

const g = (o: Partial<Goal>): Goal => ({
  id: 'g',
  name: '테스트',
  target: 0,
  saved: 0,
  deadline: null,
  icon: 'target',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...o,
});

export interface GoalCase {
  name: string;
  goal: Goal;
  now: Date;
  expect: {
    progressPct?: number;
    achieved?: boolean;
    remainingAmount?: number;
    /** whether `stats.deadline` is non-null */
    hasDeadline?: boolean;
    past?: boolean;
    /** number, or `null` to assert `undefined` */
    remainingMonths?: number | null;
    requiredMonthlySaving?: number | null;
    /** GoalPace, or `null` to assert `undefined` */
    pace?: GoalPace | null;
  };
}

export const GOAL_CASES: GoalCase[] = [
  {
    name: '기본 · 12,000,000 목표, 3,000,000 모음, 9개월 → 매월 1,000,000',
    goal: g({ target: 12_000_000, saved: 3_000_000, deadline: '2026-10-15' }),
    now: new Date(2026, 0, 15),
    expect: {
      progressPct: 25,
      achieved: false,
      remainingAmount: 9_000_000,
      hasDeadline: true,
      past: false,
      remainingMonths: 9,
      requiredMonthlySaving: 1_000_000,
      // pace is covered by the dedicated cases below
    },
  },
  {
    name: 'deadline 없음 → 월 저축액/페이스 계산 안 함',
    goal: g({ target: 1_000_000, saved: 300_000, deadline: null }),
    now: new Date(2026, 5, 1),
    expect: { progressPct: 30, hasDeadline: false, achieved: false },
  },
  {
    name: '목표 초과 달성 → progress 100%로 clamp, achieved',
    goal: g({ target: 1_000_000, saved: 1_500_000, deadline: null }),
    now: new Date(2026, 5, 1),
    expect: { progressPct: 100, achieved: true, remainingAmount: 0 },
  },
  {
    name: 'deadline 있는데 이미 달성 → 월 저축액/페이스 숨김',
    goal: g({ target: 1_000_000, saved: 1_200_000, deadline: '2026-12-01' }),
    now: new Date(2026, 5, 1),
    expect: {
      progressPct: 100,
      achieved: true,
      hasDeadline: true,
      past: false,
      requiredMonthlySaving: null,
      pace: null,
    },
  },
  {
    name: '목표일 지남 · 미달성 → past, 75% 달성, NaN/음수 없음',
    goal: g({ target: 1_000_000, saved: 750_000, deadline: '2026-01-10' }),
    now: new Date(2026, 5, 1),
    expect: {
      progressPct: 75,
      achieved: false,
      hasDeadline: true,
      past: true,
      remainingMonths: null,
      requiredMonthlySaving: null,
      pace: null,
    },
  },
  {
    name: '목표일이 이번 달 → remainingMonths는 최소 1',
    goal: g({ target: 1_000_000, saved: 200_000, deadline: '2026-06-20' }),
    now: new Date(2026, 5, 1),
    expect: { remainingMonths: 1, requiredMonthlySaving: 800_000, past: false },
  },
  {
    name: 'target 0 → 나눗셈/Infinity 없이 0 처리',
    goal: g({ target: 0, saved: 0, deadline: null }),
    now: new Date(2026, 5, 1),
    expect: { progressPct: 0, achieved: false, remainingAmount: 0 },
  },
  {
    name: '페이스: 빠름 (80% 모음 vs 시간 34% 경과)',
    goal: g({
      target: 1_000_000,
      saved: 800_000,
      deadline: '2026-04-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    now: new Date(2026, 1, 1),
    expect: { pace: 'ahead' },
  },
  {
    name: '페이스: 계획대로 (50% 모음 vs 시간 ~52% 경과)',
    goal: g({
      target: 1_000_000,
      saved: 500_000,
      deadline: '2026-03-02',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    now: new Date(2026, 1, 1),
    expect: { pace: 'onTrack' },
  },
  {
    name: '페이스: 뒤처짐 (0원 vs 시간 ~53% 경과)',
    goal: g({
      target: 1_000_000,
      saved: 0,
      deadline: '2026-03-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    now: new Date(2026, 1, 1),
    expect: { pace: 'behind' },
  },
  {
    name: '잘못된 deadline 문자열 → deadline 없음처럼 처리',
    goal: g({ target: 1_000_000, saved: 300_000, deadline: '2026-13-40' }),
    now: new Date(2026, 5, 1),
    expect: { hasDeadline: false, progressPct: 30 },
  },
  {
    name: 'createdAt 없음 → 페이스 숨김, 월 저축액은 계산',
    goal: g({ target: 1_000_000, saved: 500_000, deadline: '2026-12-01', createdAt: '' }),
    now: new Date(2026, 5, 1),
    expect: { pace: null, requiredMonthlySaving: 83_334, remainingMonths: 6 },
  },
];

export interface GoalCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export function runGoalCases(cases: GoalCase[] = GOAL_CASES): {
  results: GoalCaseResult[];
  passed: number;
  failed: number;
} {
  const results = cases.map((c) => {
    const s = goalStats(c.goal, c.now);
    const dl = s.deadline;
    const checks: [string, boolean][] = [];

    const e = c.expect;
    if (e.progressPct !== undefined) checks.push([`progressPct=${s.progressPct}~${e.progressPct}`, s.progressPct === e.progressPct]);
    if (e.achieved !== undefined) checks.push([`achieved=${s.achieved}~${e.achieved}`, s.achieved === e.achieved]);
    if (e.remainingAmount !== undefined)
      checks.push([`remaining=${s.remainingAmount}~${e.remainingAmount}`, s.remainingAmount === e.remainingAmount]);
    if (e.hasDeadline !== undefined) checks.push([`hasDeadline=${dl !== null}~${e.hasDeadline}`, (dl !== null) === e.hasDeadline]);
    if (e.past !== undefined) checks.push([`past=${dl?.past}~${e.past}`, dl?.past === e.past]);
    if (e.remainingMonths !== undefined)
      checks.push([
        `remainingMonths=${dl?.remainingMonths}~${e.remainingMonths}`,
        (dl?.remainingMonths ?? null) === e.remainingMonths,
      ]);
    if (e.requiredMonthlySaving !== undefined)
      checks.push([
        `required=${dl?.requiredMonthlySaving}~${e.requiredMonthlySaving}`,
        (dl?.requiredMonthlySaving ?? null) === e.requiredMonthlySaving,
      ]);
    if (e.pace !== undefined)
      checks.push([`pace=${dl?.pace}~${e.pace}`, (dl?.pace ?? null) === e.pace]);

    // Universal safety: no NaN / Infinity ever leaks out.
    const nums = [s.progress, s.progressPct, s.remainingAmount, dl?.remainingMonths ?? 0, dl?.requiredMonthlySaving ?? 0];
    const finiteOk = nums.every((n) => Number.isFinite(n) && n >= 0);
    checks.push([`finite&>=0`, finiteOk]);

    const pass = checks.every(([, ok]) => ok);
    return { name: c.name, pass, detail: checks.map(([d, ok]) => (ok ? d : `✗${d}`)).join(' ') };
  });
  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
