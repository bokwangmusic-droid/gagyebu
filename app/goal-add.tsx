import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, parseNum, toDateKey } from '@/lib/format';
import { uid } from '@/lib/id';
import type { RemoteGoalMeta } from '@/lib/remoteFinanceMapping';
import { isValidDateKey } from '@/lib/remotePlannedWriteMapping';
import type { NewGoalDraft } from '@/lib/remoteGoalWriteMapping';
import type { EnqueueOutcome } from '@/services/offlineQueue/coordinator';
import { createGoal, softDeleteGoal, updateGoal } from '@/services/remoteGoalWrite';
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

const ICONS: { id: string; label: string }[] = [
  { id: 'target', label: '기본' },
  { id: 'plane', label: '여행' },
  { id: 'shield', label: '비상금' },
  { id: 'laptop', label: '전자' },
  { id: 'heart', label: '선물' },
  { id: 'home', label: '집' },
];

/**
 * Route entry for /goal-add — STEP 16-G2-D3.
 *
 *   /goal-add            -> new goal form (goalCreate)
 *   /goal-add?id=<gid>   -> edit form     (goalEdit)
 *
 * Either capability off -> ReadOnlyRouteNotice. Thin wrapper (planned-add /
 * card-add pattern) so GoalForm keeps an unconditional hook order.
 */
export default function GoalAddRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;

  if (idParam) {
    if (!REMOTE_FINANCE_WRITE.goalEdit) return <ReadOnlyRouteNotice title="목표 수정" />;
    return <GoalFormRoute editId={idParam} />;
  }
  if (!REMOTE_FINANCE_WRITE.goalCreate) return <ReadOnlyRouteNotice title="저축 목표" />;
  return <GoalForm key="create" mode={{ kind: 'create' }} />;
}

type FormMode =
  | { kind: 'create' }
  | { kind: 'edit'; goal: Goal; meta: RemoteGoalMeta };

/**
 * Resolves the edit target + its concurrency metadata from useFinanceRead()
 * — NEVER useStore(). Form only mounts once `mode` is fully known; `key`
 * forces a clean remount when the target changes. A stale/unknown id shows
 * a safe notice — never silently falls back to create mode.
 */
