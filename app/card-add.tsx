import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { CAT_COLOR_PALETTE } from '@/data/categories';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { parseNum } from '@/lib/format';
import { uid } from '@/lib/id';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { RemoteCardMeta } from '@/lib/remoteFinanceMapping';
import { createCard, softDeleteCard, updateCard } from '@/services/remoteCardWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import type { EnqueueOutcome } from '@/services/offlineQueue/coordinator';
import type { CreditCard } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

/** Clamp a day-of-month string to 1–31; '' when empty. */
function clampDay(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '').slice(0, 2);
  if (digits === '') return '';
  return String(Math.min(31, Math.max(1, parseNum(digits))));
}

/** NumPad key → day string. `clampDay` stays the single 1–31 validator, so
 *  stored values are exactly what the old text field produced. */
function applyDayKey(cur: string, k: string): string {
  if (k === 'back') return clampDay(cur.slice(0, -1));
  if (k === '00') return cur; // a day is 1–2 digits — ignore the "00" key
  return clampDay(cur + k);
}

/**
 * Route entry for /card-add — STEP 16-G2-C2.
 *
 *   /card-add            -> new-card form  (REMOTE_FINANCE_WRITE.cardCreate)
 *   /card-add?id=<card>  -> edit form      (REMOTE_FINANCE_WRITE.cardEdit)
 *
 * Either capability off -> ReadOnlyRouteNotice. The capability + param
 * checks live in this thin wrapper (same pattern as app/input.tsx) so
 * CardForm keeps an unconditional hook order. Expo Router can hand back
 * `string | string[]`, so both are handled.
 */
export default function CardAddRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;

  if (idParam) {
    if (!REMOTE_FINANCE_WRITE.cardEdit) return <ReadOnlyRouteNotice title="카드 수정" />;
    return <CardFormRoute editId={idParam} />;
  }
  if (!REMOTE_FINANCE_WRITE.cardCreate) return <ReadOnlyRouteNotice title="카드 등록" />;
  return <CardForm key="create" mode={{ kind: 'create' }} />;
}

type FormMode =
  | { kind: 'create' }
  | { kind: 'edit'; card: CreditCard; meta: RemoteCardMeta };

/**
 * Resolves the edit target and its concurrency metadata from
 * useFinanceRead() — NEVER useStore(). The form only mounts once its
 * `mode` is fully known, so its hooks stay unconditional; the `key` forces
 * a clean remount when the target changes.
 */
