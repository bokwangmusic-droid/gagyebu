import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { ChipSelect, Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { getAllCats } from '@/data/categories';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, parseNum, toDateKey } from '@/lib/format';
import { uid } from '@/lib/id';
import {
  isValidDateKey,
  type NewPlannedExpenseDraft,
} from '@/lib/remotePlannedWriteMapping';
import type { RemotePlannedMeta } from '@/lib/remoteFinanceMapping';
import { createPlanned, softDeletePlanned, updatePlanned } from '@/services/remotePlannedWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import type { PlannedExpense } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

/**
 * Route entry for /planned-add — STEP 16-G2-D1.
 *
 *   /planned-add             -> new planned-expense form (plannedCreate)
 *   /planned-add?id=<pid>    -> edit form               (plannedEdit)
 *
 * Either capability off -> ReadOnlyRouteNotice. Capability + param checks
 * live in this thin wrapper (card-add / budget-add pattern) so PlannedForm
 * keeps an unconditional hook order. Expo Router can hand back
 * `string | string[]`, so both are handled.
 */
export default function PlannedAddRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;

  if (idParam) {
    if (!REMOTE_FINANCE_WRITE.plannedEdit) return <ReadOnlyRouteNotice title="예정 지출 수정" />;
    return <PlannedFormRoute editId={idParam} />;
  }
  if (!REMOTE_FINANCE_WRITE.plannedCreate) return <ReadOnlyRouteNotice title="예정 지출" />;
  return <PlannedForm key="create" mode={{ kind: 'create' }} />;
}

type FormMode =
  | { kind: 'create' }
  | { kind: 'edit'; planned: PlannedExpense; meta: RemotePlannedMeta };

/**
 * Resolves the edit target and its concurrency metadata from
 * useFinanceRead() — NEVER useStore(). The form only mounts once its
 * `mode` is fully known, so its hooks stay unconditional; the `key` forces
 * a clean remount when the target changes. A stale/unknown id shows a safe
 * notice — it never silently falls back to create mode.
 */
