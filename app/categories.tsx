import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Field, SegmentedTabs, TextField } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import {
  CAT_COLOR_PALETTE,
  CAT_ICON_PALETTE,
  getAllCats,
  type CatOrderMap,
  type Category,
  type CustomCatMap,
  type IconKey,
  type TxnType,
} from '@/data/categories';
import {
  CATEGORY_DELETE_MSG,
  categoryDeleteFailureToast,
  gateCategoryDelete,
} from '@/lib/categoryDeleteFlow';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { uid } from '@/lib/id';
import { pendingCategoryRowLabel } from '@/lib/pendingCategoryLabel';
import {
  isCategoryNameTaken,
  MAX_CATEGORY_NAME,
  type NewCustomCategoryDraft,
} from '@/lib/remoteCategoryWriteMapping';
import type { RemoteBudgetMeta, RemoteCategoryMeta } from '@/lib/remoteFinanceMapping';
import type { EnqueueOutcome } from '@/services/offlineQueue/coordinator';
import { softDeleteCustomCategoryWithBudget } from '@/services/remoteCategoryBudgetWrite';
import {
  createCustomCategory,
  saveCategoryOrder,
  updateCustomCategory,
} from '@/services/remoteCategoryWrite';
import { useAuth } from '@/store/auth';
import type { FinanceReadResult } from '@/store/financeRead';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import type { BudgetMap } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

const ROW_H = 54;

/**
 * Route entry for /categories — STEP 16-G2-C4-B.
 *
 * Custom category management (create/edit/soft-delete + shared reorder) is
 * a household-shared financial write. Thin wrapper (card-add / budget-add
 * pattern) so CategoriesManager keeps an unconditional hook order.
 */
export default function CategoriesRoute() {
  const anyCap =
    REMOTE_FINANCE_WRITE.categoryCreate ||
    REMOTE_FINANCE_WRITE.categoryEdit ||
    REMOTE_FINANCE_WRITE.categoryDelete ||
    REMOTE_FINANCE_WRITE.categoryReorder;
  if (!anyCap) return <ReadOnlyRouteNotice title="카테고리" />;
  return <CategoriesManagerRoute />;
}

function CategoriesManagerRoute() {
  const router = useRouter();
  const fr = useFinanceRead();

  if (fr.status !== 'ready') {
    return (
      <ModalScreen title="카테고리 관리" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={fr.status} error={fr.error} onRetry={() => void fr.refresh()} />
      </ModalScreen>
    );
  }

  return (
    <CategoriesManager
      customCats={fr.customCats}
      catOrder={fr.catOrder}
      categoryMeta={fr.categoryMeta}
      budgets={fr.budgets}
      budgetMeta={fr.budgetMeta}
      refresh={fr.refresh}
    />
  );
}

type SheetState =
  | { mode: 'create' }
  | { mode: 'edit'; category: Category; expectedUpdatedAt: string };

