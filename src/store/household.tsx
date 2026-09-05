/**
 * Household state — STEP 16-E.
 *
 * Mirrors src/store/auth.tsx's shape (its own small Context provider, no
 * external state library). Depends on useAuth() for the signed-in user but
 * is otherwise independent of StoreProvider — it only ever reads
 * households/household_members via Supabase, never touches gagyebu.*
 * AsyncStorage data. See app/_layout.tsx for how AuthGate uses this to
 * route between household-setup / household-select / household-ready.
 *
 * Scope: household membership only. No transactions/budgets/cards/goals/
 * loans query here — that is explicitly the next STEP's job.
 */
import type { PostgrestError } from '@supabase/supabase-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { supabase } from '@/lib/supabase';
import { useAuth } from '@/store/auth';

export type HouseholdRole = 'owner' | 'member';

export interface Household {
  id: string;
  name: string;
  role: HouseholdRole;
  /** household_members.id for the current user's row in this household. */
  memberId: string;
}

export interface HouseholdMemberInfo {
  /** household_members.id — never the auth user id/email. */
  id: string;
  displayName: string;
  role: HouseholdRole;
  isMe: boolean;
}

export type HouseholdActionResult = { ok: true } | { ok: false; message: string };
export type CreateInviteResult =
  | { ok: true; code: string; expiresAt: string }
  | { ok: false; message: string };

interface HouseholdContextValue {
  households: Household[];
  activeHousehold: Household | null;
  members: HouseholdMemberInfo[];
  loading: boolean;
  membersLoading: boolean;
  error: string | null;
  /**
   * The auth user id `households`/`activeHousehold` are a CONFIRMED,
   * completed fetch result for — `null` while signed out or while no
   * fetch for the current user has finished yet. Only ever set at the end
   * of a successful `refreshHouseholds()` for that exact user; never
   * optimistically, never on error. Consumers (AuthGate) compare this
   * against the signed-in user's id instead of just checking `!loading`,
   * because `loading` alone can briefly read `false` with stale
   * (previous-user or signed-out) data still sitting in `households`
   * before a fetch for a newly-signed-in user has even started.
   */
  loadedForUserId: string | null;

  refreshHouseholds(): Promise<void>;
  selectHousehold(id: string): void;
  createHousehold(name: string): Promise<HouseholdActionResult>;
  createInvite(): Promise<CreateInviteResult>;
  joinWithCode(code: string): Promise<HouseholdActionResult>;
  refreshMembers(): Promise<void>;
}

const HouseholdContext = createContext<HouseholdContextValue | null>(null);

/** Postgres/RPC errors -> friendly Korean copy. Never surfaces raw internals. */
function describeHouseholdError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as PostgrestError).message)
        : String(error);

  if (raw.includes('INVALID_CODE')) return '초대코드를 확인해 주세요';
  if (raw.includes('ALREADY_USED')) return '이미 사용된 초대코드예요';
  if (raw.includes('REVOKED_CODE')) return '취소된 초대코드예요';
  if (raw.includes('EXPIRED_CODE')) return '만료된 초대코드예요';
  if (raw.includes('ALREADY_MEMBER')) return '이미 참여 중인 우리집이에요';
  if (raw.includes('NOT_OWNER')) return '초대코드를 만들 권한이 없어요';
  if (raw.includes('AUTH_REQUIRED')) return '다시 로그인해 주세요';
  const m = raw.toLowerCase();
  if (m.includes('network') || m.includes('fetch')) return '네트워크 연결을 확인해 주세요';
  return '문제가 발생했어요. 잠시 후 다시 시도해주세요';
}

interface HouseholdMemberRow {
  id: string;
  role: HouseholdRole;
  household_id: string;
  households: { name: string } | { name: string }[] | null;
}

function householdNameOf(row: HouseholdMemberRow): string {
  const h = row.households;
  if (!h) return '우리집 가계부';
  return Array.isArray(h) ? (h[0]?.name ?? '우리집 가계부') : h.name;
}

