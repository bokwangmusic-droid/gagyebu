import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import {
  ChipSelect,
  Field,
  HeaderTextButton,
  SegmentedTabs,
  TextField,
} from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { getAllCats, type TxnType } from '@/data/categories';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, parseNum } from '@/lib/format';
import { uid } from '@/lib/id';
import type { RemoteRecurringMeta } from '@/lib/remoteFinanceMapping';
import type { NewRecurringDraft } from '@/lib/remoteRecurringWriteMapping';
import type { EnqueueOutcome } from '@/services/offlineQueue/coordinator';
import {
  createRecurring,
  softDeleteRecurring,
  updateRecurring,
} from '@/services/remoteRecurringWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import type { Frequency, RecurringRule } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * Custom-NumPad scroll assist (STEP 16-G2-D2 UX fix).
 *
 * The NumPad is a `footer` sibling of ModalScreen's ScrollView, so opening
 * it shrinks the scroll viewport but fires no OS-keyboard event — nothing
 * auto-scrolls the tapped field into view.
 *
 * We scroll the MINIMUM amount: only when the tapped field's bottom (plus
 * `NUMPAD_FIELD_BOTTOM_MARGIN` breathing room) would sit below the shrunk
 * viewport, and then by exactly that overflow — so the field lands just
 * above the pad, never pinned to the top, and an already-visible field
 * doesn't move at all.
 *
 * `NUMPAD_SCROLL_CLEARANCE` is a small conditional bottom spacer: it only
 * exists so `scrollTo` has enough scrollable content below the LAST field
 * to actually reach that target (RN clamps scrollTo to
 * contentSize - viewport). It is NOT part of the scroll-amount maths and
 * collapses to 0 once the pad closes, so no lasting mid-screen gap.
 */
const NUMPAD_SCROLL_CLEARANCE = 160;
const NUMPAD_FIELD_BOTTOM_MARGIN = 24;

/** Digit-entry rules — identical to the main expense keypad (app/input.tsx). */
function applyDigit(amount: string, k: string): string {
  if (k === 'back') return amount.slice(0, -1);
  if (k === '00') return amount === '' || amount === '0' || amount.length >= 9 ? amount : amount + '00';
  if (k === '0') return amount === '' || amount === '0' || amount.length >= 10 ? amount : amount + '0';
  return amount.length >= 10 ? amount : (amount === '0' ? '' : amount) + k;
}

/**
 * Day-of-month entry for the 매월 며칠 field: 1–2 digits, no leading zero.
 * The 1–31 clamp still happens only at save (`buildDraft` below), so this
 * only affects what you can type, not what gets stored.
 */
function applyDayDigit(cur: string, k: string): string {
  if (k === 'back') return cur.slice(0, -1);
  if (k === '00') return cur; // single day value — ignore the "00" key
  return cur.length >= 2 ? cur : (cur === '0' ? '' : cur) + k;
}

/**
 * Route entry for /recurring-add — STEP 16-G2-D2.
 *
 *   /recurring-add             -> new recurring-rule form (recurringCreate)
 *   /recurring-add?id=<rid>    -> edit form               (recurringEdit)
 *
 * Either capability off -> ReadOnlyRouteNotice. Capability + param checks
 * live in this thin wrapper (planned-add / card-add pattern) so
 * RecurringForm keeps an unconditional hook order. Expo Router can hand
 * back `string | string[]`, so both are handled. `?type=` seeds only the
 * NEW-form's initial tab.
 */
export default function RecurringAddRoute() {
  const params = useLocalSearchParams<{ id?: string | string[]; type?: string | string[] }>();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;
  const typeParam = Array.isArray(params.type) ? params.type[0] : params.type;

  if (idParam) {
    if (!REMOTE_FINANCE_WRITE.recurringEdit) return <ReadOnlyRouteNotice title="반복 항목 수정" />;
    return <RecurringFormRoute editId={idParam} />;
  }
  if (!REMOTE_FINANCE_WRITE.recurringCreate) return <ReadOnlyRouteNotice title="반복 항목" />;
  return (
    <RecurringForm
      key="create"
      mode={{ kind: 'create', initialType: typeParam === 'income' ? 'income' : 'expense' }}
    />
  );
}

type FormMode =
  | { kind: 'create'; initialType: TxnType }
  | { kind: 'edit'; rule: RecurringRule; meta: RemoteRecurringMeta };