function GoalFormRoute({ editId }: { editId: string }) {
  const router = useRouter();
  const { status, error, goals, goalMeta, pendingGoalOps, refresh } = useFinanceRead();

  // STEP 16-G3-B2 §17-21: freeze the first resolved goal + token for the
  // edit session so a later Realtime / foreground refresh that drops the
  // row can't unmount the open form and lose the draft — the save's
  // optimistic-concurrency check decides deleted / gone / conflict.
  const frozenRef = useRef<{ goal: Goal; meta: RemoteGoalMeta } | null>(null);

  // STEP 16-H2-G3-B: a row with an in-flight / terminal-failed offline op is
  // read-only — never open the edit form on top of a queued write (a second
  // concurrent UPDATE for the same id would just be refused as
  // `existing-pending` by the queue's dedup, but the user shouldn't reach
  // that dead end at all). Checked BEFORE the freeze below so a first entry
  // is blocked; a form already frozen for this session stays open. Mirrors
  // PlannedFormRoute (app/planned-add.tsx) — same guard, same wording shape.
  if (!frozenRef.current && pendingGoalOps.has(editId)) {
    return (
      <EditUnavailable
        body={
          pendingGoalOps.get(editId)?.failed
            ? '전송에 실패한 변경이 있어요. 저축 목표 화면에서 다시 시도해 주세요.'
            : '전송 대기 중인 변경이 있어요. 반영된 뒤에 수정할 수 있어요.'
        }
        onRetry={() => void refresh()}
      />
    );
  }

  const liveTarget = goals.find((g) => g.id === editId) ?? null;
  const liveMeta = goalMeta[editId] ?? null;
  if (!frozenRef.current && liveTarget && liveMeta) {
    frozenRef.current = { goal: liveTarget, meta: liveMeta };
  }
  if (frozenRef.current) {
    return (
      <GoalForm
        key={editId}
        mode={{ kind: 'edit', goal: frozenRef.current.goal, meta: frozenRef.current.meta }}
      />
    );
  }

  if (status !== 'ready') {
    return (
      <ModalScreen title="목표 수정" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }
  if (!liveTarget) {
    return (
      <EditUnavailable
        body="이미 삭제됐거나 다른 우리집의 저축 목표일 수 있어요."
        onRetry={() => void refresh()}
      />
    );
  }
  // liveTarget but no meta -> a safe concurrency-guarded edit is impossible.
  return <EditUnavailable body="잠시 후 다시 시도해 주세요." onRetry={() => void refresh()} />;
}

function EditUnavailable({ body, onRetry }: { body: string; onRetry: () => void }) {
  const router = useRouter();
  return (
    <ModalScreen title="목표 수정" onClose={() => router.back()} scroll={false}>
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
          {body}
        </Text>
        <Pressable onPress={onRetry} hitSlop={8}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
            다시 불러오기
          </Text>
        </Pressable>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={{ fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textSub }}>
            목록으로 돌아가기
          </Text>
        </Pressable>
      </View>
    </ModalScreen>
  );
}

function GoalForm({ mode }: { mode: FormMode }) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  // Household finance READ values come ONLY from the remote read-only
  // source — never useStore(). No local addGoal/updateGoal is ever called.
  const { status, error, refresh } = useFinanceRead();
  // STEP 16-H2-G2/G3: durable offline fallback for a goal CREATE / UPDATE
  // whose direct write hit a TRANSPORT failure (offline). Never used for a
  // server/terminal verdict, and never for delete — that stays direct-only
  // this step.
  const pending = usePendingWrites();

  const editing = mode.kind === 'edit' ? mode.goal : null;
  const isEdit = mode.kind === 'edit';

  // Concurrency token captured ONCE at mount from the meta this form was
  // built with — a later background refresh (e.g. after someone deposits)
  // must never swap it out (STEP 16-G2-D3 §10/§13).
  const expectedUpdatedAtRef = useRef(mode.kind === 'edit' ? mode.meta.updatedAt : null);
  // Client-generated id for CREATE only, minted ONCE per form mount and
  // reused on every retry (23505-hardened idempotency in createGoal()).
  const goalIdRef = useRef(uid('goal'));

  const [name, setName] = useState(editing?.name ?? '');
  const [target, setTarget] = useState(editing ? String(editing.target) : '');
  const [useDeadline, setUseDeadline] = useState(!!editing?.deadline);
  const [deadline, setDeadline] = useState(
    editing?.deadline ?? (() => toDateKey(new Date(Date.now() + 90 * 86_400_000)))(),
  );
  const [icon, setIcon] = useState(editing?.icon ?? 'target');
  // 목표 금액은 앱 전용 키패드(NumPad)로 입력. `saved`(모은 금액) 입력 필드는 없음.
  const [padVisible, setPadVisible] = useState(false);

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);

  const canSave = name.trim().length > 0 && parseNum(target) > 0;
  const busy = submitting || deleting;

  /**
   * STEP 16-H2-G2: a durable-enqueue that itself failed — the change is NOT
   * queued, so the form stays open and the user is told why. Raw coordinator
   * reasons are never surfaced. Mirrors planned-add / card-add.
   */
  const enqueueFailMessage = (reason: Exclude<EnqueueOutcome, { ok: true }>['reason']): string => {
    switch (reason) {
      case 'not-hydrated':
        return '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.';
      case 'persist':
        return '저축 목표를 기기에 저장하지 못했어요. 다시 시도해주세요.';
      case 'cap':
        return '전송 대기 중인 항목이 너무 많아요. 인터넷 연결 후 다시 시도해주세요.';
      case 'existing-pending':
        return '이미 전송 대기 중인 변경이 있어요.';
    }
  };

  const onKey = (k: string) => setTarget((a) => applyDigit(a, k));
  const openPad = () => {
    Keyboard.dismiss();
    setPadVisible(true);
  };

  /** Draft-state -> NewGoalDraft, or null when the form isn't valid. */
  const buildDraft = (): NewGoalDraft | null => {
    const n = name.trim();
    if (n.length === 0) return null;
    const t = parseNum(target);
    if (!Number.isFinite(t) || !Number.isInteger(t) || t <= 0) return null;
    if (!icon) return null;
    if (useDeadline && !isValidDateKey(deadline)) return null;
    return { name: n, target: t, deadline: useDeadline ? deadline : null, icon };
  };

  const save = async () => {
    if (submittingRef.current || deletingRef.current || !canSave) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    const draft = buildDraft();
    if (!draft) {
      toast.show('저축 목표 정보를 확인해 주세요.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    if (mode.kind === 'create') {
      const res = await createGoal({
        id: goalIdRef.current, // unchanged on retry — reuses the same id
        householdId: activeHousehold.id,
        expectedUserId: session.user.id,
        draft,
      });
      if (!res.ok) {
        // STEP 16-H2-G2: a TRANSPORT failure (offline) -> durable CREATE
        // queue. The SAME stable client id (goalIdRef, never regenerated) and
        // the SAME draft go into the PendingWrite, so a later flush replays
        // the exact request and its 23505 reconcile stays idempotent — no
        // duplicate-goal accident on a lost response. `draft` never carries
        // `saved` — the queue payload is identical to the direct-write draft.
        if (res.transport === true) {
          const enq = await pending.enqueueGoalCreate({
            scope: { userId: session.user.id, householdId: activeHousehold.id },
            entityId: goalIdRef.current,
            payload: draft,
          });
          submittingRef.current = false;
          setSubmitting(false);
          if (enq.ok) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            toast.show('목표를 추가했어요 · 인터넷에 연결되면 자동으로 반영할게요');
            router.back();
            return;
          }
          toast.show(enqueueFailMessage(enq.reason));
          return;
        }
        // A non-transport terminal failure — existing behaviour: message +
        // stay. goalIdRef is unchanged so a manual retry reuses the same id.
        submittingRef.current = false;
        setSubmitting(false);
        toast.show(res.message);
        return;
      }
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('목표를 추가했어요');
      router.back();
      return;
    }

    // ---- edit ---- expectedUpdatedAt is the token captured at MOUNT.
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      submittingRef.current = false;
      setSubmitting(false);
      toast.show('저축 목표 정보를 다시 불러와 주세요.');
      return;
    }
    const res = await updateGoal({
      id: mode.goal.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
      draft,
    });
    if (!res.ok) {
      // STEP 16-H2-G3: a TRANSPORT failure (offline) -> durable UPDATE queue
      // with the FROZEN mount token (`token`, captured once at mount — NEVER
      // re-read here or on a later retry) verbatim, so the optimistic-
      // concurrency check still fires as a conflict when the flush runs if
      // someone else changed the goal meanwhile. `draft` never carries
      // `saved` — identical to the direct-write payload.
      if (res.transport === true) {
        const enq = await pending.enqueueGoalUpdate({
          scope: { userId: session.user.id, householdId: activeHousehold.id },
          entityId: mode.goal.id,
          payload: draft,
          expectedUpdatedAt: token,
        });
        submittingRef.current = false;
        setSubmitting(false);
        if (enq.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          toast.show('목표를 수정했어요 · 인터넷에 연결되면 자동으로 반영할게요');
          router.back();
          return;
        }
        toast.show(enqueueFailMessage(enq.reason));
        return;
      }
      submittingRef.current = false;
      setSubmitting(false);
      if (res.reason === 'identity' || res.reason === 'error' || res.reason === 'invalid') {
        toast.show(res.message); // keep the form open with the user's input
        return;
      }
      // conflict / deleted / gone — reload authoritative data and leave the
      // stale form rather than let it overwrite (this is the intended
      // protection when a deposit happened while the form was open, §13).
      await refresh();
      toast.show(res.message);
      router.back();
      return;
    }
    await refresh();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    toast.show('목표를 수정했어요');
    router.back();
  };

  const confirmDelete = () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    Alert.alert('저축 목표를 삭제할까요?', '목표는 목록에서 사라지고 기존 저축 기록은 보존돼요.', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => void doDelete() },
    ]);
  };

  const doDelete = async () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      toast.show('저축 목표 정보를 다시 불러와 주세요.');
      return;
    }

    deletingRef.current = true;
    setDeleting(true);

    const res = await softDeleteGoal({
      id: mode.goal.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    if (res.ok) {
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('저축 목표를 삭제했어요');
      router.back();
      return;
    }

    deletingRef.current = false;
    setDeleting(false);
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    await refresh();
    toast.show(res.message);
    router.back();
  };

  if (status !== 'ready') {
    return (
      <ModalScreen title={isEdit ? '목표 수정' : '목표 추가'} onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <ModalScreen
      title={isEdit ? '목표 수정' : '목표 추가'}
      closeIcon="x"
      onClose={() => router.back()}
      right={
        <HeaderTextButton
          label={submitting ? '저장 중…' : '저장'}
          onPress={() => void save()}
          disabled={!canSave || busy}
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
        {isEdit && (
          <View style={{ alignItems: 'flex-end', marginBottom: spacing.xs }}>
            <Pressable
              onPress={confirmDelete}
              disabled={busy}
              hitSlop={10}
              style={{ padding: 4, opacity: busy ? 0.4 : 1 }}
            >
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.expenseText }}>
                {deleting ? '삭제 중…' : '삭제'}
              </Text>
            </Pressable>
          </View>
        )}

        <Field label="이름">
          <TextField
            value={name}
            onChangeText={setName}
            onFocus={() => setPadVisible(false)}
            placeholder="예: 제주도 여행"
            maxLength={20}
          />
        </Field>
        <Field label="목표 금액">
          <Pressable
            onPress={openPad}
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
                color: target ? colors.text : padVisible ? colors.primaryStrong : colors.textMuted,
                ...tabularNums,
              }}
            >
              {target ? fmt(Number(target)) : '0'}
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
        <Field label="목표 날짜 (선택)">
          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              setPadVisible(false);
              setUseDeadline((v) => !v);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingVertical: 10,
              paddingHorizontal: 14,
              backgroundColor: colors.white,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radii.md,
              marginBottom: useDeadline ? spacing.sm : 0,
            }}
          >
            <AppIcon
              name={useDeadline ? 'target' : 'plus'}
              size={16}
              color={useDeadline ? colors.primaryStrong : colors.textSub}
            />
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 14, color: colors.textSub }}>
              {useDeadline ? '목표일 설정됨 · 탭하여 해제' : '목표일 추가하기'}
            </Text>
          </Pressable>
          {useDeadline && (
            <DateStepper value={deadline} onChange={setDeadline} min={toDateKey(new Date())} />
          )}
        </Field>
        <Field label="아이콘">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {ICONS.map((ic) => {
              const active = icon === ic.id;
              return (
                <Pressable
                  key={ic.id}
                  onPress={() => {
                    Keyboard.dismiss();
                    setPadVisible(false);
                    setIcon(ic.id);
                  }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                    paddingVertical: 8,
                    paddingHorizontal: 12,
                    borderRadius: radii.pill,
                    backgroundColor: active ? colors.primaryLight : colors.white,
                    borderWidth: 1,
                    borderColor: active ? colors.primary : colors.border,
                  }}
                >
                  <AppIcon name={ic.id} size={14} color={active ? colors.primaryStrong : colors.textSub} />
                  <Text
                    style={{
                      fontFamily: active ? fontFamily.semibold : fontFamily.regular,
                      fontSize: 12,
                      color: active ? colors.primaryStrong : colors.text,
                    }}
                  >
                    {ic.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Field>
      </View>
    </ModalScreen>
  );
}