function CardFormRoute({ editId }: { editId: string }) {
  const router = useRouter();
  const { status, error, cards, cardMeta, refresh } = useFinanceRead();

  // STEP 16-G3-B2 §17-21: once this edit session has resolved to a real
  // card + concurrency token, FREEZE that snapshot. A later Realtime /
  // foreground refresh that drops the row (the other member soft-deleted
  // it) must NOT yank the open form and lose the user's in-progress draft —
  // the save's own optimistic-concurrency check (0-row reselect ->
  // deleted / gone / conflict) is what decides the outcome.
  const frozenRef = useRef<{ card: CreditCard; meta: RemoteCardMeta } | null>(null);
  const liveCard = cards.find((c) => c.id === editId) ?? null;
  const liveMeta = cardMeta[editId] ?? null;
  if (!frozenRef.current && liveCard && liveMeta) {
    frozenRef.current = { card: liveCard, meta: liveMeta };
  }
  if (frozenRef.current) {
    return (
      <CardForm
        key={editId}
        mode={{ kind: 'edit', card: frozenRef.current.card, meta: frozenRef.current.meta }}
      />
    );
  }

  // Never resolved for this session -> the ORIGINAL loading / not-found flow.
  if (status !== 'ready') {
    return (
      <ModalScreen title="카드 수정" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }
  if (!liveCard) {
    return (
      <EditUnavailable
        title="카드를 찾을 수 없어요"
        body="이미 삭제됐거나 다른 우리집의 카드일 수 있어요."
        onRetry={() => void refresh()}
      />
    );
  }
  // liveCard exists but no meta -> a safe concurrency-guarded write is
  // impossible; never open the form.
  return (
    <EditUnavailable
      title="카드 정보를 불러오지 못했어요"
      body="잠시 후 다시 시도해 주세요."
      onRetry={() => void refresh()}
    />
  );
}

function EditUnavailable({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry: () => void;
}) {
  const router = useRouter();
  return (
    <ModalScreen title="카드 수정" onClose={() => router.back()} scroll={false}>
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
          {title}
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
      </View>
    </ModalScreen>
  );
}

function CardForm({ mode }: { mode: FormMode }) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  // Household finance READ values (status/refresh) come ONLY from the
  // remote read-only source — never useStore().
  const { status, error, refresh } = useFinanceRead();
  // STEP 16-H2-C2-A2: durable offline fallback for a card CREATE / UPDATE /
  // soft DELETE whose direct write hit a TRANSPORT failure (offline). Never
  // used for a server/terminal verdict.
  const pending = usePendingWrites();

  const editing = mode.kind === 'edit' ? mode.card : null;
  const isEdit = mode.kind === 'edit';

  // Concurrency token captured ONCE at mount from the meta this form was
  // built with — a later background refresh must never swap it out
  // (STEP 16-G2-C2 §21).
  const expectedUpdatedAtRef = useRef(mode.kind === 'edit' ? mode.meta.updatedAt : null);
  // Client-generated id for CREATE only, minted ONCE per form mount and
  // reused on every retry (23505-hardened idempotency in createCard()).
  const cardIdRef = useRef(uid('card'));

  const [name, setName] = useState(editing?.name ?? '');
  const [colorIdx, setColorIdx] = useState(() => {
    if (!editing?.color) return 0;
    const i = CAT_COLOR_PALETTE.findIndex(
      (p) => p.bg === editing.color!.bg && p.color === editing.color!.color,
    );
    return i < 0 ? 0 : i;
  });
  const [paymentDay, setPaymentDay] = useState(
    editing?.paymentDay ? String(editing.paymentDay) : '',
  );
  const [closingDay, setClosingDay] = useState(
    editing?.closingDay ? String(editing.closingDay) : '',
  );
  // 결제일·마감일은 OS 숫자 키보드 대신 앱 전용 키패드(NumPad)를 공유해서 입력.
  const [activeField, setActiveField] = useState<'paymentDay' | 'closingDay' | null>(null);

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);

  const openField = (f: 'paymentDay' | 'closingDay') => {
    Keyboard.dismiss();
    setActiveField(f);
  };
  const onKey = (k: string) => {
    if (activeField === 'paymentDay') setPaymentDay((d) => applyDayKey(d, k));
    else if (activeField === 'closingDay') setClosingDay((d) => applyDayKey(d, k));
  };

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0;

  /** Draft-state -> NewCardDraft, or null when the form isn't valid. */
  const buildDraft = (): NewCardDraft | null => {
    // Defensive re-validation — do NOT lean on DB CHECK for UX.
    if (trimmedName.length === 0) return null;
    if (trimmedName.length > 20) return null;
    const pd = paymentDay ? parseNum(paymentDay) : undefined;
    const cd = closingDay ? parseNum(closingDay) : undefined;
    if (pd !== undefined && (pd < 1 || pd > 31)) return null;
    if (cd !== undefined && (cd < 1 || cd > 31)) return null;
    const palette = CAT_COLOR_PALETTE[colorIdx];
    return {
      name: trimmedName,
      color: palette ? { bg: palette.bg, color: palette.color } : undefined,
      paymentDay: pd,
      closingDay: cd,
    };
  };

  /**
   * STEP 16-H2-C2-A2 §4: a durable-enqueue that itself failed — the change is
   * NOT queued, so the form stays open and the user is told why. Raw
   * coordinator reasons are never surfaced.
   */
  const enqueueFailMessage = (reason: Exclude<EnqueueOutcome, { ok: true }>['reason']): string => {
    switch (reason) {
      case 'not-hydrated':
        return '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.';
      case 'persist':
        return '카드를 기기에 저장하지 못했어요. 다시 시도해주세요.';
      case 'cap':
        return '전송 대기 중인 항목이 너무 많아요. 인터넷 연결 후 다시 시도해주세요.';
      case 'existing-pending':
        return '이미 전송 대기 중인 변경이 있어요.';
    }
  };

  const save = async () => {
    if (submittingRef.current || deletingRef.current || !canSave) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    const draft = buildDraft();
    if (!draft) return;

    submittingRef.current = true;
    setSubmitting(true);

    if (mode.kind === 'create') {
      const res = await createCard({
        id: cardIdRef.current,
        householdId: activeHousehold.id,
        expectedUserId: session.user.id,
        draft,
      });
      if (!res.ok) {
        // STEP 16-H2-C2-A2 §2/§3/§4: a TRANSPORT failure (offline) -> durable
        // CREATE queue. The SAME client id (cardIdRef, never regenerated) and
        // the SAME draft go into the PendingWrite, so a later flush replays
        // the exact request and its 23505 reconcile stays idempotent — no
        // duplicate-card accident on a lost response.
        if (res.transport === true) {
          const enq = await pending.enqueueCardCreate({
            scope: { userId: session.user.id, householdId: activeHousehold.id },
            entityId: cardIdRef.current,
            payload: draft,
          });
          submittingRef.current = false;
          setSubmitting(false);
          if (enq.ok) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            toast.show('카드를 추가했어요 · 인터넷에 연결되면 자동으로 반영할게요');
            router.back();
            return;
          }
          // Durable enqueue failed — DO NOT claim success, keep the form.
          toast.show(enqueueFailMessage(enq.reason));
          return;
        }
        // A non-transport terminal failure — existing behaviour: message +
        // stay. cardIdRef is unchanged so a manual retry reuses the same id.
        submittingRef.current = false;
        setSubmitting(false);
        toast.show(res.message);
        return;
      }
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('카드를 등록했어요');
      router.back();
      return;
    }

    // ---- edit ---- expectedUpdatedAt is the token captured at MOUNT
    // (expectedUpdatedAtRef), never re-fetched — that is what makes the
    // conflict check meaningful, online AND for a queued offline UPDATE
    // (STEP 16-H2-C2-A2 §5).
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      submittingRef.current = false;
      setSubmitting(false);
      toast.show('카드 정보를 다시 불러와 주세요.');
      return;
    }
    const res = await updateCard({
      id: mode.card.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
      draft,
    });
    if (!res.ok) {
      // STEP 16-H2-C2-A2 §6: a TRANSPORT failure (offline) -> durable UPDATE
      // queue with the FROZEN mount token verbatim, so the optimistic-
      // concurrency check still fires (as a conflict) when the flush runs.
      if (res.transport === true) {
        const enq = await pending.enqueueCardUpdate({
          scope: { userId: session.user.id, householdId: activeHousehold.id },
          entityId: mode.card.id,
          payload: draft,
          expectedUpdatedAt: token,
        });
        submittingRef.current = false;
        setSubmitting(false);
        if (enq.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          toast.show('카드를 수정했어요 · 인터넷에 연결되면 자동으로 반영할게요');
          router.back();
          return;
        }
        toast.show(enqueueFailMessage(enq.reason));
        return;
      }
      submittingRef.current = false;
      setSubmitting(false);
      if (res.reason === 'identity' || res.reason === 'error') {
        toast.show(res.message);
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
    toast.show('카드를 수정했어요');
    router.back();
  };

  const confirmDelete = () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    Alert.alert(
      '이 카드를 삭제할까요?',
      '카드 목록에서는 사라지지만 기존 거래 내역은 그대로 남아요.',
      [
        { text: '취소', style: 'cancel' },
        { text: '삭제', style: 'destructive', onPress: () => void doDelete() },
      ],
    );
  };

  const doDelete = async () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      toast.show('카드 정보를 다시 불러와 주세요.');
      return;
    }

    deletingRef.current = true;
    setDeleting(true);

    const res = await softDeleteCard({
      id: mode.card.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    if (res.ok) {
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('카드를 삭제했어요');
      router.back();
      return;
    }

    // STEP 16-H2-C2-A2 §7: a TRANSPORT failure (offline) -> durable soft-DELETE
    // queue with the FROZEN mount token. `composeCardManagement` hides the row
    // from the card-management screen right away; the transaction/card
    // reference truth stays server-authoritative until the flush lands.
    if (res.transport === true) {
      const enq = await pending.enqueueCardDelete({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: mode.card.id,
        expectedUpdatedAt: token,
      });
      deletingRef.current = false;
      setDeleting(false);
      if (enq.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('카드를 삭제했어요 · 인터넷에 연결되면 자동으로 반영할게요');
        router.back();
        return;
      }
      toast.show(enqueueFailMessage(enq.reason));
      return;
    }

    deletingRef.current = false;
    setDeleting(false);
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    await refresh();
    toast.show('다른 곳에서 변경됐거나 삭제된 카드예요. 최신 내용을 불러올게요.');
    router.back();
  };

  // Same finance-read gate as every other remote finance screen.
  if (status !== 'ready') {
    return (
      <ModalScreen title={isEdit ? '카드 수정' : '카드 등록'} onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  const busy = submitting || deleting;

  return (
    <ModalScreen
      title={isEdit ? '카드 수정' : '카드 등록'}
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
        activeField ? (
          <NumPad
            style={{ paddingBottom: insets.bottom + 16 }}
            onKey={onKey}
            onBackspace={() => onKey('back')}
            onDone={() => setActiveField(null)}
          />
        ) : undefined
      }
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xs }}>
        {isEdit && (
          <View style={{ alignItems: 'flex-end', marginBottom: spacing.xs }}>
            <Pressable onPress={confirmDelete} disabled={busy} hitSlop={10} style={{ padding: 4, opacity: busy ? 0.4 : 1 }}>
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.expenseText }}>
                {deleting ? '삭제 중…' : '삭제'}
              </Text>
            </Pressable>
          </View>
        )}

        <Field label="카드 이름">
          <TextField
            value={name}
            onChangeText={setName}
            onFocus={() => setActiveField(null)}
            placeholder="예: 현대카드, 삼성카드"
            maxLength={20}
            autoFocus={!isEdit}
          />
        </Field>

        <Field label="색상 (선택)">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {CAT_COLOR_PALETTE.map((p, i) => {
              const active = i === colorIdx;
              return (
                <Pressable
                  key={p.color}
                  onPress={() => setColorIdx(i)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: radii.pill,
                    backgroundColor: p.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: active ? 2 : 1,
                    borderColor: active ? p.color : colors.border,
                  }}
                >
                  <View
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: radii.pill,
                      backgroundColor: p.color,
                    }}
                  />
                </Pressable>
              );
            })}
          </View>
        </Field>

        <Field label="결제일 (선택)" hint="매월 카드값이 빠져나가는 날 · 표시용">
          <NumFieldRow
            value={paymentDay}
            suffix="일"
            placeholder="1~31"
            active={activeField === 'paymentDay'}
            onPress={() => openField('paymentDay')}
          />
        </Field>

        <Field label="마감일 (선택)" hint="이번 STEP에서는 표시만 하고 계산에는 쓰지 않아요">
          <NumFieldRow
            value={closingDay}
            suffix="일"
            placeholder="1~31"
            active={activeField === 'closingDay'}
            onPress={() => openField('closingDay')}
          />
        </Field>

        <Text
          style={{
            fontFamily: fontFamily.regular,
            fontSize: 11,
            lineHeight: 17,
            color: colors.textMuted,
            marginTop: spacing.xs,
            marginBottom: spacing.xxl,
          }}
        >
          예상 카드값은 카드사 실제 청구일이 아니라 「사용월」 기준으로 계산해요.
          실제 청구서 금액과 다를 수 있어요.
        </Text>
      </View>
    </ModalScreen>
  );
}

/**
 * Numeric tap-target that opens the shared NumPad. Both card day fields are
 * optional, so it shows a muted placeholder (not "0") when empty.
 */
function NumFieldRow({
  value,
  suffix,
  placeholder,
  active,
  onPress,
}: {
  value: string;
  suffix: string;
  placeholder: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        paddingVertical: 12,
        paddingHorizontal: 14,
        backgroundColor: active ? colors.primaryLighter : colors.white,
        borderWidth: 1,
        borderColor: active ? colors.primaryLight : colors.border,
        borderRadius: radii.md,
      }}
    >
      <Text
        style={{
          flex: 1,
          fontFamily: fontFamily.semibold,
          fontSize: 16,
          color: value ? colors.text : colors.textMuted,
        }}
      >
        {value || placeholder}
      </Text>
      <Text
        style={{
          fontFamily: fontFamily.medium,
          fontSize: 14,
          color: active ? colors.primaryStrong : colors.textSub,
          marginLeft: 6,
        }}
      >
        {suffix}
      </Text>
    </Pressable>
  );
}