function PlannedFormRoute({ editId }: { editId: string }) {
  const router = useRouter();
  const { status, error, planned, plannedMeta, refresh } = useFinanceRead();

  // STEP 16-G3-B2 §17-21: freeze the first resolved row + token for the
  // edit session so a later Realtime / foreground refresh that drops the
  // row can't unmount the open form and lose the draft — the save's
  // optimistic-concurrency check decides deleted / gone / conflict.
  const frozenRef = useRef<{ planned: PlannedExpense; meta: RemotePlannedMeta } | null>(null);
  const liveTarget = planned.find((p) => p.id === editId) ?? null;
  const liveMeta = plannedMeta[editId] ?? null;
  if (!frozenRef.current && liveTarget && liveMeta) {
    frozenRef.current = { planned: liveTarget, meta: liveMeta };
  }
  if (frozenRef.current) {
    return (
      <PlannedForm
        key={editId}
        mode={{ kind: 'edit', planned: frozenRef.current.planned, meta: frozenRef.current.meta }}
      />
    );
  }

  if (status !== 'ready') {
    return (
      <ModalScreen title="예정 지출 수정" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }
  if (!liveTarget) {
    return (
      <EditUnavailable
        body="이미 삭제됐거나 다른 우리집의 예정 지출일 수 있어요."
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
    <ModalScreen title="예정 지출 수정" onClose={() => router.back()} scroll={false}>
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
          예정 지출을 찾을 수 없어요
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

function PlannedForm({ mode }: { mode: FormMode }) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  // Household finance READ values come ONLY from the remote read-only
  // source — never useStore(). No local addPlanned/updatePlanned is ever
  // called from this screen.
  const { status, error, customCats, catOrder, refresh } = useFinanceRead();

  const editing = mode.kind === 'edit' ? mode.planned : null;
  const isEdit = mode.kind === 'edit';

  // `type` is fixed for the life of a planned item: new items are always
  // 'expense' (the UI has no type picker); an edit preserves whatever the
  // row already had (a legacy 'income' item stays income) and never sends
  // `type` in the PATCH body.
  const formType = editing?.type ?? 'expense';
  const cats = getAllCats(formType, customCats, catOrder);

  // Concurrency token captured ONCE at mount from the meta this form was
  // built with — a later background refresh must never swap it out
  // (STEP 16-G2-D1 §6).
  const expectedUpdatedAtRef = useRef(mode.kind === 'edit' ? mode.meta.updatedAt : null);
  // Client-generated id for CREATE only, minted ONCE per form mount and
  // reused on every retry (23505-hardened idempotency in createPlanned()).
  const plannedIdRef = useRef(uid('p'));

  const [name, setName] = useState(editing?.name ?? '');
  const [amount, setAmount] = useState(editing ? String(editing.amount) : '');
  // Prefill the RAW stored category id (even one whose custom category was
  // later deleted). ChipSelect simply won't highlight a missing option; on
  // save we send whatever is in state, so an unchanged category is never
  // silently rewritten to "기타" (STEP 16-G2-D1 §10).
  const [category, setCategory] = useState(editing?.category ?? 'gift');
  const [date, setDate] = useState(
    editing?.date ?? (() => toDateKey(new Date(Date.now() + 7 * 86_400_000)))(),
  );
  const [memo, setMemo] = useState(editing?.memo ?? '');
  // The amount uses the app's custom keypad (same as app/input.tsx), not the
  // OS number keyboard. Closed by default so the "무엇에" field is reachable first.
  const [padVisible, setPadVisible] = useState(false);

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);

  const canSave = name.trim().length > 0 && parseNum(amount) > 0;
  const busy = submitting || deleting;

  // Digit-entry rules copied verbatim from the main expense keypad so the two
  // feel identical (10-digit cap, no leading zero, 00 shortcut).
  const onKey = (k: string) => {
    if (k === 'back') {
      setAmount((a) => a.slice(0, -1));
      return;
    }
    if (k === '00') {
      setAmount((a) => (a === '' || a === '0' || a.length >= 9 ? a : a + '00'));
      return;
    }
    if (k === '0') {
      setAmount((a) => (a === '' || a === '0' || a.length >= 10 ? a : a + '0'));
      return;
    }
    setAmount((a) => (a.length >= 10 ? a : (a === '0' ? '' : a) + k));
  };

  const openPad = () => {
    Keyboard.dismiss(); // tear down the OS keyboard from a text field first
    setPadVisible(true);
  };

  /** Draft-state -> NewPlannedExpenseDraft, or null when the form isn't valid. */
  const buildDraft = (): NewPlannedExpenseDraft | null => {
    // Defensive re-validation — do NOT lean on the DB CHECK for UX.
    const n = name.trim();
    if (n.length === 0) return null;
    const amt = parseNum(amount);
    if (!Number.isFinite(amt) || amt <= 0) return null;
    if (!category) return null;
    if (!isValidDateKey(date)) return null;
    return { name: n, amount: amt, category, date, memo: memo.trim(), type: formType };
  };

  const save = async () => {
    if (submittingRef.current || deletingRef.current || !canSave) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    const draft = buildDraft();
    if (!draft) {
      toast.show('예정 지출 정보를 확인해 주세요.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    if (mode.kind === 'create') {
      const res = await createPlanned({
        id: plannedIdRef.current, // unchanged on retry — reuses the same id
        householdId: activeHousehold.id,
        expectedUserId: session.user.id,
        draft,
      });
      if (!res.ok) {
        submittingRef.current = false;
        setSubmitting(false);
        toast.show(res.message);
        return;
      }
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('예정 지출을 추가했어요');
      router.back();
      return;
    }

    // ---- edit ---- expectedUpdatedAt is the token captured at MOUNT.
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      submittingRef.current = false;
      setSubmitting(false);
      toast.show('예정 지출 정보를 다시 불러와 주세요.');
      return;
    }
    const res = await updatePlanned({
      id: mode.planned.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
      draft,
    });
    if (!res.ok) {
      submittingRef.current = false;
      setSubmitting(false);
      if (res.reason === 'identity' || res.reason === 'error' || res.reason === 'invalid') {
        toast.show(res.message); // keep the form open with the user's input
        return;
      }
      // conflict / deleted / gone — reload authoritative data and leave the
      // stale form rather than let it overwrite.
      await refresh();
      toast.show(res.message);
      router.back();
      return;
    }
    await refresh();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    toast.show('예정 지출을 수정했어요');
    router.back();
  };

  const confirmDelete = () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    Alert.alert('예정 지출을 삭제할까요?', '실제 거래 내역에는 영향을 주지 않아요.', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => void doDelete() },
    ]);
  };

  const doDelete = async () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      toast.show('예정 지출 정보를 다시 불러와 주세요.');
      return;
    }

    deletingRef.current = true;
    setDeleting(true);

    const res = await softDeletePlanned({
      id: mode.planned.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    if (res.ok) {
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('예정 지출을 삭제했어요');
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

  // Same finance-read gate as every other remote finance screen.
  if (status !== 'ready') {
    return (
      <ModalScreen title={isEdit ? '예정 지출 수정' : '예정 지출 추가'} onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <ModalScreen
      title={isEdit ? '예정 지출 수정' : '예정 지출 추가'}
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

        <Field label="무엇에 쓸 예정인가요?">
          <TextField
            value={name}
            onChangeText={setName}
            onFocus={() => setPadVisible(false)}
            placeholder="예: 결혼식 축의금, 부모님 생신 선물"
            maxLength={30}
          />
        </Field>
        <Field label="예상 금액">
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
                color: amount
                  ? colors.text
                  : padVisible
                    ? colors.primaryStrong
                    : colors.textMuted,
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
        <Field label="예정 날짜" hint="이 날짜가 되면 홈에서 알려드려요">
          <DateStepper value={date} onChange={setDate} />
        </Field>
        <Field label="카테고리">
          <ChipSelect
            value={category}
            onChange={setCategory}
            options={cats.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
        <Field label="메모 (선택)">
          <TextField
            value={memo}
            onChangeText={setMemo}
            onFocus={() => setPadVisible(false)}
            placeholder="예: 고등학교 친구 결혼식"
            maxLength={40}
          />
        </Field>
      </View>
    </ModalScreen>
  );
}