export function HouseholdProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [households, setHouseholds] = useState<Household[]>([]);
  const [activeHousehold, setActiveHousehold] = useState<Household | null>(null);
  const [members, setMembers] = useState<HouseholdMemberInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [membersLoading, setMembersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedForUserId, setLoadedForUserId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Imperative-only bookkeeping, mutated in effects/async callbacks —
  // NEVER read during render or used to compute render output (that's
  // what `loadedForUserId` state is for). Lets an in-flight fetch that
  // resolves after the signed-in user has since changed recognise it's
  // stale and drop itself instead of clobbering the new user's state
  // (STEP 16-E readiness fix §4: account-switch race).
  const latestUserIdRef = useRef<string | null>(null);

  const refreshHouseholds = useCallback(async () => {
    const requestedUserId = user?.id ?? null;
    if (!requestedUserId) {
      setHouseholds([]);
      setActiveHousehold(null);
      setLoadedForUserId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('household_members')
      .select('id, role, household_id, households(name)')
      .eq('user_id', requestedUserId);

    if (!mountedRef.current) return;
    // Stale-response guard: the signed-in user changed while this fetch
    // was in flight (e.g. user A signed out / user B signed in before A's
    // query returned). The effect below already started a fresh fetch for
    // whoever is current now — just drop this result rather than
    // overwriting their state with A's data.
    if (requestedUserId !== latestUserIdRef.current) return;

    if (err) {
      setError(describeHouseholdError(err));
      setLoading(false);
      // loadedForUserId intentionally left untouched — this fetch did not
      // produce confirmed data for requestedUserId.
      return;
    }

    const list: Household[] = ((data ?? []) as HouseholdMemberRow[]).map((row) => ({
      id: row.household_id,
      name: householdNameOf(row),
      role: row.role,
      memberId: row.id,
    }));
    setHouseholds(list);
    // Never silently pick among several households (STEP 16-E §7) — only
    // auto-select the unambiguous single-household case, or keep whatever
    // the user already explicitly picked if it's still in the fresh list.
    setActiveHousehold((prev) => {
      if (list.length === 1) return list[0];
      if (prev && list.some((h) => h.id === prev.id)) {
        return list.find((h) => h.id === prev.id) ?? null;
      }
      return null;
    });
    setLoadedForUserId(requestedUserId);
    setLoading(false);
  }, [user]);

  // Sign-out clears every bit of household state from memory (STEP 16-E
  // §6/§13) — this never touches gagyebu.* AsyncStorage data. Sign-in loads.
  useEffect(() => {
    mountedRef.current = true;
    latestUserIdRef.current = user?.id ?? null;
    if (!user) {
      setHouseholds([]);
      setActiveHousehold(null);
      setMembers([]);
      setError(null);
      setLoadedForUserId(null);
      setLoading(false);
      return;
    }
    void refreshHouseholds();
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const refreshMembers = useCallback(async () => {
    if (!activeHousehold) {
      setMembers([]);
      return;
    }
    setMembersLoading(true);
    const { data, error: err } = await supabase
      .from('household_members')
      .select('id, role, display_name, user_id')
      .eq('household_id', activeHousehold.id)
      .order('joined_at', { ascending: true });

    if (!mountedRef.current) return;
    if (err) {
      setMembersLoading(false);
      return;
    }
    setMembers(
      ((data ?? []) as { id: string; role: HouseholdRole; display_name: string; user_id: string }[]).map(
        (row) => ({
          id: row.id,
          displayName: row.display_name,
          role: row.role,
          isMe: row.user_id === user?.id,
        }),
      ),
    );
    setMembersLoading(false);
  }, [activeHousehold, user?.id]);

  useEffect(() => {
    if (activeHousehold) void refreshMembers();
    else setMembers([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHousehold?.id]);

  const selectHousehold = useCallback(
    (id: string) => {
      const found = households.find((h) => h.id === id);
      if (found) setActiveHousehold(found);
    },
    [households],
  );

  const createHousehold: HouseholdContextValue['createHousehold'] = useCallback(
    async (name) => {
      if (!user) return { ok: false, message: '로그인이 필요해요' };
      const trimmed = name.trim();
      if (!trimmed) return { ok: false, message: '우리집 이름을 입력해 주세요' };

      const { data: inserted, error: insertErr } = await supabase
        .from('households')
        .insert({ name: trimmed, created_by: user.id })
        .select('id')
        .single();
      if (insertErr || !inserted) {
        return { ok: false, message: describeHouseholdError(insertErr) };
      }

      // private.handle_new_household() (supabase/migrations/
      // 20260905000300_integrity_triggers.sql) creates the owner
      // household_members row + household_settings row automatically, in
      // the SAME transaction as the insert above. Verify it actually
      // landed rather than assuming — if it didn't, that is a server-side
      // trigger problem to report, not something to paper over with a
      // compensating client INSERT (which household_members' RLS/grants
      // don't allow anyway).
      const { data: membership, error: memberErr } = await supabase
        .from('household_members')
        .select('id')
        .eq('household_id', inserted.id)
        .eq('user_id', user.id)
        .eq('role', 'owner')
        .maybeSingle();

      if (memberErr || !membership) {
        return {
          ok: false,
          message: '우리집은 만들어졌지만 멤버십 확인에 실패했어요. 잠시 후 다시 시도해주세요',
        };
      }

      await refreshHouseholds();
      return { ok: true };
    },
    [user, refreshHouseholds],
  );

  const createInvite: HouseholdContextValue['createInvite'] = useCallback(async () => {
    if (!activeHousehold) return { ok: false, message: '먼저 우리집을 선택해 주세요' };
    const { data, error: err } = await supabase.rpc('create_household_invite', {
      p_household_id: activeHousehold.id,
    });
    if (err) return { ok: false, message: describeHouseholdError(err) };
    const row = (Array.isArray(data) ? data[0] : data) as
      | { code: string; expires_at: string }
      | undefined;
    if (!row?.code) return { ok: false, message: '초대코드를 만들지 못했어요' };
    return { ok: true, code: row.code, expiresAt: row.expires_at };
  }, [activeHousehold]);

  const joinWithCode: HouseholdContextValue['joinWithCode'] = useCallback(
    async (code) => {
      const { error: err } = await supabase.rpc('redeem_household_invite', { p_code: code });
      if (err) return { ok: false, message: describeHouseholdError(err) };
      await refreshHouseholds();
      return { ok: true };
    },
    [refreshHouseholds],
  );

  const value = useMemo<HouseholdContextValue>(
    () => ({
      households,
      activeHousehold,
      members,
      loading,
      membersLoading,
      error,
      loadedForUserId,
      refreshHouseholds,
      selectHousehold,
      createHousehold,
      createInvite,
      joinWithCode,
      refreshMembers,
    }),
    [
      households,
      activeHousehold,
      members,
      loading,
      membersLoading,
      error,
      loadedForUserId,
      refreshHouseholds,
      selectHousehold,
      createHousehold,
      createInvite,
      joinWithCode,
      refreshMembers,
    ],
  );

  return <HouseholdContext.Provider value={value}>{children}</HouseholdContext.Provider>;
}

export function useHousehold(): HouseholdContextValue {
  const ctx = useContext(HouseholdContext);
  if (!ctx) throw new Error('useHousehold must be used within <HouseholdProvider>');
  return ctx;
}
