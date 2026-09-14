/**
 * Static verification for STEP AUTH-F2-A's NON-AUTHORITATIVE policy
 * reference (src/lib/accountDeletionPlan.ts — see its own header: the real
 * decision lives in the SQL RPC, 20260914001200_delete_sole_member_
 * households_rpc.sql). No Supabase, no React, no Deno — plain input/output
 * checks covering every case from the confirmed policy (households A/B/C/D
 * from the AUTH-F2 investigation report), kept as fast regression coverage
 * for the RULES themselves, independent of any live database.
 */
import {
  canProceedWithAccountDeletion,
  planAccountDeletion,
  type HouseholdMembershipForDeletion,
} from '@/lib/accountDeletionPlan';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runAccountDeletionPlanCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ==================== A. sole-member household ==================== */

  {
    const memberships: HouseholdMembershipForDeletion[] = [
      { householdId: 'h1', role: 'owner', memberCount: 1 },
    ];
    const plan = planAccountDeletion(memberships);
    check(
      'A1 sole member (necessarily owner, memberCount=1) -> soleMemberHouseholdIds only',
      plan.soleMemberHouseholdIds.length === 1 &&
        plan.soleMemberHouseholdIds[0] === 'h1' &&
        plan.safeMemberHouseholdIds.length === 0 &&
        plan.blockingHouseholdIds.length === 0,
      JSON.stringify(plan),
    );
    check('A2 sole-member-only plan can proceed', canProceedWithAccountDeletion(plan) === true, '');
  }

  /* ==================== B. normal member + co-members ==================== */

  {
    const memberships: HouseholdMembershipForDeletion[] = [
      { householdId: 'h2', role: 'member', memberCount: 3 },
    ];
    const plan = planAccountDeletion(memberships);
    check(
      'B1 plain member with co-members present -> safeMemberHouseholdIds only, nothing deleted',
      plan.safeMemberHouseholdIds.length === 1 &&
        plan.safeMemberHouseholdIds[0] === 'h2' &&
        plan.soleMemberHouseholdIds.length === 0 &&
        plan.blockingHouseholdIds.length === 0,
      JSON.stringify(plan),
    );
    check('B2 safe-member-only plan can proceed', canProceedWithAccountDeletion(plan) === true, '');
  }

  /* ==================== C. owner + co-members -> blocks ==================== */

  {
    const memberships: HouseholdMembershipForDeletion[] = [
      { householdId: 'h3', role: 'owner', memberCount: 2 },
    ];
    const plan = planAccountDeletion(memberships);
    check(
      'C1 owner with co-members present -> blockingHouseholdIds only, NOT sole/safe',
      plan.blockingHouseholdIds.length === 1 &&
        plan.blockingHouseholdIds[0] === 'h3' &&
        plan.soleMemberHouseholdIds.length === 0 &&
        plan.safeMemberHouseholdIds.length === 0,
      JSON.stringify(plan),
    );
    check(
      'C2 a plan with any blocking household cannot proceed',
      canProceedWithAccountDeletion(plan) === false,
      '',
    );
  }

  /* ==================== D. multiple households, mixed ==================== */

  {
    // Sole-member household + safe plain-member household -> both fine,
    // no blocking household anywhere -> can proceed, both classified
    // correctly and independently.
    const memberships: HouseholdMembershipForDeletion[] = [
      { householdId: 'h-sole', role: 'owner', memberCount: 1 },
      { householdId: 'h-safe', role: 'member', memberCount: 4 },
    ];
    const plan = planAccountDeletion(memberships);
    check(
      'D1 sole-member + safe-member households together -> classified independently, no blocking',
      plan.soleMemberHouseholdIds.length === 1 &&
        plan.soleMemberHouseholdIds[0] === 'h-sole' &&
        plan.safeMemberHouseholdIds.length === 1 &&
        plan.safeMemberHouseholdIds[0] === 'h-safe' &&
        plan.blockingHouseholdIds.length === 0,
      JSON.stringify(plan),
    );
    check('D2 all-safe multi-household plan can proceed', canProceedWithAccountDeletion(plan) === true, '');
  }

  {
    // The exact policy §4 case: several otherwise-safe households, but ONE
    // owner+co-member household anywhere in the set blocks the WHOLE
    // account deletion — never a partial deletion of just the safe ones.
    const memberships: HouseholdMembershipForDeletion[] = [
      { householdId: 'h-sole', role: 'owner', memberCount: 1 },
      { householdId: 'h-safe', role: 'member', memberCount: 3 },
      { householdId: 'h-blocking', role: 'owner', memberCount: 2 },
    ];
    const plan = planAccountDeletion(memberships);
    check(
      'D3 one owner+co-member household among several others -> still classified independently...',
      plan.soleMemberHouseholdIds.length === 1 &&
        plan.safeMemberHouseholdIds.length === 1 &&
        plan.blockingHouseholdIds.length === 1 &&
        plan.blockingHouseholdIds[0] === 'h-blocking',
      JSON.stringify(plan),
    );
    check(
      'D4 ...but the presence of that ONE blocking household stops the ENTIRE plan from proceeding',
      canProceedWithAccountDeletion(plan) === false,
      '',
    );
  }

  {
    // No households at all (never joined/created any) -> trivially safe,
    // empty plan, can proceed straight to deleting the auth user.
    const plan = planAccountDeletion([]);
    check(
      'E1 no households at all -> empty plan on every list',
      plan.soleMemberHouseholdIds.length === 0 &&
        plan.safeMemberHouseholdIds.length === 0 &&
        plan.blockingHouseholdIds.length === 0,
      JSON.stringify(plan),
    );
    check('E2 empty plan can proceed', canProceedWithAccountDeletion(plan) === true, '');
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
