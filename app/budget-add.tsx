import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { ChipSelect, Field, HeaderTextButton } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { getAllCats, getCat, type CatOrderMap, type CustomCatMap } from '@/data/categories';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, parseNum } from '@/lib/format';
import type { RemoteBudgetMeta } from '@/lib/remoteFinanceMapping';
import { saveBudget } from '@/services/remoteBudgetWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import type { BudgetMap } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

/** Digit-entry rules — identical to the main expense keypad (app/input.tsx). */
function applyDigit(amount: string, k: string): string {
  if (k === 'back') return amount.slice(0, -1);
  if (k === '00') return amount === '' || amount === '0' || amount.length >= 9 ? amount : amount + '00';
  if (k === '0') return amount === '' || amount === '0' || amount.length >= 10 ? amount : amount + '0';
  return amount.length >= 10 ? amount : (amount === '0' ? '' : amount) + k;
}

/**
 * Route entry for /budget-add — STEP 16-G2-C3-B.
 *
 * One screen mixes create + edit (the multi-category "cart"), so entry is
 * allowed when EITHER capability is on; each category's write picks the
 * right one at save time (§23). Thin wrapper (card-add / input pattern) so
 * BudgetForm keeps an unconditional hook order.
 *
 * Optional `?category=<catId>` deep-link (from the Budget tab's per-row
 * tap): pre-selects that expense category and pre-fills its current saved
 * amount. An unknown/invalid value is ignored — the plain multi-category
 * cart is shown, never a crash. The concurrency token is STILL the mount
 * snapshot; the param only seeds initial UI state.
 */
export default function BudgetAddRoute() {
  const params = useLocalSearchParams<{ category?: string | string[] }>();
  const categoryParam = Array.isArray(params.category) ? params.category[0] : params.category;

  if (!REMOTE_FINANCE_WRITE.budgetCreate && !REMOTE_FINANCE_WRITE.budgetEdit) {
    return <ReadOnlyRouteNotice title="예산" />;
  }
  return <BudgetFormRoute preselectCategory={categoryParam} />;
}

/**
 * Gates on useFinanceRead() status + the BudgetMap<->budgetMeta invariant
 * (STEP 16-G2-C3-B §5): every live budget category MUST have a meta entry,
 * or a safe concurrency-guarded write is impossible. NEVER useStore().
 */
function BudgetFormRoute({ preselectCategory }: { preselectCategory?: string }) {
  const router = useRouter();
  const { status, error, budgets, budgetMeta, customCats, catOrder, refresh } = useFinanceRead();

  if (status !== 'ready') {
    return (
      <ModalScreen title="예산 설정" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  const metaMissing = Object.keys(budgets).filter((cat) => !budgetMeta[cat]);
  if (metaMissing.length > 0) {
    return (
      <IntegrityNotice
        title="예산 정보를 불러오지 못했어요"
        body="잠시 후 다시 시도해 주세요."
        onRetry={() => void refresh()}
      />
    );
  }

  return (
    <BudgetForm
      budgets={budgets}
      budgetMeta={budgetMeta}
      customCats={customCats}
      catOrder={catOrder}
      refresh={refresh}
      preselectCategory={preselectCategory}
    />
  );
}

function IntegrityNotice({
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
    <ModalScreen title="예산 설정" onClose={() => router.back()} scroll={false}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.md }}>
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text, textAlign: 'center' }}>{title}</Text>
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub, textAlign: 'center', lineHeight: 19 }}>
          {body}
        </Text>
        <Pressable onPress={onRetry} hitSlop={8}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>다시 불러오기</Text>
        </Pressable>
      </View>
    </ModalScreen>
  );
}