/**
 * Resolves the edit target and its concurrency metadata from
 * useFinanceRead() — NEVER useStore(). The form only mounts once its
 * `mode` is fully known, so its hooks stay unconditional; the `key` forces
 * a clean remount when the target changes. A stale/unknown id shows a safe
 * notice — it never silently falls back to create mode.
 */
function RecurringFormRoute({ editId }: { editId: string }) {
  const router = useRouter();
  const { status, error, recurring, recurringMeta, pendingRecurringOps, refresh } = useFinanceRead();

  // STEP 16-G3-B2 §17-21: freeze the first resolved rule + token for the
  // edit session so a later Realtime / foreground refresh that drops the
  // row can't unmount the open form and lose the draft — the save's
  // optimistic-concurrency check decides deleted / gone / conflict.
  const frozenRef = useRef<{ rule: RecurringRule; meta: RemoteRecurringMeta } | null>(null);
  const liveTarget = recurring.find((r) => r.id === editId) ?? null;
  const liveMeta = recurringMeta[editId] ?? null;

  // STEP 16-H2-F2 §17: a row with an in-flight / terminal-failed offline op
  // (CREATE, FULL UPDATE, ACTIVE toggle, or DELETE) is read-only — never open
  // the edit form on top of a queued write. Checked BEFORE the freeze below
  // so a fresh entry is blocked; a form already frozen for this session
  // stays open. The user resolves it on the Recurring screen first (retry
  // via pull-to-refresh, or "변경 버리기").
  if (!frozenRef.current && pendingRecurringOps.has(editId)) {
    return (
      <EditUnavailable
        body={
          pendingRecurringOps.get(editId)?.failed
            ? '전송에 실패한 변경이 있어요. 반복 항목 화면에서 다시 시도하거나 변경을 버린 뒤 수정해 주세요.'
            : '전송 대기 중인 변경이 있어요. 반영된 뒤에 수정할 수 있어요.'
        }
        onRetry={() => void refresh()}
      />
    );
  }

  if (!frozenRef.current && liveTarget && liveMeta) {
    frozenRef.current = { rule: liveTarget, meta: liveMeta };
  }

  if (frozenRef.current) {
    return (
      <RecurringForm
        key={editId}
        mode={{ kind: 'edit', rule: frozenRef.current.rule, meta: frozenRef.current.meta }}
      />
    );
  }

  if (status !== 'ready') {
    return (
      <ModalScreen title="반복 항목 수정" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }
  if (!liveTarget) {
    return (
      <EditUnavailable
        body="이미 삭제됐거나 다른 우리집의 반복 항목일 수 있어요."
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
    <ModalScreen title="반복 항목 수정" onClose={() => router.back()} scroll={false}>
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
          반복 항목을 찾을 수 없어요
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

function RecurringForm({ mode }: { mode: FormMode }) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  // Household finance READ values come ONLY from the remote read-only
  // source — never useStore(). No local addRecurring/updateRecurring/
  // toggleRecurring/deleteRecurring is ever called from this screen.
  const { status, error, customCats, catOrder, refresh } = useFinanceRead();
  // STEP 16-H2-F2: durable offline fallback for a recurring CREATE / FULL
  // UPDATE / soft DELETE whose direct write hit a TRANSPORT failure
  // (offline). Never used for a server/terminal verdict. The active toggle
  // lives on app/recurring.tsx, not this form.
  const pending = usePendingWrites();

  const editing = mode.kind === 'edit' ? mode.rule : null;
  const isEdit = mode.kind === 'edit';

  // Concurrency token captured ONCE at mount from the meta this form was
  // built with — a later background refresh must never swap it out
  // (STEP 16-G2-D2 §6).
  const expectedUpdatedAtRef = useRef(mode.kind === 'edit' ? mode.meta.updatedAt : null);
  // Client-generated id for CREATE only, minted ONCE per form mount and
  // reused on every retry (23505-hardened idempotency in createRecurring()).
  const recurringIdRef = useRef(uid('rec'));

  // `type` is fixed for the life of a rule: create can choose it, edit shows
  // it read-only and never sends it in the PATCH body (STEP 16-G2-D2 §0.3).
  const [type, setType] = useState<TxnType>(
    editing?.type ?? (mode.kind === 'create' ? mode.initialType : 'expense'),
  );
  const [name, setName] = useState(editing?.name ?? '');
  const [amount, setAmount] = useState(editing ? String(editing.amount) : '');
  // Prefill the RAW stored category id (even one whose custom category was
  // later deleted). ChipSelect just won't highlight a missing option; on
  // save we send whatever is in state, so an unchanged category is never
  // silently rewritten (STEP 16-G2-D2 §10 / same as planned §10).
  const [category, setCategory] = useState(editing?.category ?? 'subscribe');
  const [frequency, setFrequency] = useState<Frequency>(editing?.frequency ?? 'monthly');
  const [dayOfMonth, setDayOfMonth] = useState(
    editing?.dayOfMonth != null ? String(editing.dayOfMonth) : '1',
  );
  const [dayOfWeek, setDayOfWeek] = useState(
    editing?.dayOfWeek != null ? String(editing.dayOfWeek) : '1',
  );
  // 금액·매월 며칠은 OS 숫자 키보드 대신 앱 전용 키패드(NumPad)를 공유해서 입력.
  const [activeField, setActiveField] = useState<'amount' | 'day' | null>(null);

  // ---- Scroll assist for the custom NumPad (see the module constants) ----
  const scrollRef = useRef<ScrollView>(null);
  // Live scroll offset (from onScroll) — a ref: high-frequency, no re-render.
  const scrollYRef = useRef(0);
  // Current scroll viewport height — STATE, because it shrinks when the
  // NumPad footer opens and the scroll effect must re-run with the new value.
  const [viewportH, setViewportH] = useState(0);
  // { y, height } of each NumPad-backed field within the scroll content.
  const fieldRectRef = useRef<Record<'amount' | 'day', { y: number; h: number }>>({
    amount: { y: 0, h: 0 },
    day: { y: 0, h: 0 },
  });
  const onFieldLayout =
    (key: 'amount' | 'day') =>
    (e: LayoutChangeEvent) => {
      const { y, height } = e.nativeEvent.layout;
      fieldRectRef.current[key] = { y, h: height };
    };

  // Opening the custom NumPad fires no OS-keyboard event, so nothing
  // auto-scrolls the tapped field into view. Scroll the MINIMUM: only if the
  // field's bottom + margin would fall below the (already shrunk) viewport,
  // and then by exactly that overflow. Re-runs when `viewportH` changes
  // (i.e. right after the footer opens and shrinks the ScrollView) so the
  // maths always uses the real viewport. Closing the pad does nothing.
  useEffect(() => {
    if (!activeField || viewportH <= 0) return;
    const t = setTimeout(() => {
      const sv = scrollRef.current;
      if (!sv) return;
      const { y: fieldY, h: fieldH } = fieldRectRef.current[activeField];
      if (fieldH <= 0) return;
      const fieldBottom = fieldY + fieldH;
      const visibleBottom = scrollYRef.current + viewportH;
      const overflow = fieldBottom + NUMPAD_FIELD_BOTTOM_MARGIN - visibleBottom;
      if (overflow > 1) {
        sv.scrollTo({ y: scrollYRef.current + overflow, animated: true });
      }
      // overflow <= 1: field already fully visible with margin -> don't move.
    }, 50);
    return () => clearTimeout(t);
  }, [activeField, viewportH]);

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);

  const cats = useMemo(
    () => getAllCats(type, customCats, catOrder),
    [type, customCats, catOrder],
  );

  // CREATE only: switching 지출 <-> 수입 changes the category list, so drop a
  // now-invalid selection to the first option. EDIT never runs this (type is
  // immutable) so a raw/deleted category id is preserved untouched.
  const catIds = cats.map((c) => c.id).join(',');
  const prevCatIdsRef = useRef(catIds);
  if (mode.kind === 'create' && prevCatIdsRef.current !== catIds) {
    prevCatIdsRef.current = catIds;
    if (!cats.some((c) => c.id === category)) setCategory(cats[0]?.id ?? 'subscribe');
  }

  const onKey = (k: string) => {
    if (activeField === 'amount') setAmount((a) => applyDigit(a, k));
    else if (activeField === 'day') setDayOfMonth((d) => applyDayDigit(d, k));
  };
  const openField = (f: 'amount' | 'day') => {
    Keyboard.dismiss();
    setActiveField(f);
  };

  const canSave = name.trim().length > 0 && parseNum(amount) > 0;
  const busy = submitting || deleting;

  /**
   * STEP 16-H2-F2 §1/§16: a durable-enqueue that itself failed — the change
   * is NOT queued, so the form stays open and the user is told why. Raw
   * coordinator reasons are never surfaced. Mirrors card-add / planned-add.
   */
  const enqueueFailMessage = (reason: Exclude<EnqueueOutcome, { ok: true }>['reason']): string => {
    switch (reason) {
      case 'not-hydrated':
        return '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.';
      case 'persist':
        return '반복 항목을 기기에 저장하지 못했어요. 다시 시도해주세요.';
      case 'cap':
        return '전송 대기 중인 항목이 너무 많아요. 인터넷 연결 후 다시 시도해주세요.';
      case 'existing-pending':
        return '이미 전송 대기 중인 변경이 있어요.';
    }
  };

  /** Draft-state -> NewRecurringDraft, or null when the form isn't valid. */
  const buildDraft = (): NewRecurringDraft | null => {
    // Defensive re-validation — do NOT lean on the DB CHECK for UX.
    const n = name.trim();
    if (n.length === 0) return null;
    const amt = parseNum(amount);
    if (!Number.isFinite(amt) || amt <= 0) return null;
    if (!category) return null;

    if (frequency === 'monthly') {
      const dom = Math.min(31, Math.max(1, parseInt(dayOfMonth, 10) || 1));
      return { type, name: n, amount: amt, category, frequency, dayOfMonth: dom, dayOfWeek: null };
    }
    const dow = parseInt(dayOfWeek, 10);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
    return { type, name: n, amount: amt, category, frequency, dayOfMonth: null, dayOfWeek: dow };
  };

  const save = async () => {
    if (submittingRef.current || deletingRef.current || !canSave) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    const draft = buildDraft();
    if (!draft) {
      toast.show('반복 항목 정보를 확인해 주세요.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    if (mode.kind === 'create') {
      const res = await createRecurring({
        id: recurringIdRef.current, // unchanged on retry — reuses the same id
        householdId: activeHousehold.id,
        expectedUserId: session.user.id,
        draft,
      });
      if (!res.ok) {
        // STEP 16-H2-F2 §1: a TRANSPORT failure (offline) -> durable CREATE
        // queue. The SAME stable client id (recurringIdRef, never
        // regenerated) and the SAME draft go into the PendingWrite, so a
        // later flush replays the exact request and its 23505 reconcile
        // stays idempotent — no duplicate-rule accident on a lost response.
        if (res.transport === true) {
          const enq = await pending.enqueueRecurringCreate({
            scope: { userId: session.user.id, householdId: activeHousehold.id },
            entityId: recurringIdRef.current,
            payload: draft,
          });
          submittingRef.current = false;
          setSubmitting(false);
          if (enq.ok) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            toast.show('반복 항목을 추가했어요 · 인터넷에 연결되면 자동으로 반영할게요');
            router.back();
            return;
          }
          toast.show(enqueueFailMessage(enq.reason));
          return;
        }
        submittingRef.current = false;
        setSubmitting(false);
        toast.show(res.message);
        return;
      }
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('반복 항목을 추가했어요');
      router.back();
      return;
    }

    // ---- edit (FULL UPDATE) ---- expectedUpdatedAt is the token captured
    // at MOUNT (never the toggle's — the active toggle lives on
    // app/recurring.tsx and is a SEPARATE op).
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      submittingRef.current = false;
      setSubmitting(false);
      toast.show('반복 항목 정보를 다시 불러와 주세요.');
      return;
    }
    const res = await updateRecurring({
      id: mode.rule.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
      draft,
    });
    if (!res.ok) {
      // STEP 16-H2-F2 §2: a TRANSPORT failure (offline) -> durable FULL
      // UPDATE queue with the FROZEN mount token verbatim, so the
      // optimistic-concurrency check still fires (as a conflict) when the
      // flush runs — the token is NEVER refreshed before enqueue.
      if (res.transport === true) {
        const enq = await pending.enqueueRecurringUpdate({
          scope: { userId: session.user.id, householdId: activeHousehold.id },
          entityId: mode.rule.id,
          payload: draft,
          expectedUpdatedAt: token,
        });
        submittingRef.current = false;
        setSubmitting(false);
        if (enq.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          toast.show('반복 항목을 수정했어요 · 인터넷에 연결되면 자동으로 반영할게요');
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
      // stale form rather than let it overwrite.
      await refresh();
      toast.show(res.message);
      router.back();
      return;
    }
    await refresh();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    toast.show('반복 항목을 수정했어요');
    router.back();
  };

  const confirmDelete = () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    Alert.alert('반복 항목을 삭제할까요?', '이미 기록된 거래에는 영향을 주지 않아요.', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => void doDelete() },
    ]);
  };

  const doDelete = async () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      toast.show('반복 항목 정보를 다시 불러와 주세요.');
      return;
    }

    deletingRef.current = true;
    setDeleting(true);

    const res = await softDeleteRecurring({
      id: mode.rule.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    if (res.ok) {
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('반복 항목을 삭제했어요');
      router.back();
      return;
    }

    // STEP 16-H2-F2 §4: a TRANSPORT failure (offline) -> durable soft-DELETE
    // queue with the FROZEN mount token. `composeRecurringManagement` hides
    // the row from the Recurring screen right away; `data.recurring` stays
    // server-authoritative until the flush lands.
    if (res.transport === true) {
      const enq = await pending.enqueueRecurringDelete({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: mode.rule.id,
        expectedUpdatedAt: token,
      });
      deletingRef.current = false;
      setDeleting(false);
      if (enq.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('반복 항목을 삭제했어요 · 인터넷에 연결되면 자동으로 반영할게요');
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
    toast.show(res.message);
    router.back();
  };

  // Same finance-read gate as every other remote finance screen.
  if (status !== 'ready') {
    return (
      <ModalScreen title={isEdit ? '반복 항목 수정' : '반복 항목 추가'} onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <ModalScreen
      title={isEdit ? '반복 항목 수정' : '반복 항목 추가'}
      closeIcon="x"
      onClose={() => router.back()}
      scrollRef={scrollRef}
      onScrollViewLayout={(e) => setViewportH(e.nativeEvent.layout.height)}
      onScrollViewScroll={(e) => {
        scrollYRef.current = e.nativeEvent.contentOffset.y;
      }}
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

        {isEdit ? (
          // type is immutable after create — show it, don't let it change.
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingVertical: 10,
              paddingHorizontal: 14,
              marginBottom: spacing.lg,
              backgroundColor: colors.track,
              borderRadius: radii.md,
            }}
          >
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>
              {type === 'income' ? '수입' : '지출'}
            </Text>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textMuted }}>
              유형은 수정할 수 없어요
            </Text>
          </View>
        ) : (
          <SegmentedTabs
            value={type}
            onChange={setType}
            options={[
              { value: 'expense', label: '지출', tone: 'expense' },
              { value: 'income', label: '수입', tone: 'income' },
            ]}
            style={{ marginBottom: spacing.lg }}
          />
        )}

        <Field label="이름">
          <TextField
            value={name}
            onChangeText={setName}
            onFocus={() => setActiveField(null)}
            placeholder="예: 넷플릭스, 월세, 8월 급여"
            maxLength={30}
          />
        </Field>
        <View onLayout={onFieldLayout('amount')}>
          <Field label="금액">
            <NumFieldRow
              value={amount ? fmt(Number(amount)) : ''}
              suffix="원"
              active={activeField === 'amount'}
              onPress={() => openField('amount')}
            />
          </Field>
        </View>
        <Field label="카테고리">
          <ChipSelect
            value={category}
            onChange={setCategory}
            options={cats.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
        <Field label="주기">
          <ChipSelect
            value={frequency}
            onChange={(f) => {
              // '매주'로 바꾸면 '매월 며칠' 필드가 사라지므로 그 필드에 붙어
              // 있던 키패드도 닫는다.
              if (f === 'weekly' && activeField === 'day') setActiveField(null);
              setFrequency(f);
            }}
            options={[
              { value: 'monthly', label: '매월' },
              { value: 'weekly', label: '매주' },
            ]}
          />
        </Field>
        {frequency === 'monthly' ? (
          <View onLayout={onFieldLayout('day')}>
            <Field label="매월 며칠" hint="1~31 사이로 정해요">
              <NumFieldRow
                value={dayOfMonth}
                suffix="일"
                active={activeField === 'day'}
                onPress={() => openField('day')}
              />
            </Field>
          </View>
        ) : (
          <Field label="매주 요일">
            <ChipSelect
              value={dayOfWeek}
              onChange={setDayOfWeek}
              options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
            />
          </Field>
        )}

        {/* Reserve scroll room so a lower numeric field can be lifted clear
            of the custom NumPad; collapses to 0 once the pad is closed. */}
        <View style={{ height: activeField ? NUMPAD_SCROLL_CLEARANCE : 0 }} />
      </View>
    </ModalScreen>
  );
}

/**
 * Numeric tap-target that opens the shared NumPad — same visual language as
 * loan-add.tsx / planned-add.tsx (lavender wash + hairline when active).
 */
function NumFieldRow({
  value,
  suffix,
  active,
  onPress,
}: {
  value: string;
  suffix: string;
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
          color: value ? colors.text : active ? colors.primaryStrong : colors.textMuted,
          ...tabularNums,
        }}
      >
        {value || '0'}
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
