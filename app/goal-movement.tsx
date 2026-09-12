import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { Field, HeaderTextButton } from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, parseNum } from '@/lib/format';
import { uid } from '@/lib/id';
import type { GoalMovementMode } from '@/lib/remoteGoalWriteMapping';
import type { EnqueueOutcome } from '@/services/offlineQueue/coordinator';
import { addGoalMovement } from '@/services/remoteGoalWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import type { Goal } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

/** Digit-entry rules — identical to the main expense keypad (app/input.tsx). */
function applyDigit(amount: string, k: string): string {
  if (k === 'back') return amount.slice(0, -1);
  if (k === '00') return amount === '' || amount === '0' || amount.length >= 9 ? amount : amount + '00';
  if (k === '0') return amount === '' || amount === '0' || amount.length >= 10 ? amount : amount + '0';
  return amount.length >= 10 ? amount : (amount === '0' ? '' : amount) + k;
}

function normalizeMode(raw: string | string[] | undefined): GoalMovementMode | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === 'deposit' || v === 'withdraw' ? v : null;
}

/**
 * Route entry for /goal-movement — STEP 16-G2-D3.
 *
 *   /goal-movement?id=<gid>&mode=deposit   -> "저축하기"
 *   /goal-movement?id=<gid>&mode=withdraw  -> "인출하기"
 *
 * The user always types a POSITIVE amount; `mode` decides the sign of the
 * stored `amount_delta`. This screen NEVER writes `goals.saved` — it does a
 * single `goal_movements` INSERT and the DB trigger updates the cache.
 */
export default function GoalMovementRoute() {
  const params = useLocalSearchParams<{ id?: string | string[]; mode?: string | string[] }>();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;
  const mode = normalizeMode(params.mode);

  if (!REMOTE_FINANCE_WRITE.goalAddMovement || !idParam || !mode) {
    return <ReadOnlyRouteNotice title="저축 목표" />;
  }
  return <GoalMovementFormRoute goalId={idParam} mode={mode} />;
}

function GoalMovementFormRoute({ goalId, mode }: { goalId: string; mode: GoalMovementMode }) {
  const router = useRouter();
  const { status, error, goals, pendingGoalOps, refresh } = useFinanceRead();
  const title = mode === 'deposit' ? '저축하기' : '인출하기';

  // STEP 16-G3-B2 §17-21: once the parent goal has resolved, FREEZE it for
  // this movement session. A later Realtime / foreground refresh that drops
  // the goal (the other member deleted it) must NOT unmount the form and
  // lose the typed amount — addGoalMovement()'s INSERT then fails its
  // composite FK / reconcile and the user sees that outcome.
  const frozenGoalRef = useRef<Goal | null>(null);

  // STEP 16-H2-G3 §7/§11: a goal with an in-flight / terminal-failed offline
  // op (create/update/delete OR another queued movement) is read-only — a
  // goal accepts at most ONE offline change at a time, so never open a
  // SECOND movement sheet on top of one already queued (the coordinator's
  // `enqueueGoalMovementCreate` lock guard would refuse it as
  // `existing-pending` anyway; this just avoids the user reaching that dead
  // end). Checked BEFORE the freeze below so a first entry is blocked; a
  // form already frozen for this session stays open. Mirrors
  // `GoalFormRoute` (app/goal-add.tsx) / `PlannedFormRoute`.
  if (!frozenGoalRef.current && pendingGoalOps.has(goalId)) {
    return (
      <ModalScreen title={title} onClose={() => router.back()} scroll={false}>
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: spacing.xl,
            gap: spacing.md,
          }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text, textAlign: 'center' }}>
            지금은 저축/인출할 수 없어요
          </Text>
          <Text
            style={{
              fontFamily: fontFamily.regular,
              fontSize: 13,
              color: colors.textSub,
              textAlign: 'center',
              lineHeight: 19,
            }}
          >
            {pendingGoalOps.get(goalId)?.failed
              ? '전송에 실패한 변경이 있어요. 저축 목표 화면에서 다시 시도해 주세요.'
              : '전송 대기 중인 변경이 있어요. 반영된 뒤에 다시 시도할 수 있어요.'}
          </Text>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
              목록으로 돌아가기
            </Text>
          </Pressable>
        </View>
      </ModalScreen>
    );
  }

  const liveGoal = goals.find((g) => g.id === goalId) ?? null;
  if (!frozenGoalRef.current && liveGoal) frozenGoalRef.current = liveGoal;
  if (frozenGoalRef.current) {
    return <GoalMovementForm key={`${goalId}-${mode}`} goal={frozenGoalRef.current} mode={mode} />;
  }

  if (status !== 'ready') {
    return (
      <ModalScreen title={title} onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  // Never resolved for this session — the goal genuinely isn't here.
  return (
    <ModalScreen title={title} onClose={() => router.back()} scroll={false}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: spacing.xl,
          gap: spacing.md,
        }}
      >
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text, textAlign: 'center' }}>
          저축 목표를 찾을 수 없어요
        </Text>
        <Text
          style={{
            fontFamily: fontFamily.regular,
            fontSize: 13,
            color: colors.textSub,
            textAlign: 'center',
            lineHeight: 19,
          }}
        >
          이미 삭제됐거나 다른 우리집의 목표일 수 있어요.
        </Text>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
            목록으로 돌아가기
          </Text>
        </Pressable>
      </View>
    </ModalScreen>
  );
}