function BudgetForm({
  budgets,
  budgetMeta,
  customCats,
  catOrder,
  refresh,
  preselectCategory,
}: {
  budgets: BudgetMap;
  budgetMeta: Record<string, RemoteBudgetMeta>;
  customCats: CustomCatMap;
  catOrder: CatOrderMap;
  refresh: () => Promise<void>;
  preselectCategory?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { status } = useFinanceRead();

  // STEP 16-G2-C3-B §6: shallow snapshot captured ONCE at mount. The
  // per-category concurrency token used at save time comes from THIS, not
  // from a later background refresh — otherwise "owner opened, member
  // changed it, owner saves" would silently overwrite instead of conflict.
  const initialBudgetsRef = useRef<BudgetMap>({ ...budgets });
  const initialBudgetMetaRef = useRef<Record<string, RemoteBudgetMeta>>({ ...budgetMeta });

  const cats = getAllCats('expense', customCats, catOrder);

  // `?category=` deep-link: honoured only when it names a real expense
  // category. Otherwise fall back to the normal first-category default —
  // never crash on a stale/unknown value.
  const validPreselect =
    preselectCategory && cats.some((c) => c.id === preselectCategory) ? preselectCategory : null;
  const preselectSaved = validPreselect ? initialBudgetsRef.current[validPreselect] : undefined;

  /** Pending edits — the "cart". Committed only on final save. */
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [category, setCategory] = useState(validPreselect ?? cats[0]?.id ?? 'food');
  // When arriving via the per-row tap, seed the field with the current
  // saved amount so the user edits an existing value instead of a blank.
  const [amount, setAmount] = useState(preselectSaved ? String(preselectSaved) : '');
  const [padVisible, setPadVisible] = useState(false);

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const curCat = getCat(category, 'expense', customCats);
  const savedAmount = initialBudgetsRef.current[category];

  /** Fold a category's typed amount into the cart (0 removes it). */
  const stash = (catId: string, raw: string) => {
    const n = parseNum(raw);
    setDraft((d) => {
      if (n > 0) return { ...d, [catId]: n };
      const { [catId]: _drop, ...rest } = d;
      return rest;
    });
  };

  const pick = (next: string) => {
    stash(category, amount);
    setCategory(next);
    setAmount(draft[next] ? String(draft[next]) : '');
  };

  const openPad = () => {
    Keyboard.dismiss();
    setPadVisible(true);
  };
  const onKey = (k: string) => setAmount((a) => applyDigit(a, k));

  useEffect(() => {
    stash(category, amount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount]);

  const editItem = (catId: string) => {
    if (catId !== category) {
      stash(category, amount);
      setCategory(catId);
      setAmount(draft[catId] ? String(draft[catId]) : '');
    }
    openPad();
  };

  const removeFromCart = (catId: string) => {
    setDraft((d) => {
      const { [catId]: _drop, ...rest } = d;
      return rest;
    });
    if (catId === category) setAmount('');
  };

  // merge the not-yet-stashed field so the current row always shows in the cart
  const pending: Record<string, number> = {
    ...draft,
    ...(parseNum(amount) > 0 ? { [category]: parseNum(amount) } : {}),
  };
  const entries = Object.entries(pending);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  const canSave = entries.length > 0;

  const save = async () => {
    if (submittingRef.current || !canSave) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    submittingRef.current = true;
    setSubmitting(true);

    let done = 0;
    let attempted = 0;
    let failure: { message: string; changedElsewhere: boolean } | null = null;

    for (const [catId, amt] of entries) {
      // Nothing to persist for an unchanged existing budget.
      const hadLiveRow = Object.prototype.hasOwnProperty.call(initialBudgetsRef.current, catId);
      if (hadLiveRow && initialBudgetsRef.current[catId] === amt) continue;

      const snapMeta = initialBudgetMetaRef.current[catId];
      if (hadLiveRow && !snapMeta) {
        // Should have been caught by BudgetFormRoute's invariant check.
        failure = { message: '예산 정보를 다시 불러와 주세요.', changedElsewhere: false };
        break;
      }

      const needed = hadLiveRow ? REMOTE_FINANCE_WRITE.budgetEdit : REMOTE_FINANCE_WRITE.budgetCreate;
      if (!needed) {
        failure = { message: '지금은 예산을 저장할 수 없어요.', changedElsewhere: false };
        break;
      }

      attempted += 1;
      const res = await saveBudget({
        householdId: activeHousehold.id,
        expectedUserId: session.user.id,
        category: catId,
        amount: amt,
        expectedUpdatedAt: hadLiveRow ? snapMeta!.updatedAt : null,
      });

      if (!res.ok) {
        const changedElsewhere =
          res.reason === 'conflict' ||
          res.reason === 'exists' ||
          res.reason === 'deleted' ||
          res.reason === 'gone';
        failure = { message: res.message, changedElsewhere };
        // STEP 16-G2-C3-B §25: stop at the first failure — never keep
        // writing on a stale snapshot and widen the partial state.
        break;
      }
      done += 1;
    }

    // STEP 16-G2-C3-B §26/§27: exactly one authoritative refresh, then leave.
    await refresh();

    if (!failure) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show(done > 0 ? '예산을 저장했어요' : '변경된 예산이 없어요');
      router.back();
      return;
    }

    if (done > 0) {
      toast.show(`일부 예산만 저장됐어요 (${done}/${attempted}). 최신 내용을 확인해 주세요.`);
    } else if (failure.changedElsewhere) {
      toast.show('다른 곳에서 예산이 변경됐어요. 최신 내용을 불러왔어요.');
    } else {
      toast.show(failure.message);
    }
    router.back();
  };

  return (
    <ModalScreen
      title="예산 설정"
      closeIcon="x"
      onClose={() => router.back()}
      right={
        <HeaderTextButton
          label={submitting ? '저장 중…' : '저장'}
          onPress={() => void save()}
          disabled={!canSave || submitting}
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
        <Field label="카테고리" hint="여러 개를 담고 마지막에 한 번만 저장하면 돼요">
          <ChipSelect
            value={category}
            onChange={pick}
            options={cats.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>

        <Field
          label={`월 예산 · ${curCat.name}`}
          hint={
            savedAmount && !draft[category]
              ? `지금 저장된 값 ${fmt(savedAmount)}원`
              : '한 달 동안 이 카테고리에 얼마까지 쓸지 정해두세요'
          }
        >
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
                color: amount ? colors.text : padVisible ? colors.primaryStrong : colors.textMuted,
                ...tabularNums,
              }}
            >
              {amount ? fmt(Number(amount)) : savedAmount ? fmt(savedAmount) : '0'}
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

        {entries.length > 0 && (
          <View style={{ marginTop: spacing.xs }}>
            <Text
              style={{
                fontFamily: fontFamily.bold,
                fontSize: 11,
                letterSpacing: 0.2,
                color: colors.textSub,
                marginBottom: 8,
                ...noPad,
              }}
            >
              담은 예산 {entries.length}개
            </Text>

            <View style={{ gap: 8 }}>
              {entries.map(([catId, v]) => {
                const c = getCat(catId, 'expense', customCats);
                const isCurrent = catId === category;
                return (
                  <Pressable
                    key={catId}
                    onPress={() => editItem(catId)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingVertical: 10,
                      paddingHorizontal: 12,
                      backgroundColor: isCurrent ? colors.primaryLight : colors.white,
                      borderWidth: 1,
                      borderColor: isCurrent ? colors.primary : colors.border,
                      borderRadius: radii.md,
                    }}
                  >
                    <View
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        backgroundColor: c.bg,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <AppIcon name={c.icon} size={15} color={c.color} />
                    </View>
                    <Text
                      style={{ flex: 1, fontFamily: fontFamily.semibold, fontSize: 13, color: colors.text, ...noPad }}
                    >
                      {c.name}
                    </Text>
                    <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text, ...tabularNums }}>
                      {fmt(v)}원
                    </Text>
                    <AppIcon name="chev-right" size={15} color={colors.textFaint} />
                    <Pressable
                      onPress={() => removeFromCart(catId)}
                      hitSlop={8}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: radii.sm,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <AppIcon name="x" size={14} color={colors.textFaint} />
                    </Pressable>
                  </Pressable>
                );
              })}
            </View>

            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 12,
                marginBottom: spacing.md,
              }}
            >
              <Text style={{ fontFamily: fontFamily.semibold, fontSize: 12, color: colors.textSub }}>합계</Text>
              <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 16, color: colors.text, ...tabularNums }}>
                {fmt(total)}원
              </Text>
            </View>

            <GradientButton
              label={submitting ? '저장 중…' : `예산 ${entries.length}개 저장`}
              onPress={() => void save()}
              disabled={!canSave || submitting}
            />
          </View>
        )}
      </View>
    </ModalScreen>
  );
}