function CategoriesManager({
  customCats,
  catOrder,
  categoryMeta,
  budgets,
  budgetMeta,
  refresh,
}: {
  customCats: CustomCatMap;
  catOrder: CatOrderMap;
  categoryMeta: Record<string, RemoteCategoryMeta>;
  budgets: BudgetMap;
  budgetMeta: Record<string, RemoteBudgetMeta>;
  refresh: () => Promise<void>;
}) {
  const router = useRouter();
  const toast = useToast();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { status, categoryManagementRows, pendingCategoryOps, pendingBudgetOps } = useFinanceRead();
  // STEP 16-H2-C2-B2: durable offline fallback for a category CREATE / UPDATE
  // whose direct write hit a TRANSPORT failure. DELETE is deliberately NOT
  // wired here — its offline path stays blocked on the Budget queue (§19).
  const pending = usePendingWrites();
  const financeRefresh = useRemoteFinanceRefreshControl();

  const [tab, setTab] = useState<TxnType>('expense');
  const [sheet, setSheet] = useState<SheetState | null>(null);

  // One `c-...` id per CREATE SESSION (STEP 16-G2-C4-B §9): minted when the
  // add sheet opens, reused across save retries for that sheet, discarded
  // when the sheet closes so the NEXT create gets a fresh id.
  const createIdRef = useRef<string | null>(null);

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const deletingRef = useRef(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const reorderBusyRef = useRef(false);

  // STEP 16-H2-C2-B2 §8: the MANAGEMENT list renders `categoryManagementRows`
  // (server customCats + pending CREATE synthetic + NOT-failed pending UPDATE
  // overlay − pending DELETE + failed-orphan synthetic). Every OTHER consumer
  // keeps using `customCats` (authoritative). A synthetic row (no `catOrder`
  // entry) naturally sorts to the end.
  const allCats = getAllCats(tab, categoryManagementRows, catOrder);
  const customIds = new Set(categoryManagementRows[tab].map((c) => c.id));

  // Any row carrying an un-sent offline op — no edit sheet / no delete while
  // in flight or held-failed (discard first).
  const opFor = (id: string) => pendingCategoryOps.get(id);
  const isPendingRow = (id: string) => pendingCategoryOps.has(id);
  // SYNTHETIC = present only because of an op, no authoritative server row
  // behind it (pending/failed CREATE, failed UPDATE whose server row is gone).
  // These must NEVER reach `saveCategoryOrder` (§6/§13). A terminal-failed
  // UPDATE whose authoritative row STILL EXISTS is NOT synthetic — that row
  // stays a normal, reorderable category (conflict-UX fix).
  const isSyntheticRow = (id: string) => opFor(id)?.synthetic === true;

  const canCreate = REMOTE_FINANCE_WRITE.categoryCreate;
  const canEdit = REMOTE_FINANCE_WRITE.categoryEdit;
  const canDelete = REMOTE_FINANCE_WRITE.categoryDelete;
  const canReorder = REMOTE_FINANCE_WRITE.categoryReorder;

  /** "변경 버리기" — drop the local failed UPDATE record; the authoritative
   *  server category is never touched (§3). */
  const discardFailed = (queueId: string) => {
    Alert.alert(
      '실패한 수정 내용을 버릴까요?',
      '다른 기기에 저장된 최신 카테고리는 그대로 유지됩니다.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '버리기',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const r = await pending.discardPending(queueId);
              if (r.ok) toast.show('실패한 수정 내용을 버렸어요');
              else toast.show('변경을 버리지 못했어요. 잠시 후 다시 시도해주세요.');
            })();
          },
        },
      ],
    );
  };

  /**
   * STEP 16-H2-C2-B2 §4: a durable-enqueue that itself failed — the change is
   * NOT queued, so the sheet stays open and the user is told why. Raw
   * coordinator reasons are never surfaced. Mirrors card-add / input.
   */
  const enqueueFailMessage = (reason: Exclude<EnqueueOutcome, { ok: true }>['reason']): string => {
    switch (reason) {
      case 'not-hydrated':
        return '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.';
      case 'persist':
        return '카테고리를 기기에 저장하지 못했어요. 다시 시도해주세요.';
      case 'cap':
        return '전송 대기 중인 항목이 너무 많아요. 인터넷 연결 후 다시 시도해주세요.';
      case 'existing-pending':
        return '이미 전송 대기 중인 변경이 있어요.';
    }
  };

  /** built-in + live custom names of the CURRENT tab, minus an optional self id. */
  const namesForTab = (excludeId?: string) =>
    getAllCats(tab, customCats, catOrder)
      .filter((c) => c.id !== excludeId)
      .map((c) => c.name);

  const ready = status === 'ready' && !!session?.user?.id && !!activeHousehold;

  /* ---------------- create ---------------- */

  const openCreate = () => {
    if (!canCreate) return;
    createIdRef.current = uid('c');
    setSheet({ mode: 'create' });
  };

  const closeSheet = () => {
    if (submittingRef.current) return;
    createIdRef.current = null;
    setSheet(null);
  };

  const doCreate = async (draft: NewCustomCategoryDraft) => {
    if (submittingRef.current || deletingRef.current) return;
    if (!ready || !session?.user?.id || !activeHousehold) return;
    const id = createIdRef.current;
    if (!id) return;

    submittingRef.current = true;
    setSubmitting(true);
    const res = await createCustomCategory({
      id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      draft,
    });

    if (!res.ok) {
      // STEP 16-H2-C2-B2 §2/§3/§4: a TRANSPORT failure (offline) -> durable
      // CREATE queue. The SAME client id (`id` from createIdRef, never
      // regenerated) and the SAME draft go in, so a later flush replays the
      // exact request and its 23505 reconcile stays idempotent — no
      // duplicate-category on a lost response.
      if (res.transport === true) {
        const enq = await pending.enqueueCategoryCreate({
          scope: { userId: session.user.id, householdId: activeHousehold.id },
          entityId: id,
          payload: draft,
        });
        submittingRef.current = false;
        setSubmitting(false);
        if (enq.ok) {
          createIdRef.current = null; // this create session is done -> next opens a fresh c-id
          setSheet(null);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          toast.show('카테고리를 추가했어요 · 인터넷에 연결되면 자동으로 반영할게요');
          return;
        }
        // Durable enqueue failed — DO NOT claim success, keep the sheet.
        toast.show(enqueueFailMessage(enq.reason));
        return;
      }
      submittingRef.current = false;
      setSubmitting(false);
      toast.show(res.reason === 'invalid' ? '카테고리 정보를 확인해 주세요.' : res.message);
      return; // keep the sheet open; createIdRef unchanged so a retry reuses the id
    }
    submittingRef.current = false;
    setSubmitting(false);
    createIdRef.current = null;
    setSheet(null);
    await refresh();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    toast.show('카테고리를 추가했어요');
  };

  /* ---------------- edit ---------------- */

  const openEdit = (cat: Category) => {
    if (!canEdit) return;
    if (isPendingRow(cat.id)) return; // §12: a pending / failed row is read-only
    const meta = categoryMeta[cat.id];
    if (!meta) {
      toast.show('카테고리 정보를 다시 불러온 뒤 수정해 주세요.');
      return;
    }
    setSheet({ mode: 'edit', category: cat, expectedUpdatedAt: meta.updatedAt });
  };

  const doUpdate = async (draft: NewCustomCategoryDraft) => {
    if (submittingRef.current || deletingRef.current) return;
    if (!ready || !session?.user?.id || !activeHousehold) return;
    if (!sheet || sheet.mode !== 'edit') return;

    submittingRef.current = true;
    setSubmitting(true);
    const res = await updateCustomCategory({
      id: sheet.category.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: sheet.expectedUpdatedAt, // captured at sheet open, never re-read
      draft,
    });

    if (res.ok) {
      submittingRef.current = false;
      setSubmitting(false);
      setSheet(null);
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('카테고리를 수정했어요');
      return;
    }
    // STEP 16-H2-C2-B2 §6/§7: a TRANSPORT failure (offline) -> durable UPDATE
    // queue with the FROZEN mount token verbatim, so the optimistic-
    // concurrency check still fires (as a conflict) when the flush runs.
    if (res.transport === true) {
      const enq = await pending.enqueueCategoryUpdate({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: sheet.category.id,
        payload: draft,
        expectedUpdatedAt: sheet.expectedUpdatedAt,
      });
      submittingRef.current = false;
      setSubmitting(false);
      if (enq.ok) {
        setSheet(null);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('카테고리를 수정했어요 · 인터넷에 연결되면 자동으로 반영할게요');
        return;
      }
      toast.show(enqueueFailMessage(enq.reason)); // keep the sheet open
      return;
    }
    submittingRef.current = false;
    setSubmitting(false);
    if (res.reason === 'identity' || res.reason === 'error' || res.reason === 'invalid') {
      toast.show(res.message); // keep the sheet open
      return;
    }
    // conflict / deleted / gone
    setSheet(null);
    await refresh();
    toast.show('다른 곳에서 변경됐거나 삭제된 카테고리예요. 최신 내용을 불러왔어요.');
  };

  /* ---------------- delete (atomic category + budget RPC) ---------------- */

  const confirmDelete = (id: string, name: string) => {
    // STEP 16-G2-C4-B §17 / STEP 16-H2 A3 §11: BOTH tokens are read here, once,
    // BEFORE the Alert — a background refresh must not be able to swap them
    // under us, and `doDelete` never re-reads a fresher token. §9: an un-sent
    // offline BUDGET op for this same category is refused here (no queue merge
    // in A3). All branching lives in the pure `gateCategoryDelete`.
    const gate = gateCategoryDelete({
      canDelete,
      deleting: deletingRef.current,
      categoryRowPending: isPendingRow(id), // §12: a pending / failed row is read-only
      budgetOpPending: pendingBudgetOps.has(id),
      categoryToken: categoryMeta[id]?.updatedAt ?? null,
      hasLiveBudget: Object.prototype.hasOwnProperty.call(budgets, id),
      budgetToken: budgetMeta[id]?.updatedAt ?? null,
    });
    if (!gate.proceed) {
      if (gate.toast) toast.show(gate.toast);
      return;
    }
    const { categoryToken, budgetToken } = gate; // frozen for the Alert closure

    Alert.alert(
      `${name} 카테고리를 삭제할까요?`,
      '이 카테고리로 저장된 기존 기록은 기타로 표시되고, 설정된 예산도 함께 삭제돼요.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: () => void doDelete(id, categoryToken, budgetToken),
        },
      ],
    );
  };

  const doDelete = async (id: string, categoryToken: string, budgetToken: string | null) => {
    if (deletingRef.current || submittingRef.current) return;
    if (!ready || !session?.user?.id || !activeHousehold) return;

    deletingRef.current = true;
    setDeletingId(id);

    // ONE atomic Postgres transaction (STEP 16-H2-C2-BUDGET): the category
    // and — if the snapshot at confirm time carried one — its budget are both
    // tombstoned, or neither is. "category deleted / budget still active" is
    // no longer representable, so the old two-write orphan-budget path is gone
    // with it. Both tokens were captured in `confirmDelete` before the Alert;
    // `budgetToken === null` means "snapshot had no live budget" and is itself
    // a server-side guard (a budget that appeared since -> conflict).
    const res = await softDeleteCustomCategoryWithBudget({
      householdId: activeHousehold.id,
      categoryId: id,
      expectedUserId: session.user.id,
      expectedCategoryUpdatedAt: categoryToken,
      expectedBudgetUpdatedAt: budgetToken,
    });

    await refresh();
    deletingRef.current = false;
    setDeletingId(null);

    if (res.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show(CATEGORY_DELETE_MSG.success);
      return;
    }

    // A3 §5/§6: the atomic RPC contract means a failure mutated NEITHER table,
    // so there is no partial-success ("category gone / budget orphaned") line
    // left to describe — one message per reason, resolved by the pure helper.
    // A transport failure is a plain "try again"; A3 does NOT enqueue DELETE.
    toast.show(categoryDeleteFailureToast(res));
  };

  /* ---------------- reorder (shared, household_settings) ---------------- */

  const onReorder = (rawOrderedIds: string[]) => {
    if (!canReorder || reorderBusyRef.current) return;
    if (!ready || !session?.user?.id || !activeHousehold) return;
    // STEP 16-H2-C2-B2 §6/§13: only a SYNTHETIC row id (pending/failed CREATE,
    // failed-orphan UPDATE — no authoritative server row) is stripped here; a
    // terminal-failed UPDATE whose real server row exists stays in the order
    // like any category. `saveCategoryOrder`'s own logic is untouched.
    const orderedIds = rawOrderedIds.filter((id) => !isSyntheticRow(id));
    // §26 validation: non-empty strings, no dupes.
    if (
      orderedIds.length === 0 ||
      orderedIds.some((x) => !x) ||
      new Set(orderedIds).size !== orderedIds.length
    ) {
      void refresh();
      return;
    }
    reorderBusyRef.current = true;
    void (async () => {
      const res = await saveCategoryOrder({
        householdId: activeHousehold.id,
        expectedUserId: session.user.id,
        type: tab, // §25: column chosen from `type` in the service, never caller text
        orderedIds,
      });
      await refresh(); // authoritative order restore on failure, confirm on success
      reorderBusyRef.current = false;
      if (!res.ok) toast.show(res.message);
    })();
  };

  const addBtn = canCreate ? (
    <Pressable
      onPress={openCreate}
      style={{
        width: 36,
        height: 36,
        borderRadius: radii.pill,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AppIcon name="plus" size={18} color={colors.white} strokeWidth={2.5} />
    </Pressable>
  ) : undefined;

  const editInitial =
    sheet?.mode === 'edit'
      ? {
          name: sheet.category.name,
          icon: sheet.category.icon,
          bg: sheet.category.bg,
          color: sheet.category.color,
        }
      : undefined;

  return (
    <ModalScreen
      title="카테고리 관리"
      onClose={() => router.back()}
      right={addBtn}
      refreshControl={financeRefresh}
    >
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.xs }}>
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'expense', label: '지출' },
            { value: 'income', label: '수입' },
          ]}
        />
      </View>

      <Text
        style={{
          fontFamily: fontFamily.bold,
          fontSize: 11,
          letterSpacing: 0.2,
          color: colors.textSub,
          marginHorizontal: spacing.xl,
          marginTop: spacing.md,
          marginBottom: spacing.sm,
        }}
      >
        입력 시 이 순서대로 나타나요 ·{' '}
        <Text style={{ color: colors.primaryStrong }}>오른쪽 ⋮⋮ 손잡이를 끌어서 이동</Text>
      </Text>

      <DragList
        key={tab}
        cats={allCats}
        customIds={customIds}
        deletingId={deletingId}
        pendingOps={pendingCategoryOps}
        onReorder={canReorder ? onReorder : undefined}
        onEdit={canEdit ? openEdit : undefined}
        onDelete={canDelete ? confirmDelete : undefined}
        onDiscard={discardFailed}
      />

      <View
        style={{
          marginHorizontal: spacing.xl,
          marginTop: 18,
          padding: spacing.md,
          backgroundColor: colors.primaryLighter,
          borderRadius: radii.md,
        }}
      >
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.primaryStrong, lineHeight: 17 }}>
          💡 기본 카테고리는 삭제만 안 되고 순서 변경은 자유예요. 자주 쓰는 걸 위로 올려두면 입력할 때 편해요.
        </Text>
      </View>

      {sheet && (
        <CategorySheet
          key={sheet.mode === 'edit' ? `edit-${sheet.category.id}` : 'create'}
          mode={sheet.mode}
          type={tab}
          initial={editInitial}
          busy={submitting}
          isNameTaken={(name) =>
            isCategoryNameTaken(
              name,
              namesForTab(sheet.mode === 'edit' ? sheet.category.id : undefined),
            )
          }
          onCancel={closeSheet}
          onSubmit={(draft) => {
            if (sheet.mode === 'create') void doCreate(draft);
            else void doUpdate(draft);
          }}
        />
      )}
    </ModalScreen>
  );
}