function GoalMovementForm({ goal, mode }: { goal: Goal; mode: GoalMovementMode }) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { status, refresh } = useFinanceRead();
  // STEP 16-H2-G3: durable offline fallback for a deposit/withdraw whose
  // direct write hit a TRANSPORT failure (offline). Never used for a
  // server/terminal verdict.
  const pending = usePendingWrites();

  const isWithdraw = mode === 'withdraw';
  const title = isWithdraw ? '인출하기' : '저축하기';

  // Client-generated movement id, minted ONCE per sheet mount and reused on
  // EVERY save retry (STEP 16-G2-D3 §9) — including a durable-queue replay
  // (the coordinator forwards this SAME id verbatim). A fresh id on retry
  // would let trg_apply_goal_movement apply the delta twice; the SAME id
  // makes a lost-response retry hit addGoalMovement's own 23505-by-content
  // reconcile and stay an idempotent no-op.
  const movementIdRef = useRef(uid('gm'));
  // FROZEN — the goal's `saved` this sheet opened against (`goal` is itself
  // already a frozen prop for the life of this mount — see
  // `GoalMovementFormRoute`). Used ONLY as this queue's own ack-check input
  // (never sent to the server, which has no optimistic-concurrency
  // parameter on a movement at all) — STEP 16-H2-G3 §2's "freeze at open,
  // never re-read on retry" discipline, generalized to movements.
  const baselineSavedRef = useRef(goal.saved);

  const [amount, setAmount] = useState('');
  const [padVisible, setPadVisible] = useState(true);

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const magnitude = parseNum(amount);
  const withdrawBlocked = isWithdraw && goal.saved <= 0;
  const overSaved = isWithdraw && goal.saved > 0 && magnitude > goal.saved;
  const canSave =
    Number.isInteger(magnitude) && magnitude > 0 && !withdrawBlocked && !submitting;

  const onKey = (k: string) => setAmount((a) => applyDigit(a, k));

  /**
   * STEP 16-H2-G3: a durable-enqueue that itself failed — the change is NOT
   * queued, so the sheet stays open and the user is told why. Raw
   * coordinator reasons are never surfaced. Mirrors goal-add / planned-add.
   */
  const enqueueFailMessage = (reason: Exclude<EnqueueOutcome, { ok: true }>['reason']): string => {
    switch (reason) {
      case 'not-hydrated':
        return '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.';
      case 'persist':
        return '저축 내역을 기기에 저장하지 못했어요. 다시 시도해주세요.';
      case 'cap':
        return '전송 대기 중인 항목이 너무 많아요. 인터넷 연결 후 다시 시도해주세요.';
      case 'existing-pending':
        return '이미 전송 대기 중인 변경이 있어요.';
    }
  };

  const save = async () => {
    if (submittingRef.current || !canSave) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    submittingRef.current = true;
    setSubmitting(true);

    const res = await addGoalMovement({
      movementId: movementIdRef.current, // unchanged on retry
      householdId: activeHousehold.id,
      goalId: goal.id,
      expectedUserId: session.user.id,
      draft: { mode, amount: magnitude },
    });

    if (res.ok) {
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show(isWithdraw ? '인출했어요' : '저축했어요');
      router.back();
      return;
    }

    // STEP 16-H2-G3: a TRANSPORT failure (offline) -> durable movement queue.
    // The SAME stable movement id (movementIdRef, never regenerated) and the
    // SAME frozen baseline go into the PendingWrite, so a later flush
    // replays the exact request and its 23505-by-content reconcile stays
    // idempotent — no duplicate deposit/withdrawal accident on a lost
    // response.
    if (res.transport === true) {
      const enq = await pending.enqueueGoalMovementCreate({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: movementIdRef.current,
        goalId: goal.id,
        payload: { mode, amount: magnitude },
        expectedBaselineSaved: baselineSavedRef.current,
      });
      submittingRef.current = false;
      setSubmitting(false);
      if (enq.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show(
          (isWithdraw ? '인출했어요' : '저축했어요') + ' · 인터넷에 연결되면 자동으로 반영할게요',
        );
        router.back();
        return;
      }
      toast.show(enqueueFailMessage(enq.reason));
      return;
    }

    submittingRef.current = false;
    setSubmitting(false);
    if (
      res.reason === 'identity' ||
      res.reason === 'error' ||
      res.reason === 'invalid' ||
      res.reason === 'insufficient'
    ) {
      toast.show(res.message); // keep the sheet open with the amount
      return;
    }
    // gone / deleted / conflict — reload and leave.
    await refresh();
    toast.show(res.message);
    router.back();
  };

  return (
    <ModalScreen
      title={title}
      closeIcon="x"
      onClose={() => router.back()}
      right={
        <HeaderTextButton
          label={submitting ? '저장 중…' : '저장'}
          onPress={() => void save()}
          disabled={!canSave}
        />
      }
      footer={
        padVisible ? (
          <NumPad
            style={{ paddingBottom: insets.bottom + 16 }}
            onKey={onKey}
            onBackspace={() => onKey('back')}
            onDone={() => setPadVisible(false)}
          />
        ) : undefined
      }
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xs }}>
        <View
          style={{
            padding: spacing.lg,
            marginBottom: spacing.lg,
            backgroundColor: colors.track,
            borderRadius: radii.md,
          }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text }}>{goal.name}</Text>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub, marginTop: 4, ...tabularNums }}>
            지금까지 모은 금액 {fmt(goal.saved)}원
          </Text>
        </View>

        <Field label={isWithdraw ? '인출할 금액' : '저축할 금액'}>
          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              setPadVisible(true);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              width: '100%',
              paddingVertical: 12,
              paddingHorizontal: 14,
              backgroundColor: padVisible ? colors.primaryLighter : colors.white,
              borderWidth: 1,
              borderColor: padVisible ? colors.primaryLight : colors.border,
              borderRadius: radii.md,
            }}
          >
            <Text
              style={{
                flex: 1,
                fontFamily: fontFamily.semibold,
                fontSize: 16,
                color: amount ? colors.text : padVisible ? colors.primaryStrong : colors.textMuted,
                ...tabularNums,
              }}
            >
              {amount ? fmt(Number(amount)) : '0'}
            </Text>
            <Text
              style={{
                fontFamily: fontFamily.medium,
                fontSize: 14,
                color: padVisible ? colors.primaryStrong : colors.textSub,
                marginLeft: 6,
              }}
            >
              원
            </Text>
          </Pressable>
        </Field>

        {withdrawBlocked && (
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.expenseText, marginTop: -6 }}>
            아직 모은 금액이 없어서 인출할 수 없어요.
          </Text>
        )}
        {overSaved && (
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.warningText, marginTop: -6 }}>
            현재 모은 금액보다 큰 금액이에요. 저장 시 반영되지 않을 수 있어요.
          </Text>
        )}
      </View>
    </ModalScreen>
  );
}