/* ------------------------------------------------------------------ *
 * Create / edit sheet — one BottomSheet for both. `type` is shown only
 * as context (create) and NEVER editable (STEP 16-G2-C4-B §2/§14).
 * ------------------------------------------------------------------ */
function CategorySheet({
  mode,
  type,
  initial,
  busy,
  isNameTaken,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  type: TxnType;
  initial?: { name: string; icon: IconKey; bg: string; color: string };
  busy: boolean;
  isNameTaken: (name: string) => boolean;
  onCancel: () => void;
  onSubmit: (draft: NewCustomCategoryDraft) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [iconIdx, setIconIdx] = useState(() => {
    const i = initial ? CAT_ICON_PALETTE.indexOf(initial.icon) : 0;
    return i < 0 ? 0 : i;
  });
  const [colorIdx, setColorIdx] = useState(() => {
    if (!initial) return 0;
    const i = CAT_COLOR_PALETTE.findIndex((p) => p.bg === initial.bg && p.color === initial.color);
    return i < 0 ? 0 : i;
  });

  const pair = CAT_COLOR_PALETTE[colorIdx];
  const icon = CAT_ICON_PALETTE[iconIdx];
  const trimmed = name.trim();
  const dup = trimmed.length > 0 && isNameTaken(trimmed);
  const canSave = trimmed.length > 0 && !dup && !busy;

  return (
    <BottomSheet
      visible
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={
        mode === 'create'
          ? `${type === 'expense' ? '지출' : '수입'} 카테고리 추가`
          : '카테고리 수정'
      }
      scroll
    >
      <View
        style={{
          alignItems: 'center',
          marginBottom: 16,
          paddingVertical: 16,
          backgroundColor: colors.white,
          borderRadius: radii.xl,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            backgroundColor: pair.bg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AppIcon name={icon} size={24} color={pair.color} />
        </View>
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, marginTop: 8 }}>
          {trimmed || '카테고리 이름'}
        </Text>
      </View>

      <Field label="이름" hint={`최대 ${MAX_CATEGORY_NAME}자`}>
        <TextField
          value={name}
          onChangeText={(t) => setName(t.slice(0, MAX_CATEGORY_NAME))}
          placeholder="예: 반려동물, 자기계발, 커피"
          maxLength={MAX_CATEGORY_NAME}
          autoFocus={mode === 'create'}
        />
      </Field>
      {dup && (
        <Text
          style={{
            fontFamily: fontFamily.medium,
            fontSize: 11,
            color: colors.expenseText,
            marginTop: -6,
            marginBottom: 6,
          }}
        >
          이미 있는 카테고리 이름이에요
        </Text>
      )}

      <Field label="아이콘">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CAT_ICON_PALETTE.map((ic, i) => {
            const active = iconIdx === i;
            return (
              <Pressable
                key={ic}
                onPress={() => setIconIdx(i)}
                style={{
                  width: 46,
                  height: 46,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: active ? pair.bg : colors.white,
                  borderWidth: 2,
                  borderColor: active ? pair.color : colors.border,
                  borderRadius: radii.md,
                }}
              >
                <AppIcon name={ic} size={19} color={active ? pair.color : colors.textSub} />
              </Pressable>
            );
          })}
        </View>
      </Field>

      <Field label="색상">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CAT_COLOR_PALETTE.map((c, i) => (
            <Pressable
              key={i}
              onPress={() => setColorIdx(i)}
              style={{
                width: 36,
                height: 36,
                borderRadius: radii.pill,
                backgroundColor: c.bg,
                borderWidth: 2,
                borderColor: colorIdx === i ? c.color : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <View style={{ width: 16, height: 16, borderRadius: radii.pill, backgroundColor: c.color }} />
            </Pressable>
          ))}
        </View>
      </Field>

      <GradientButton
        label={busy ? '저장 중…' : mode === 'create' ? '카테고리 추가' : '수정하기'}
        disabled={!canSave}
        onPress={() =>
          canSave &&
          onSubmit({
            type,
            name: trimmed.slice(0, MAX_CATEGORY_NAME),
            icon,
            bg: pair.bg,
            color: pair.color,
          })
        }
      />
    </BottomSheet>
  );
}

/* ------------------------------------------------------------------ *
 * Long-press-and-drag reorderable list. Unchanged drag mechanics; adds an
 * `onEdit` tap target on the left (icon + name) of CUSTOM rows only. The
 * edit Pressable, the delete Pressable and the drag GestureDetector are
 * SIBLINGS — a tap lands on exactly one, so tapping the trash never opens
 * the edit sheet (STEP 16-G2-C4-B §33).
 * ------------------------------------------------------------------ */
function DragList({
  cats,
  customIds,
  deletingId,
  pendingOps,
  onReorder,
  onEdit,
  onDelete,
  onDiscard,
}: {
  cats: Category[];
  customIds: Set<string>;
  deletingId: string | null;
  /** STEP 16-H2-C2-B2 — category id -> its un-sent offline op state, for the
   *  row label, read-only gate, drag gate and "변경 버리기". */
  pendingOps: FinanceReadResult['pendingCategoryOps'];
  onReorder?: (ids: string[]) => void;
  onEdit?: (cat: Category) => void;
  onDelete?: (id: string, name: string) => void;
  /** drop a terminal-failed UPDATE's local record ("변경 버리기"). */
  onDiscard: (queueId: string) => void;
}) {
  const [data, setData] = useState<Category[]>(cats);
  const draggingRef = useRef(false);

  // Re-sync from the (remote) store unless a drag is in progress.
  useEffect(() => {
    if (!draggingRef.current) setData(cats);
  }, [cats]);

  const activeIndex = useSharedValue(-1);
  const dragY = useSharedValue(0);

  const setDragging = (v: boolean) => {
    draggingRef.current = v;
  };

  const commit = (from: number, to: number) => {
    setData((cur) => {
      if (to < 0 || to >= cur.length || from === to) return cur;
      const next = cur.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      onReorder?.(next.map((c) => c.id));
      return next;
    });
  };

  return (
    <View
      style={{
        marginHorizontal: spacing.lg,
        height: data.length * ROW_H,
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.xxl,
      }}
    >
      {data.map((c, index) => {
        const pendingOp = pendingOps.get(c.id);
        // Draggable when: no op, OR a terminal-failed UPDATE whose real server
        // row exists (NOT synthetic, IS failed). A still-pending op or a
        // synthetic row is pinned so a non-authoritative id can't reach
        // `commit` / `saveCategoryOrder` (§6).
        const reorderable =
          !!onReorder &&
          (!pendingOp || (pendingOp.failed && !pendingOp.synthetic));
        return (
          <DragRow
            key={c.id}
            cat={c}
            index={index}
            count={data.length}
            custom={customIds.has(c.id)}
            dimmed={deletingId === c.id}
            pendingLabel={pendingOp ? pendingCategoryRowLabel(pendingOp) : null}
            discardQueueId={pendingOp?.failed && pendingOp.queueId ? pendingOp.queueId : null}
            onDiscard={onDiscard}
            activeIndex={activeIndex}
            dragY={dragY}
            onEdit={onEdit}
            onDelete={onDelete}
            reorderable={reorderable}
            onDragStart={() => setDragging(true)}
            onCommit={(from, to) => {
              commit(from, to);
              setDragging(false);
            }}
          />
        );
      })}
    </View>
  );
}

function DragRow({
  cat,
  index,
  count,
  custom,
  dimmed,
  pendingLabel,
  discardQueueId,
  onDiscard,
  activeIndex,
  dragY,
  onEdit,
  onDelete,
  reorderable,
  onDragStart,
  onCommit,
}: {
  cat: Category;
  index: number;
  count: number;
  custom: boolean;
  dimmed: boolean;
  /** STEP 16-H2-C2-B2 — non-null when this row carries an un-sent offline op:
   *  the small muted status line, and no edit/delete while it's set. */
  pendingLabel: string | null;
  /** non-null on a terminal-failed op -> show the "변경 버리기" action. */
  discardQueueId: string | null;
  onDiscard: (queueId: string) => void;
  activeIndex: { value: number };
  dragY: { value: number };
  onEdit?: (cat: Category) => void;
  onDelete?: (id: string, name: string) => void;
  reorderable: boolean;
  onDragStart: () => void;
  onCommit: (from: number, to: number) => void;
}) {
  const buzz = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  };

  const pan = Gesture.Pan()
    .enabled(reorderable)
    .activeOffsetY([-4, 4])
    .failOffsetX([-16, 16])
    .onStart(() => {
      activeIndex.value = index;
      dragY.value = 0;
      runOnJS(onDragStart)();
      runOnJS(buzz)();
    })
    .onUpdate((e) => {
      dragY.value = e.translationY;
    })
    .onEnd(() => {
      const target = Math.min(count - 1, Math.max(0, Math.round(index + dragY.value / ROW_H)));
      runOnJS(onCommit)(index, target);
      activeIndex.value = -1;
      dragY.value = 0;
    })
    .onFinalize(() => {
      if (activeIndex.value === index) {
        runOnJS(onCommit)(index, index);
        activeIndex.value = -1;
        dragY.value = 0;
      }
    });

  const animStyle = useAnimatedStyle(() => {
    const isActive = activeIndex.value === index;
    if (isActive) {
      return {
        transform: [{ translateY: dragY.value }, { scale: withSpring(1.03) }],
        zIndex: 20,
        opacity: 0.97,
        shadowColor: '#3A3446',
        shadowOpacity: 0.12,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
        elevation: 10,
      };
    }
    let shift = 0;
    if (activeIndex.value !== -1) {
      const from = activeIndex.value;
      const to = Math.min(count - 1, Math.max(0, Math.round(from + dragY.value / ROW_H)));
      if (from < to && index > from && index <= to) shift = -ROW_H;
      else if (from > to && index < from && index >= to) shift = ROW_H;
    }
    return {
      transform: [{ translateY: withSpring(shift, { damping: 20, stiffness: 220 }) }],
      zIndex: 1,
    };
  });

  // §12: a row with an un-sent offline op is read-only — no edit tap, no
  // delete button. §27: the status shows only as a small muted line.
  const editable = custom && !!onEdit && !pendingLabel;

  const left = (
    <>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          backgroundColor: cat.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <AppIcon name={cat.icon} size={16} color={cat.color} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text
          numberOfLines={1}
          style={{ fontFamily: fontFamily.semibold, fontSize: 13, lineHeight: 16, color: colors.text, ...noPad }}
        >
          {cat.name}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            fontFamily: pendingLabel ? fontFamily.medium : fontFamily.regular,
            fontSize: 10,
            lineHeight: 12,
            color: colors.textMuted,
            ...noPad,
          }}
        >
          {pendingLabel ?? (custom ? (editable ? '사용자 추가 · 눌러서 수정' : '사용자 추가') : '기본')}
        </Text>
      </View>
    </>
  );

  const leftStyle = {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.sm,
  };

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: 0,
          right: 0,
          top: index * ROW_H,
          height: ROW_H,
        },
        animStyle,
      ]}
    >
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingLeft: spacing.lg,
          paddingRight: spacing.sm,
          borderBottomWidth: index === count - 1 ? 0 : 1,
          borderBottomColor: colors.track,
          backgroundColor: colors.white,
          borderRadius: radii.xxl,
          opacity: dimmed ? 0.5 : pendingLabel ? 0.6 : 1,
        }}
      >
        {editable ? (
          <Pressable onPress={() => onEdit!(cat)} style={leftStyle}>
            {left}
          </Pressable>
        ) : (
          <View style={leftStyle}>{left}</View>
        )}

        {custom && onDelete && !pendingLabel && (
          <Pressable
            onPress={() => onDelete(cat.id, cat.name)}
            disabled={dimmed}
            hitSlop={8}
            style={{
              width: 30,
              height: 30,
              borderRadius: radii.sm,
              borderWidth: 1,
              borderColor: colors.expenseLight,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <AppIcon name="trash" size={13} color={colors.expenseText} />
          </Pressable>
        )}

        {/* STEP 16-H2-C2-B2 conflict-UX — "변경 버리기": drop the failed local
            UPDATE record. NOT a category delete. Mutually exclusive with the
            trash button (that only shows when there's no pending op). */}
        {discardQueueId && (
          <Pressable
            onPress={() => onDiscard(discardQueueId)}
            hitSlop={8}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 5,
              borderRadius: radii.sm,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.white,
            }}
          >
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: colors.textSub }}>
              변경 버리기
            </Text>
          </Pressable>
        )}

        {/* Drag handle — grab here and slide. */}
        <GestureDetector gesture={pan}>
          <View style={{ paddingVertical: 12, paddingHorizontal: 8, opacity: reorderable ? 1 : 0.35 }}>
            <AppIcon name="grip" size={20} color={colors.textMuted} />
          </View>
        </GestureDetector>
      </View>
    </Animated.View>
  );
}
