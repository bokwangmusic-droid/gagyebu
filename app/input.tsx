import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { CalendarSheet } from '@/components/ui/CalendarSheet';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { getAllCats, getCat, type TxnType } from '@/data/categories';
import { installmentPerMonth } from '@/lib/card';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, parseNum, toDateKey, weekdayKo } from '@/lib/format';
import { uid } from '@/lib/id';
import { parseNaturalInput, type NaturalParseResult } from '@/lib/naturalInput';
import { parseCardMessage, type ParsedCardMessage } from '@/lib/parseCardMessage';
import type { RemoteTransactionMeta } from '@/lib/remoteFinanceMapping';
import { type NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  checkSplits,
  makeSplitDraft,
  normalizeSplits,
  SPLIT_ERROR_TEXT,
  type SplitDraft,
} from '@/lib/splits';
import {
  createTransaction,
  softDeleteTransaction,
  updateTransaction,
} from '@/services/remoteFinanceWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import type { PaymentMethod, Transaction } from '@/store/types';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

const PAY_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: '현금' },
  { value: 'debit', label: '체크' },
  { value: 'credit', label: '신용' },
  { value: 'transfer', label: '이체' },
  { value: 'other', label: '기타' },
];
const INSTALLMENT_PRESETS = ['3', '6', '12'];

/* ------------------------------------------------------------------ *
 * 지출·수입 입력 — custom keypad, category picker, card-SMS auto-fill.
 * Ported from the web InputModal.
 * ------------------------------------------------------------------ */

const KEY_HEIGHT = 52;
const KEY_GAP = 6;

/** YYYY-MM-DD shifted by n days. */
function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return toDateKey(new Date(y, m - 1, d + days));
}

/** "오늘 · 9/1" / "어제 · 8/31" / "8/29 (금)" */
function dateLabel(key: string): string {
  const today = toDateKey(new Date());
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const md = `${m}/${d}`;
  if (key === today) return `오늘 · ${md}`;
  if (key === shiftDateKey(today, -1)) return `어제 · ${md}`;
  if (key === shiftDateKey(today, -2)) return `그저께 · ${md}`;
  return `${md} (${weekdayKo(dt)})`;
}

/**
 * Which numeric field the one shared inline keypad is currently editing.
 * `null` = keypad collapsed. The main amount, every 분할 금액 row and the
 * 할부 "직접" box all route through this — no field ever opens the OS keyboard.
 */
type NumTarget =
  | { kind: 'main' }
  | { kind: 'split'; index: number }
  | { kind: 'installment' };

/**
 * Main / 분할 금액 digit rules — 10-digit cap, one leading zero stripped,
 * "00" shortcut. Lifted verbatim from the original inline `onKey`, so the main
 * amount keypad behaves byte-for-byte as before.
 */
function applyAmountKey(cur: string, k: string): string {
  if (k === 'back') return cur.slice(0, -1);
  if (k === '00') return cur === '' || cur === '0' || cur.length >= 9 ? cur : cur + '00';
  if (k === '0') return cur === '' || cur === '0' || cur.length >= 10 ? cur : cur + '0';
  return cur.length >= 10 ? cur : (cur === '0' ? '' : cur) + k;
}

/**
 * 할부 개월 digit rules — digits only, 2-digit cap. Same range the old text
 * field allowed (`replace(/[^0-9]/g,'').slice(0,2)`); the "2개월 이상" check
 * still lives at save, and no artificial maximum is introduced.
 */
function applyMonthsKey(cur: string, k: string): string {
  if (k === 'back') return cur.slice(0, -1);
  if (k === '00') return cur; // a month count is 1–2 digits — ignore "00"
  return cur.length >= 2 ? cur : cur + k;
}

/**
 * Route entry for /input — STEP 16-G2-A (create), extended in
 * STEP 16-G2-B (edit + soft delete).
 *
 *   /input            -> new-transaction form  (REMOTE_FINANCE_WRITE.transactionCreate)
 *   /input?id=<txn>   -> edit form             (REMOTE_FINANCE_WRITE.transactionEdit)
 *
 * Either capability off -> ReadOnlyRouteNotice. The capability + param
 * checks live in this thin wrapper so TransactionForm keeps an
 * unconditional hook order. Expo Router can hand back `string | string[]`,
 * so both are handled.
 */
export default function InputRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;

  if (idParam) {
    if (!REMOTE_FINANCE_WRITE.transactionEdit) return <ReadOnlyRouteNotice title="거래 수정" />;
    return <TransactionFormRoute editId={idParam} />;
  }
  if (!REMOTE_FINANCE_WRITE.transactionCreate) return <ReadOnlyRouteNotice title="거래 입력" />;
  return <TransactionFormRoute editId={null} />;
}

type FormMode =
  | { kind: 'create' }
  | { kind: 'edit'; transaction: Transaction; meta: RemoteTransactionMeta };

/**
 * Resolves create vs edit. For edit, finds the target transaction and its
 * concurrency metadata from useFinanceRead() — NEVER useStore(). The form
 * itself only mounts once its `mode` is fully known, so its hooks stay
 * unconditional; the `key` forces a clean remount when the target changes.
 */
function TransactionFormRoute({ editId }: { editId: string | null }) {
  const router = useRouter();
  const { status, error, transactions, transactionMeta, refresh } = useFinanceRead();

  // STEP 16-G3-B2 §17-21: freeze the first resolved transaction + token for
  // the edit session. A later Realtime / foreground refresh that drops the
  // row (the other member soft-deleted it) must NOT unmount the open form
  // and lose the user's draft — the save's own optimistic-concurrency check
  // (0-row reselect -> deleted / gone / conflict) decides the outcome.
  const frozenRef = useRef<{ transaction: Transaction; meta: RemoteTransactionMeta } | null>(null);

  if (editId == null) {
    return <TransactionForm key="create" mode={{ kind: 'create' }} />;
  }

  const liveTxn = transactions.find((t) => t.id === editId) ?? null;
  const liveMeta = transactionMeta[editId] ?? null;
  if (!frozenRef.current && liveTxn && liveMeta) {
    frozenRef.current = { transaction: liveTxn, meta: liveMeta };
  }
  if (frozenRef.current) {
    return (
      <TransactionForm
        key={editId}
        mode={{ kind: 'edit', transaction: frozenRef.current.transaction, meta: frozenRef.current.meta }}
      />
    );
  }

  // Never resolved for this session -> the ORIGINAL loading / not-found flow.
  if (status !== 'ready') {
    return (
      <ModalScreen title="거래 수정" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }
  if (!liveTxn) {
    return (
      <EditUnavailable
        body="이미 삭제됐거나 다른 우리집의 거래일 수 있어요."
        title="거래를 찾을 수 없어요"
        onRetry={() => void refresh()}
      />
    );
  }
  // liveTxn exists but no meta -> a safe concurrency-guarded edit is
  // impossible; never open the form.
  return (
    <EditUnavailable
      body="잠시 후 다시 시도해 주세요."
      title="거래 정보를 불러오지 못했어요"
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
    <ModalScreen title="거래 수정" onClose={() => router.back()} scroll={false}>
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

function TransactionForm({ mode }: { mode: FormMode }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();

  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  // Household finance READ values come ONLY from the remote read-only
  // source — never useStore(). While status !== 'ready' the form is not
  // rendered at all (FinanceLoadState gate below), so cards/customCats/
  // catOrder are always trusted household data wherever they are used.
  const { status, error, cards, customCats, catOrder, refresh } = useFinanceRead();
  // STEP 16-H2-A2: durable offline fallback for a transaction CREATE whose
  // direct write hit a TRANSPORT failure. Never used for edit/delete.
  const pending = usePendingWrites();

  // In edit mode, `editing` seeds every field; the concurrency token is
  // captured ONCE here (useRef initial value) from the meta this form was
  // mounted with — a later background refresh must never swap it out, or
  // conflict detection becomes meaningless (STEP 16-G2-B §20).
  const editing = mode.kind === 'edit' ? mode.transaction : null;
  const isEdit = mode.kind === 'edit';
  const expectedUpdatedAtRef = useRef(mode.kind === 'edit' ? mode.meta.updatedAt : null);

  const saveLabel = isEdit ? '수정하기' : '저장하기';

  const [type, setType] = useState<TxnType>(editing?.type ?? 'expense');
  const [amount, setAmount] = useState(editing ? String(editing.amount) : '');
  const [category, setCategory] = useState(editing?.category ?? 'food');
  const [memo, setMemo] = useState(editing?.memo ?? '');
  const [selectedDate, setSelectedDate] = useState(() => toDateKey(editing?.date ?? new Date()));

  // One inline keypad, one active target. `padVisible`/`setPadVisible` are kept
  // as a thin shim over it so every existing call site ("collapse the pad",
  // "open the amount pad") keeps working unchanged.
  const [numTarget, setNumTarget] = useState<NumTarget | null>({ kind: 'main' });
  const padVisible = numTarget !== null;
  const setPadVisible = (v: boolean) => setNumTarget(v ? { kind: 'main' } : null);

  // Split expense — off unless the transaction being edited has splits.
  const [splitOn, setSplitOn] = useState(!!editing?.splits?.length);
  const [splits, setSplits] = useState<SplitDraft[]>(() =>
    editing?.splits?.length
      ? editing.splits.map((s) => ({ category: s.category, amount: String(s.amount) }))
      : [makeSplitDraft('food'), makeSplitDraft('transit')],
  );

  // Payment method / card / 할부 — all optional; absent = plain single entry.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | undefined>(
    editing?.paymentMethod,
  );
  const [cardId, setCardId] = useState<string | undefined>(editing?.cardId);
  const [installmentOn, setInstallmentOn] = useState(!!editing?.installment);
  const [installmentMonths, setInstallmentMonths] = useState(
    editing?.installment ? String(editing.installment.months) : '3',
  );

  const [showDate, setShowDate] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pastePreview, setPastePreview] = useState<ParsedCardMessage | null>(null);

  const [showQuick, setShowQuick] = useState(false);
  const [quickText, setQuickText] = useState('');
  const [quickResult, setQuickResult] = useState<NaturalParseResult | null>(null);

  const cats = useMemo(
    () => getAllCats(type, customCats, catOrder),
    [type, customCats, catOrder],
  );
  const allUserCats = useMemo(
    () => [
      ...getAllCats('expense', customCats, catOrder),
      ...getAllCats('income', customCats, catOrder),
    ],
    [customCats, catOrder],
  );

  // Keep the selected category valid when the type flips — but NEVER
  // silently rewrite an existing transaction's category. If we are editing,
  // the type is still what was loaded, AND `category` is still the exact id
  // that was loaded, then that id may simply be a custom category that was
  // soft-deleted after this transaction was created (STEP 16-G2-C4 B1).
  // Keeping it means "edit only the memo/amount/…" leaves the real DB
  // `transactions.category` untouched (the picker just shows nothing
  // selected). The fallback still fires for a genuine expense↔income flip,
  // an explicit re-pick of an active category, or a brand-new transaction.
  useEffect(() => {
    if (cats.some((c) => c.id === category)) return;
    const isUntouchedEditCategory =
      !!editing && type === editing.type && category === editing.category;
    if (isUntouchedEditCategory) return;
    setCategory(cats[0]?.id ?? 'food');
  }, [cats, category, type, editing]);

  // Live preview while the user pastes a card message.
  useEffect(() => {
    if (!pasteText.trim()) {
      setPastePreview(null);
      return;
    }
    setPastePreview(parseCardMessage(pasteText));
  }, [pasteText]);

  // Split is expense-only; flipping to 수입 drops back to a single category.
  useEffect(() => {
    if (type !== 'expense' && splitOn) setSplitOn(false);
  }, [type, splitOn]);

  // Payment method is expense-only.
  useEffect(() => {
    if (type !== 'expense' && paymentMethod !== undefined) setPaymentMethod(undefined);
  }, [type, paymentMethod]);

  // Card & 할부 details only apply to 신용; clear them otherwise.
  useEffect(() => {
    if (paymentMethod !== 'credit') {
      if (cardId !== undefined) setCardId(undefined);
      if (installmentOn) setInstallmentOn(false);
    }
  }, [paymentMethod, cardId, installmentOn]);

  const displayAmount = amount ? fmt(Number(amount)) : '0';
  const total = parseNum(amount);
  const normSplits = useMemo(() => normalizeSplits(splits), [splits]);
  const splitCheck = useMemo(
    () => checkSplits(total, normSplits),
    [total, normSplits],
  );
  const installmentActive = paymentMethod === 'credit' && installmentOn;
  const instMonths = parseNum(installmentMonths);
  const instPreview =
    installmentActive && instMonths >= 2 ? installmentPerMonth(total, instMonths) : null;
  const canSave =
    total > 0 &&
    (!splitOn || splitCheck.ok) &&
    (!installmentActive || instMonths >= 2);
  const today = toDateKey(new Date());

  // Keep the active numeric target valid: a 분할 금액 row can disappear (split
  // turned off, row removed, type→수입) and the 할부 "직접" box only exists
  // while 할부 is on. Fall back to closing the pad, never editing a hidden field.
  useEffect(() => {
    if (
      numTarget?.kind === 'split' &&
      (!splitOn || numTarget.index >= splits.length)
    ) {
      setNumTarget(null);
    } else if (numTarget?.kind === 'installment' && !installmentActive) {
      setNumTarget(null);
    }
  }, [numTarget, splitOn, splits.length, installmentActive]);

  const setSplitRow = (i: number, patch: Partial<SplitDraft>) =>
    setSplits((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  // New rows start with no category so the "카테고리를 선택" guard is real.
  const addSplitRow = () => setSplits((rows) => [...rows, makeSplitDraft('')]);
  const removeSplitRow = (i: number) =>
    setSplits((rows) => (rows.length <= 2 ? rows : rows.filter((_, idx) => idx !== i)));

  const tap = () => {
    void Haptics.selectionAsync().catch(() => {});
  };

  /**
   * Switch focus from a system-keyboard field (memo / 분할 금액 / 할부 개월)
   * to the in-app amount keypad. Dismissing the soft keyboard first lets
   * Android/Galaxy tear it down cleanly instead of stacking it under our
   * custom pad; on iOS it's a graceful no-op when nothing is focused.
   */
  const openAmountPad = () => {
    Keyboard.dismiss();
    setPadVisible(true);
  };

  /**
   * Called on touch-down of the memo field. Collapsing the custom keypad
   * *before* the TextInput takes focus makes the pad → 일반 키보드 hand-off
   * sequential rather than a jarring overlap on Galaxy.
   */
  const collapsePadForKeyboard = () => {
    setPadVisible(false);
  };

  /** Every inline-keypad press is routed to whichever numeric field is active. */
  const onKey = (k: string) => {
    if (!numTarget) return;
    if (numTarget.kind === 'main') {
      setAmount((a) => applyAmountKey(a, k));
    } else if (numTarget.kind === 'split') {
      const idx = numTarget.index;
      setSplits((rows) =>
        rows.map((r, i) => (i === idx ? { ...r, amount: applyAmountKey(r.amount, k) } : r)),
      );
    } else {
      setInstallmentMonths((m) => applyMonthsKey(m, k));
    }
  };

  // Android hardware back: close an open sub-sheet/panel first so a stray
  // back-press doesn't drop the whole input screen (losing the draft amount).
  useEffect(() => {
    if (!showPaste && !showQuick) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showPaste) {
        setShowPaste(false);
        return true;
      }
      if (showQuick) {
        setShowQuick(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [showPaste, showQuick]);

  // Double-submit defence.
  //  - transactionIdRef: client-generated id for CREATE only, minted ONCE
  //    per form mount and reused on every retry (PK 23505-hardened
  //    idempotency in createTransaction()). Unused in edit mode.
  //  - submittingRef / submitting: sync + UI re-entry guard for save
  //    (create & edit).  deletingRef / deleting: same for soft delete.
  const transactionIdRef = useRef(uid('txn'));
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);

  /** Draft-state -> NewTransactionDraft, or null when the form isn't valid. */
  const buildDraft = (): NewTransactionDraft | null => {
    // Defensive re-validation — the DB has CHECK/FK constraints but we do
    // not lean on them for UX (STEP 16-G2-A2 §12).
    if (!(total > 0)) return null;
    if (type !== 'expense' && type !== 'income') return null;
    const isCredit = type === 'expense' && paymentMethod === 'credit';
    if (splitOn && !splitCheck.ok) return null;
    if (isCredit && installmentOn && !(instMonths >= 2)) return null;
    const categoryToSave = splitOn ? splits[0].category : category;
    if (!categoryToSave) return null;

    // Edit + date unchanged -> keep the transaction's original instant
    // (its time of day), matching the pre-G1B edit UX.
    let dateISO: string;
    if (editing && toDateKey(editing.date) === selectedDate) {
      dateISO = editing.date;
    } else {
      const now = new Date();
      const [y, m, d] = selectedDate.split('-').map(Number);
      dateISO = new Date(
        y,
        m - 1,
        d,
        now.getHours(),
        now.getMinutes(),
        now.getSeconds(),
      ).toISOString();
    }

    return {
      type,
      // A representative category so list rows still show an icon;
      // aggregation ignores it whenever `splits` is present.
      category: categoryToSave,
      amount: total,
      memo: memo.trim(),
      date: dateISO,
      paymentMethod: type === 'expense' ? paymentMethod ?? undefined : undefined,
      cardId: isCredit ? cardId ?? undefined : undefined,
      installment:
        isCredit && installmentOn && instMonths >= 2 ? { months: instMonths } : undefined,
      splits: splitOn ? normSplits : undefined,
    };
  };

  const save = async () => {
    if (submittingRef.current || deletingRef.current || !canSave) return;
    // Trusted-context gate (STEP 16-G2-A2 §11 / 16-G2-B §20).
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;
    if (selectedDate > today) return;

    const draft = buildDraft();
    if (!draft) return;
    const knownCardIds = new Set(cards.map((c) => c.id));

    submittingRef.current = true;
    setSubmitting(true);

    if (mode.kind === 'create') {
      const res = await createTransaction({
        id: transactionIdRef.current,
        householdId: activeHousehold.id,
        // Session id this trusted screen was validated against — the service
        // refuses to write if the live session switched accounts (HARDEN).
        expectedUserId: session.user.id,
        draft,
        knownCardIds,
      });

      if (res.ok) {
        // Authoritative remote refresh, then leave — no optimistic local
        // write, no stale-closure re-check (STEP 16-G2-A2 §13/§19).
        await refresh();
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('저장했어요');
        router.back();
        return;
      }

      // STEP 16-H2-A2: a TRANSPORT failure (offline) -> durable queue
      // fallback. The SAME client id (transactionIdRef, never regenerated)
      // and SAME draft go into the PendingWrite, so a later flush replays
      // the exact request and its 23505 reconcile stays idempotent.
      if (res.transport === true) {
        const enq = await pending.enqueueTransactionCreate({
          entityId: transactionIdRef.current,
          payload: draft,
          scope: { userId: session.user.id, householdId: activeHousehold.id },
        });
        submittingRef.current = false;
        setSubmitting(false);
        if (enq.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          toast.show('저장했어요 · 인터넷에 연결되면 자동으로 반영할게요');
          router.back();
          return;
        }
        // Durable enqueue failed — DO NOT claim success, keep the form.
        toast.show(
          enq.reason === 'not-hydrated'
            ? '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.'
            : enq.reason === 'cap'
              ? '오프라인에 저장할 수 있는 거래 수를 초과했어요. 인터넷 연결 후 다시 시도해주세요.'
              : '거래를 저장하지 못했어요. 잠시 후 다시 시도해주세요.',
        );
        return;
      }

      // A non-transport terminal failure (identity / 23505 mismatch / …) —
      // existing behaviour: message + stay. transactionIdRef is unchanged so
      // a manual retry reuses the same id.
      submittingRef.current = false;
      setSubmitting(false);
      toast.show(res.message);
      return;
    }

    // ---- edit ---- expectedUpdatedAt is the token captured at MOUNT
    // (expectedUpdatedAtRef), never re-fetched — that is what makes the
    // conflict check meaningful (STEP 16-G2-B §20).
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      submittingRef.current = false;
      setSubmitting(false);
      toast.show('거래 정보를 다시 불러와 주세요.');
      return;
    }
    const res = await updateTransaction({
      id: mode.transaction.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
      draft,
      knownCardIds,
      // STEP 16-G2-C2 §5: the ORIGINAL DB card_id, so an edit to a
      // transaction whose card was soft-deleted preserves that link
      // instead of null-ing it. `mode.meta` is captured at mount.
      originalRawCardId: mode.meta.rawCardId,
    });
    if (!res.ok) {
      // STEP 16-H2-B2: a TRANSPORT failure (offline) -> durable UPDATE queue
      // fallback. The FROZEN mount snapshot goes in verbatim — `token`
      // (expectedUpdatedAtRef, captured at mount) and `mode.meta.rawCardId` —
      // so the optimistic-concurrency check stays meaningful when the flush
      // finally runs. The coordinator NEVER re-reads a newer token.
      if (res.transport === true) {
        const enq = await pending.enqueueTransactionUpdate({
          scope: { userId: session.user.id, householdId: activeHousehold.id },
          entityId: mode.transaction.id,
          payload: draft,
          expectedUpdatedAt: token,
          originalRawCardId: mode.meta.rawCardId,
        });
        submittingRef.current = false;
        setSubmitting(false);
        if (enq.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          toast.show('수정했어요 · 인터넷에 연결되면 자동으로 반영할게요');
          router.back();
          return;
        }
        // Durable enqueue failed — DO NOT claim success, keep the form.
        toast.show(
          enq.reason === 'existing-pending'
            ? '이미 전송 대기 중인 변경이 있어요.'
            : enq.reason === 'not-hydrated'
              ? '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.'
              : enq.reason === 'cap'
                ? '오프라인에 저장할 수 있는 거래 수를 초과했어요. 인터넷 연결 후 다시 시도해주세요.'
                : '수정을 저장하지 못했어요. 잠시 후 다시 시도해주세요.',
        );
        return;
      }
      submittingRef.current = false;
      setSubmitting(false);
      if (res.reason === 'identity' || res.reason === 'error') {
        toast.show(res.message);
        return;
      }
      // conflict / deleted / gone — reload authoritative data and leave the
      // stale form rather than let it overwrite (STEP 16-G2-B §11).
      await refresh();
      toast.show(res.message);
      router.back();
      return;
    }
    await refresh();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    toast.show('수정했어요');
    router.back();
  };

  const confirmDelete = () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    Alert.alert('이 거래를 삭제할까요?', '함께 쓰는 가계부에서도 보이지 않게 돼요.', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => void doDelete() },
    ]);
  };

  const doDelete = async () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      toast.show('거래 정보를 다시 불러와 주세요.');
      return;
    }

    deletingRef.current = true;
    setDeleting(true);

    const res = await softDeleteTransaction({
      id: mode.transaction.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    if (res.ok) {
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('삭제했어요');
      router.back();
      return;
    }

    // STEP 16-H2-B2: a TRANSPORT failure (offline) -> durable soft-DELETE
    // queue fallback with the FROZEN mount token (`token`). composeFinance
    // hides the row from every useFinanceRead consumer right away.
    if (res.transport === true) {
      const enq = await pending.enqueueTransactionDelete({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: mode.transaction.id,
        expectedUpdatedAt: token,
      });
      deletingRef.current = false;
      setDeleting(false);
      if (enq.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('삭제했어요 · 인터넷에 연결되면 자동으로 반영할게요');
        router.back();
        return;
      }
      toast.show(
        enq.reason === 'existing-pending'
          ? '이미 전송 대기 중인 변경이 있어요.'
          : enq.reason === 'not-hydrated'
            ? '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.'
            : enq.reason === 'cap'
              ? '오프라인에 저장할 수 있는 거래 수를 초과했어요. 인터넷 연결 후 다시 시도해주세요.'
              : '삭제하지 못했어요. 잠시 후 다시 시도해주세요.',
      );
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

  const openPaste = async () => {
    setShowPaste(true);
    setPasteText('');
    setPastePreview(null);
    try {
      const t = await Clipboard.getStringAsync();
      if (t && t.trim()) setPasteText(t);
    } catch {
      /* clipboard unavailable — user pastes manually */
    }
  };

  const applyPaste = () => {
    if (!pastePreview || pastePreview.amount === 0) {
      Alert.alert('금액을 못 찾았어요', '붙여넣은 내용을 다시 확인해 주세요.');
      return;
    }
    setAmount(String(pastePreview.amount));
    if (pastePreview.merchant) setMemo(pastePreview.merchant);
    setType(pastePreview.type);
    setSplitOn(false); // a card message is always one single-category charge
    // The parser doesn't detect card / 할부 — clear any stale edit state.
    setPaymentMethod(undefined);
    setCardId(undefined);
    setInstallmentOn(false);
    if (pastePreview.category) {
      const c = pastePreview.category;
      setTimeout(() => setCategory(c), 0);
    }
    setShowPaste(false);
    setPasteText('');
    setPastePreview(null);
  };

  /**
   * Natural-language quick entry. Parses the one-liner and pre-fills the
   * normal form — it never saves. The user reviews/edits and taps 저장.
   */
  const analyzeQuick = () => {
    const r = parseNaturalInput(quickText, new Date(), { categories: allUserCats });
    setQuickResult(r);
    if (r.amount == null) return; // nothing to apply — the hint tells the user why
    setType(r.type);
    setSplitOn(false); // quick entry always fills a normal single-category row
    setPaymentMethod(undefined); // parser has no card / 할부 concept
    setCardId(undefined);
    setInstallmentOn(false);
    setAmount(String(r.amount));
    if (r.category) setCategory(r.category);
    if (r.memo) setMemo(r.memo);
    setSelectedDate(r.dateKey > today ? today : r.dateKey);
    setPadVisible(false);
    void Haptics.selectionAsync().catch(() => {});
  };

  const amountColor =
    amount === ''
      ? colors.textMuted
      : type === 'expense'
        ? colors.expenseText
        : colors.incomeStrong;

  // The main amount has no real caret, so "the keypad is aimed at the main
  // amount" (`numTarget.kind === 'main'`) is the single source of truth for
  // "amount is being edited right now". Text fields clear `numTarget` on focus
  // and 분할/할부 fields retarget it, so the states stay mutually exclusive.
  const amountActive = numTarget?.kind === 'main';
  // While active & still empty, tint the placeholder "0" purple so it reads as
  // a ready input target; once a value exists keep the semantic expense/income
  // colour untouched.
  const amountTextColor =
    amount === '' && amountActive ? colors.primaryStrong : amountColor;

  // Household finance data must be confirmed for the current user+household
  // before the form (which reads cards/customCats/catOrder and writes a
  // transaction into that household) can be used. Never a silent local
  // fallback — same rule as every other finance screen (STEP 16-G1B).
  if (status !== 'ready') {
    return (
      <ModalScreen title={isEdit ? '거래 수정' : '거래 입력'} onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
      {/* Header: close · date pill */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.iconBtn}>
          <AppIcon name="x" size={22} color={colors.text} />
        </Pressable>

        <Pressable onPress={() => setShowDate(true)} style={styles.datePill}>
          <AppIcon name="calendar" size={14} color={colors.primaryStrong} />
          <Text style={styles.datePillText}>{dateLabel(selectedDate)}</Text>
          <AppIcon name="chevron" size={12} color={colors.textMuted} />
        </Pressable>

        {isEdit ? (
          <Pressable
            onPress={confirmDelete}
            disabled={submitting || deleting}
            hitSlop={10}
            style={{ paddingHorizontal: 6, paddingVertical: 4, opacity: submitting || deleting ? 0.4 : 1 }}
          >
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.expenseText }}>
              {deleting ? '삭제 중…' : '삭제'}
            </Text>
          </Pressable>
        ) : (
          <View style={{ width: 30 }} />
        )}
      </View>

      {/* One vertical scroll for the whole form — only the header above and the
          keypad below stay fixed. */}
      <ScrollView
        style={styles.formScroll}
        contentContainerStyle={styles.formContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
      {/* Type tabs */}
      <View style={styles.typeTabs}>
        {(['expense', 'income'] as const).map((t) => {
          const active = type === t;
          return (
            <Pressable
              key={t}
              onPress={() => {
                tap();
                setType(t);
              }}
              style={[styles.typeTab, active && styles.typeTabActive]}
            >
              <Text
                style={{
                  fontFamily: active ? fontFamily.bold : fontFamily.semibold,
                  fontSize: 13,
                  color: active
                    ? t === 'expense'
                      ? colors.expenseText
                      : colors.incomeStrong
                    : colors.textSub,
                }}
              >
                {t === 'expense' ? '지출' : '수입'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Quick-entry + card-SMS pills */}
      <View style={styles.pillRow}>
        <Pressable
          onPress={() => {
            setShowQuick((v) => !v);
            setPadVisible(false);
          }}
          style={[styles.pastePill, showQuick && styles.pastePillOn]}
        >
          <AppIcon name="sparkle" size={13} color={showQuick ? colors.white : colors.primaryStrong} />
          <Text style={[styles.pastePillText, showQuick && { color: colors.white }]}>한 줄 빠른 입력</Text>
        </Pressable>
        <Pressable onPress={openPaste} style={styles.pastePill}>
          <AppIcon name="clipboard" size={13} color={colors.primaryStrong} />
          <Text style={styles.pastePillText}>카드 문자</Text>
        </Pressable>
      </View>

      {showQuick && (
        <>
          <View style={styles.quickPanel}>
            <TextInput
              value={quickText}
              onChangeText={setQuickText}
              onFocus={() => setPadVisible(false)}
              placeholder="예: 점심 김치찌개 9000 · 월급 320만원"
              placeholderTextColor={colors.textMuted}
              returnKeyType="done"
              onSubmitEditing={analyzeQuick}
              style={styles.quickInput}
            />
            <Pressable
              onPress={analyzeQuick}
              disabled={!quickText.trim()}
              style={({ pressed }) => [
                styles.quickBtn,
                { opacity: !quickText.trim() ? 0.4 : pressed ? 0.9 : 1 },
              ]}
            >
              <LinearGradient
                colors={gradients.primary}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.quickBtnFill}
              >
                <Text style={styles.quickBtnText}>분석</Text>
              </LinearGradient>
            </Pressable>
          </View>
          {quickResult &&
            (quickResult.amount == null ? (
              <Text style={styles.quickErr}>
                금액을 찾지 못했어요. 숫자를 넣어 다시 입력해 주세요.
              </Text>
            ) : (
              <Text style={styles.quickResultText}>
                분석됨 · {quickResult.type === 'income' ? '수입' : '지출'} {fmt(quickResult.amount)}원
                {quickResult.category
                  ? ` · ${getCat(quickResult.category, quickResult.type, customCats).name}`
                  : ' · 카테고리 직접 선택'}
                {quickResult.memo ? ` · ${quickResult.memo}` : ''} — 아래에서 확인 후 저장하세요
              </Text>
            ))}
        </>
      )}

      {/* amount · memo · split · categories · payment — all in the shared scroll */}
        <Pressable
          style={[styles.amountRow, amountActive && styles.amountRowActive]}
          onPress={openAmountPad}
        >
          <Text
            style={[styles.amount, { color: amountTextColor }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.5}
          >
            {amount === ''
              ? '0'
              : `${type === 'expense' ? '− ' : '+ '}${displayAmount}`}
          </Text>
          <Text style={[styles.unit, amountActive && styles.unitActive]}>원</Text>
        </Pressable>

        <View style={styles.memoRow} onTouchStart={collapsePadForKeyboard}>
          <AppIcon name="edit" size={16} color={colors.textMuted} />
          <TextInput
            value={memo}
            onChangeText={setMemo}
            onFocus={() => setPadVisible(false)}
            keyboardType="default"
            placeholder="메모 (선택)"
            placeholderTextColor={colors.textMuted}
            maxLength={40}
            style={styles.memoInput}
          />
        </View>

        {type === 'expense' && (
          <Pressable
            onPress={() => {
              tap();
              setSplitOn((v) => !v);
              setPadVisible(false);
            }}
            style={styles.splitToggle}
          >
            <View style={[styles.checkbox, splitOn && styles.checkboxOn]}>
              {splitOn && <AppIcon name="plus" size={12} color={colors.white} strokeWidth={3} />}
            </View>
            <Text style={styles.splitToggleText}>분할 지출</Text>
            <Text style={styles.splitToggleHint}>
              {splitOn ? '한 지출을 여러 카테고리로 나눠요' : '필요할 때만 켜세요'}
            </Text>
          </Pressable>
        )}

          {!splitOn ? (
            <>
              <Text style={styles.catLabel}>카테고리</Text>
              <ScrollView
                horizontal
                style={styles.catScroll}
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.catPicker}
              >
                {cats.map((c) => {
                  const active = category === c.id;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => {
                        tap();
                        setCategory(c.id);
                      }}
                      style={[styles.catPick, active && styles.catPickActive]}
                    >
                      <View
                        style={[
                          styles.catPickIcon,
                          { backgroundColor: active ? colors.primary : c.bg },
                        ]}
                      >
                        <AppIcon
                          name={c.icon}
                          size={16}
                          color={active ? colors.white : c.color}
                          strokeWidth={2.2}
                        />
                      </View>
                      <Text
                        style={{
                          fontFamily: active ? fontFamily.bold : fontFamily.medium,
                          fontSize: 10,
                          color: active ? colors.primaryStrong : colors.text,
                        }}
                      >
                        {c.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </>
          ) : (
            <>
              <View style={styles.splitHeadRow}>
                <Text style={styles.catLabel}>분할 내역</Text>
                <Text style={styles.splitTotalHint}>총 {fmt(total)}원</Text>
              </View>

              {splits.map((row, i) => {
                const splitActive =
                  numTarget?.kind === 'split' && numTarget.index === i;
                const hasAmt = !!row.amount && Number(row.amount) > 0;
                return (
                <View key={i} style={[styles.splitRow, splitActive && styles.splitRowActive]}>
                  <View style={styles.splitRowTop}>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      keyboardShouldPersistTaps="handled"
                      contentContainerStyle={{ gap: 4, alignItems: 'center', paddingRight: 4 }}
                      style={{ flex: 1 }}
                    >
                      {cats.map((c) => {
                        const active = row.category === c.id;
                        return (
                          <Pressable
                            key={c.id}
                            onPress={() => {
                              tap();
                              setSplitRow(i, { category: c.id });
                            }}
                            style={[styles.splitCatChip, active && styles.splitCatChipOn]}
                          >
                            <AppIcon
                              name={c.icon}
                              size={12}
                              color={active ? colors.white : c.color}
                              strokeWidth={2.2}
                            />
                            <Text
                              style={{
                                fontFamily: active ? fontFamily.bold : fontFamily.medium,
                                fontSize: 11,
                                color: active ? colors.white : colors.text,
                              }}
                            >
                              {c.name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                    <Pressable
                      onPress={() => removeSplitRow(i)}
                      disabled={splits.length <= 2}
                      hitSlop={8}
                      style={{ padding: 6, opacity: splits.length <= 2 ? 0.3 : 1 }}
                    >
                      <AppIcon name="trash" size={16} color={colors.expenseText} />
                    </Pressable>
                  </View>
                  <Pressable
                    style={styles.splitAmountRow}
                    onPress={() => {
                      Keyboard.dismiss();
                      setNumTarget({ kind: 'split', index: i });
                    }}
                  >
                    <Text
                      style={[
                        styles.splitAmountInput,
                        !hasAmt && { color: colors.textMuted },
                        splitActive && { color: colors.primaryStrong },
                      ]}
                    >
                      {hasAmt ? fmt(Number(row.amount)) : '0'}
                    </Text>
                    <Text
                      style={[
                        styles.splitAmountUnit,
                        splitActive && { color: colors.primaryStrong },
                      ]}
                    >
                      원
                    </Text>
                  </Pressable>
                </View>
                );
              })}

              <Pressable onPress={addSplitRow} style={styles.splitAddBtn}>
                <AppIcon name="plus" size={14} color={colors.primaryStrong} strokeWidth={2.6} />
                <Text style={styles.splitAddText}>분할 추가</Text>
              </Pressable>

              <View style={styles.splitSumRow}>
                <Text style={styles.splitSumLabel}>분할 합계</Text>
                <Text
                  style={[
                    styles.splitSumValue,
                    { color: splitCheck.ok ? colors.incomeStrong : colors.expenseText },
                  ]}
                >
                  {fmt(splitCheck.sum)}원
                </Text>
              </View>
              <Text
                style={[
                  styles.splitStatus,
                  { color: splitCheck.ok ? colors.incomeStrong : colors.expenseText },
                ]}
              >
                {splitCheck.ok
                  ? '✓ 금액이 일치합니다.'
                  : splitCheck.error === 'sum-mismatch'
                    ? `⚠ 분할 금액이 총 금액과 일치하지 않습니다. (차액 ${fmt(Math.abs(total - splitCheck.sum))}원)`
                    : `⚠ ${SPLIT_ERROR_TEXT[splitCheck.error ?? 'sum-mismatch']}`}
              </Text>
            </>
          )}

          {type === 'expense' && (
            <View style={styles.paySection}>
              <Text style={styles.catLabel}>결제수단 (선택)</Text>
              <View style={styles.payMethodRow}>
                {PAY_METHODS.map((pm) => {
                  const active = paymentMethod === pm.value;
                  return (
                    <Pressable
                      key={pm.value}
                      onPress={() => {
                        tap();
                        setPaymentMethod(active ? undefined : pm.value);
                        if (pm.value === 'credit' && !active) setPadVisible(false);
                      }}
                      style={[styles.payChip, active && styles.payChipOn]}
                    >
                      <Text style={[styles.payChipText, active && styles.payChipTextOn]}>
                        {pm.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {paymentMethod === 'credit' && (
                <View style={styles.creditPanel}>
                  <Text style={styles.creditLabel}>카드</Text>
                  <View style={styles.payChipRow}>
                    {cards.map((c) => {
                      const active = cardId === c.id;
                      return (
                        <Pressable
                          key={c.id}
                          onPress={() => {
                            tap();
                            setCardId(active ? undefined : c.id);
                          }}
                          style={[styles.payChip, active && styles.payChipOn]}
                        >
                          <Text style={[styles.payChipText, active && styles.payChipTextOn]}>
                            {c.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                    <Pressable
                      onPress={() => router.push('/card-add')}
                      style={styles.payChipAdd}
                    >
                      <AppIcon name="plus" size={12} color={colors.primaryStrong} strokeWidth={2.6} />
                      <Text style={styles.payChipAddText}>카드 등록</Text>
                    </Pressable>
                  </View>
                  {cards.length === 0 && (
                    <Text style={styles.creditHint}>
                      등록된 카드가 없어요. 지금 저장하면 「카드 미지정」으로 기록돼요.
                    </Text>
                  )}

                  <Text style={[styles.creditLabel, { marginTop: 12 }]}>결제 방식</Text>
                  <View style={styles.payChipRow}>
                    {([['lump', '일시불'], ['inst', '할부']] as const).map(([k, label]) => {
                      const active = (k === 'inst') === installmentOn;
                      return (
                        <Pressable
                          key={k}
                          onPress={() => {
                            tap();
                            setInstallmentOn(k === 'inst');
                            setPadVisible(false);
                          }}
                          style={[styles.payChip, active && styles.payChipOn]}
                        >
                          <Text style={[styles.payChipText, active && styles.payChipTextOn]}>
                            {label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  {installmentOn && (
                    <>
                      <Text style={[styles.creditLabel, { marginTop: 12 }]}>할부 개월</Text>
                      <View style={styles.payChipRow}>
                        {INSTALLMENT_PRESETS.map((m) => {
                          const active = installmentMonths === m;
                          return (
                            <Pressable
                              key={m}
                              onPress={() => {
                                tap();
                                setInstallmentMonths(m);
                              }}
                              style={[styles.payChip, active && styles.payChipOn]}
                            >
                              <Text style={[styles.payChipText, active && styles.payChipTextOn]}>
                                {m}개월
                              </Text>
                            </Pressable>
                          );
                        })}
                        <Pressable
                          onPress={() => {
                            Keyboard.dismiss();
                            setNumTarget({ kind: 'installment' });
                          }}
                          style={[
                            styles.instInput,
                            { alignItems: 'center', justifyContent: 'center' },
                            numTarget?.kind === 'installment' && styles.instInputActive,
                          ]}
                        >
                          <Text
                            style={{
                              fontFamily: fontFamily.semibold,
                              fontSize: 12,
                              color:
                                numTarget?.kind === 'installment'
                                  ? colors.primaryStrong
                                  : installmentMonths
                                    ? colors.text
                                    : colors.textMuted,
                            }}
                          >
                            {installmentMonths || '직접'}
                          </Text>
                        </Pressable>
                      </View>
                      {instPreview ? (
                        <Text style={styles.creditPreview}>
                          월 약 {fmt(instPreview.perMonth)}원 × {instMonths}개월
                          {instPreview.lastMonth !== instPreview.perMonth
                            ? ` · 마지막 달 ${fmt(instPreview.lastMonth)}원`
                            : ''}
                        </Text>
                      ) : (
                        <Text style={styles.creditWarn}>할부는 2개월 이상이어야 해요.</Text>
                      )}
                    </>
                  )}
                </View>
              )}
            </View>
          )}
      </ScrollView>

      {/* Keypad / collapsed bar */}
      {padVisible ? (
        <View style={[styles.numPad, { paddingBottom: insets.bottom + 16 }]}>
          <View style={{ flexDirection: 'row', gap: KEY_GAP }}>
            {/* digit block */}
            <View style={{ flex: 3, gap: KEY_GAP }}>
              {[
                ['1', '2', '3'],
                ['4', '5', '6'],
                ['7', '8', '9'],
              ].map((row) => (
                <View key={row[0]} style={{ flexDirection: 'row', gap: KEY_GAP }}>
                  {row.map((n) => (
                    <NumKey key={n} label={n} onPress={() => onKey(n)} />
                  ))}
                </View>
              ))}
              <View style={{ flexDirection: 'row', gap: KEY_GAP }}>
                <NumKey label="00" ghost onPress={() => onKey('00')} />
                <NumKey label="0" onPress={() => onKey('0')} />
                <View style={{ flex: 1 }} />
              </View>
            </View>

            {/* backspace + 완료 */}
            <View style={{ flex: 1, gap: KEY_GAP }}>
              <Pressable
                onPress={() => onKey('back')}
                style={({ pressed }) => [
                  styles.key,
                  { height: KEY_HEIGHT },
                  pressed && styles.keyPressed,
                ]}
              >
                <AppIcon name="backspace" size={22} color={colors.textSub} />
              </Pressable>
              <Pressable
                onPress={() => setPadVisible(false)}
                style={{ flex: 1, borderRadius: radii.lg, overflow: 'hidden' }}
              >
                <LinearGradient
                  colors={gradients.primary}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.doneKey}
                >
                  <AppIcon name="down" size={18} color={colors.white} strokeWidth={2.5} />
                  <Text style={styles.doneKeyText}>완료</Text>
                </LinearGradient>
              </Pressable>
            </View>
          </View>

          <Pressable
            onPress={() => void save()}
            disabled={!canSave || submitting || deleting}
            style={({ pressed }) => [
              styles.saveBtn,
              { opacity: !canSave || submitting || deleting ? 0.4 : pressed ? 0.92 : 1, marginTop: 10 },
            ]}
          >
            <LinearGradient
              colors={gradients.primary}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.saveBtnFill}
            >
              <Text style={styles.saveBtnText}>{submitting ? '저장 중…' : saveLabel}</Text>
            </LinearGradient>
          </Pressable>
        </View>
      ) : (
        <View
          style={[
            styles.collapsedBar,
            { paddingBottom: insets.bottom + 12 },
          ]}
        >
          <Pressable onPress={openAmountPad} style={styles.reopenBtn}>
            <AppIcon name="chev-up" size={20} color={colors.textSub} />
          </Pressable>
          <Pressable
            onPress={() => void save()}
            disabled={!canSave || submitting || deleting}
            style={({ pressed }) => [
              styles.saveBtn,
              { flex: 1, opacity: !canSave || submitting || deleting ? 0.4 : pressed ? 0.92 : 1 },
            ]}
          >
            <LinearGradient
              colors={gradients.primary}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.saveBtnFill}
            >
              <Text style={styles.saveBtnText}>{submitting ? '저장 중…' : saveLabel}</Text>
            </LinearGradient>
          </Pressable>
        </View>
      )}

      {/* Date sheet */}
      <CalendarSheet
        visible={showDate}
        value={selectedDate}
        maxDate={today}
        onSelect={setSelectedDate}
        onClose={() => setShowDate(false)}
      />

      {/* Paste sheet */}
      {showPaste && (
        <Pressable style={styles.backdrop} onPress={() => setShowPaste(false)}>
          <KeyboardAvoidingView behavior="padding" style={{ width: '100%' }}>
            <Pressable
              style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}
              onPress={(e) => e.stopPropagation()}
            >
              <View style={styles.sheetHead}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <AppIcon name="clipboard" size={16} color={colors.primaryStrong} />
                  <Text style={styles.sheetTitle}>카드 문자 붙여넣기</Text>
                </View>
                <Pressable onPress={() => setShowPaste(false)} hitSlop={10}>
                  <AppIcon name="x" size={18} color={colors.textSub} />
                </Pressable>
              </View>

              <View style={styles.hintBox}>
                <Text style={styles.hintText}>
                  아래 칸을 눌러 복사해 둔 카드 승인 문자를 붙여넣어 주세요.
                </Text>
              </View>

              <TextInput
                value={pasteText}
                onChangeText={setPasteText}
                multiline
                autoFocus
                placeholder="여기에 카드 문자를 붙여넣기…"
                placeholderTextColor={colors.textMuted}
                style={styles.pasteInput}
              />

              <Pressable
                onPress={async () => {
                  try {
                    const t = await Clipboard.getStringAsync();
                    if (t && t.trim()) {
                      setPasteText(t);
                      return;
                    }
                    throw new Error('empty');
                  } catch {
                    Alert.alert(
                      '자동 붙여넣기를 못 했어요',
                      '위 칸을 길게 눌러 "붙여넣기"를 선택해 주세요.',
                    );
                  }
                }}
                style={styles.pasteTryBtn}
              >
                <AppIcon name="clipboard" size={13} color={colors.primaryStrong} />
                <Text style={styles.pasteTryText}>클립보드에서 가져오기</Text>
              </Pressable>

              {pastePreview && pastePreview.amount > 0 && (
                <View style={styles.previewCard}>
                  <Text style={styles.previewEyebrow}>이렇게 채울게요</Text>
                  <PreviewRow
                    k="유형"
                    v={pastePreview.type === 'income' ? '수입' : '지출'}
                    color={
                      pastePreview.type === 'income'
                        ? colors.incomeStrong
                        : colors.expenseText
                    }
                  />
                  <PreviewRow k="금액" v={`${fmt(pastePreview.amount)}원`} />
                  {!!pastePreview.merchant && (
                    <PreviewRow k="메모" v={pastePreview.merchant} />
                  )}
                  {!!pastePreview.category && (
                    <PreviewRow
                      k="카테고리"
                      v={getCat(pastePreview.category, pastePreview.type, customCats).name}
                    />
                  )}
                </View>
              )}
              {pastePreview &&
                pastePreview.amount === 0 &&
                pasteText.trim().length > 5 && (
                  <View style={styles.previewWarn}>
                    <Text style={styles.previewWarnText}>
                      금액을 못 찾았어요. "12,500원"처럼 원 단위 금액이 들어간 문자를
                      붙여넣어 주세요.
                    </Text>
                  </View>
                )}

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                <Pressable
                  onPress={() => setShowPaste(false)}
                  style={[styles.sheetSecondary, { flex: 1 }]}
                >
                  <Text style={styles.sheetSecondaryText}>취소</Text>
                </Pressable>
                <Pressable
                  onPress={applyPaste}
                  disabled={!pastePreview || pastePreview.amount === 0}
                  style={[
                    styles.sheetCta,
                    { flex: 2 },
                    (!pastePreview || pastePreview.amount === 0) && { opacity: 0.4 },
                  ]}
                >
                  <LinearGradient
                    colors={gradients.primary}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.sheetCtaFill}
                  >
                    <Text style={styles.saveBtnText}>이대로 채우기</Text>
                  </LinearGradient>
                </Pressable>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      )}
    </View>
  );
}

function NumKey({
  label,
  ghost,
  onPress,
}: {
  label: string;
  ghost?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.key,
        { flex: 1, height: KEY_HEIGHT },
        ghost && styles.keyGhost,
        pressed && !ghost && styles.keyPressed,
        pressed && ghost && { opacity: 0.5 },
      ]}
    >
      <Text
        style={{
          fontFamily: fontFamily.semibold,
          fontSize: ghost ? 20 : 22,
          // Keep this inline keypad visually in sync with
          // src/components/ui/NumPad.tsx — Android font padding otherwise
          // pushes the digit glyph below the button's centre.
          ...noPad,
          lineHeight: ghost ? 20 : 22,
          textAlignVertical: 'center',
          color: ghost ? colors.textSub : colors.text,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function PreviewRow({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <View style={styles.previewRow}>
      <Text style={styles.previewKey}>{k}</Text>
      <Text style={[styles.previewVal, color ? { color } : null]}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  iconBtn: { padding: 4 },
  datePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  datePillText: {
    fontFamily: fontFamily.semibold,
    fontSize: 13,
    color: colors.text,
  },

  typeTabs: {
    flexDirection: 'row',
    gap: 4,
    marginHorizontal: spacing.xl,
    marginTop: spacing.sm,
    padding: 4,
    backgroundColor: colors.border,
    borderRadius: radii.md,
  },
  typeTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 9,
  },
  typeTabActive: {
    backgroundColor: colors.white,
  },

  pillRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginTop: 10,
  },
  pastePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.primaryLight,
    borderRadius: radii.pill,
  },
  pastePillOn: {
    backgroundColor: colors.primary,
  },
  pastePillText: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    color: colors.primaryStrong,
  },
  quickPanel: {
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: spacing.lg,
    marginTop: 10,
  },
  quickInput: {
    flex: 1,
    paddingVertical: 11,
    paddingHorizontal: 14,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.md,
    fontFamily: fontFamily.regular,
    fontSize: 14,
    color: colors.text,
  },
  quickBtn: { borderRadius: radii.md, overflow: 'hidden' },
  quickBtnFill: {
    paddingHorizontal: 16,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickBtnText: { fontFamily: fontFamily.bold, fontSize: 14, color: colors.white },
  quickResultText: {
    marginHorizontal: spacing.lg,
    marginTop: 8,
    fontFamily: fontFamily.medium,
    fontSize: 11,
    lineHeight: 16,
    color: colors.primaryStrong,
  },
  quickErr: {
    marginHorizontal: spacing.lg,
    marginTop: 8,
    fontFamily: fontFamily.medium,
    fontSize: 11,
    lineHeight: 16,
    color: colors.expenseText,
  },

  // The whole form scrolls as one; `formContent` reserves room at the bottom so
  // the last field (결제수단 / 카드 / 할부) clears the fixed keypad and can be
  // pulled fully into view, not just left half-hidden behind it.
  formScroll: { flex: 1 },
  formContent: { flexGrow: 1, paddingTop: spacing.xs, paddingBottom: 32 },

  amountRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'baseline',
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: 22,
    paddingBottom: spacing.sm,
    // 1px transparent border kept in the base style so toggling the active
    // state never shifts the layout by a pixel.
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  // Active = the custom keypad is open. Faint lavender wash + a very light
  // lavender hairline — softer than a full primary border so it reads as a
  // state change, not a second input card. The purple "0"/"원" carry the cue.
  amountRowActive: {
    backgroundColor: colors.primaryLighter,
    borderColor: colors.primaryLight,
  },
  amount: {
    fontFamily: fontFamily.extrabold,
    fontSize: 44,
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
    // Let very large amounts (e.g. 1,000,000,000+) scale down instead of
    // pushing "원" off-screen. `flexShrink` bounds the width so
    // adjustsFontSizeToFit has room to work.
    flexShrink: 1,
    textAlign: 'center',
  },
  unit: {
    fontFamily: fontFamily.semibold,
    fontSize: 20,
    color: colors.textSub,
    marginLeft: 8,
  },
  unitActive: {
    color: colors.primaryStrong,
  },

  memoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  memoInput: {
    flex: 1,
    padding: 0,
    fontFamily: fontFamily.regular,
    fontSize: 14,
    color: colors.text,
  },

  catLabel: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: 0.2,
    color: colors.textSub,
  },
  // `flexGrow:0` keeps this horizontal strip at its content height inside the
  // form scroll; without it the row (and the active pill's fill) stretch.
  catScroll: { flexGrow: 0, flexShrink: 0 },
  catPicker: {
    paddingHorizontal: spacing.lg,
    gap: 4,
    alignItems: 'center',
  },
  catPick: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
    minWidth: 58,
    borderRadius: radii.md,
  },
  catPickActive: { backgroundColor: colors.primaryLight },
  catPickIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ---- split expense ---- */
  splitToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  splitToggleText: { fontFamily: fontFamily.bold, fontSize: 13, color: colors.text },
  splitToggleHint: {
    flex: 1,
    textAlign: 'right',
    fontFamily: fontFamily.regular,
    fontSize: 10,
    color: colors.textMuted,
  },
  splitHeadRow: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingRight: spacing.xl,
  },
  splitTotalHint: {
    fontFamily: fontFamily.semibold,
    fontSize: 11,
    color: colors.textSub,
    fontVariant: ['tabular-nums'],
  },
  splitRow: {
    marginHorizontal: spacing.lg,
    marginBottom: 8,
    padding: 10,
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // Active = the inline keypad is aimed at this row's 금액. Same faint lavender
  // cue as the main amount row's `amountRowActive`.
  splitRowActive: {
    backgroundColor: colors.primaryLighter,
    borderColor: colors.primaryLight,
  },
  splitRowTop: { flexDirection: 'row', alignItems: 'center' },
  splitCatChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.track,
  },
  splitCatChipOn: { backgroundColor: colors.primary },
  splitAmountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.track,
  },
  splitAmountInput: {
    flex: 1,
    padding: 0,
    fontFamily: fontFamily.bold,
    fontSize: 16,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  splitAmountUnit: {
    fontFamily: fontFamily.semibold,
    fontSize: 13,
    color: colors.textSub,
    marginLeft: 6,
  },
  splitAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginHorizontal: spacing.lg,
    marginTop: 2,
    marginBottom: 10,
    paddingVertical: 11,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.primaryLight,
    borderStyle: 'dashed',
    backgroundColor: colors.primaryLighter,
  },
  splitAddText: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    color: colors.primaryStrong,
  },
  splitSumRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.sm,
  },
  splitSumLabel: {
    fontFamily: fontFamily.semibold,
    fontSize: 12,
    color: colors.textSub,
  },
  splitSumValue: {
    fontFamily: fontFamily.extrabold,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  splitStatus: {
    marginHorizontal: spacing.lg,
    marginTop: 4,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.md,
    fontFamily: fontFamily.semibold,
    fontSize: 11,
    lineHeight: 16,
  },

  /* ---- payment method / card / 할부 ---- */
  paySection: {
    marginTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  payChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  payMethodRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: spacing.lg,
  },
  payChip: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
  },
  payChipOn: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  payChipText: {
    fontFamily: fontFamily.semibold,
    fontSize: 12,
    color: colors.textSub,
  },
  payChipTextOn: { color: colors.white },
  payChipAdd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.primaryLighter,
    borderWidth: 1,
    borderColor: colors.primaryLight,
    borderStyle: 'dashed',
  },
  payChipAddText: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    color: colors.primaryStrong,
  },
  creditPanel: {
    marginTop: 10,
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  creditLabel: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: 0.2,
    color: colors.textSub,
  },
  creditHint: {
    marginTop: 8,
    paddingHorizontal: spacing.xs,
    fontFamily: fontFamily.regular,
    fontSize: 10,
    lineHeight: 15,
    color: colors.textMuted,
  },
  creditPreview: {
    marginTop: 10,
    paddingHorizontal: spacing.xs,
    fontFamily: fontFamily.bold,
    fontSize: 12,
    color: colors.primaryStrong,
  },
  creditWarn: {
    marginTop: 10,
    paddingHorizontal: spacing.xs,
    fontFamily: fontFamily.semibold,
    fontSize: 11,
    color: colors.expenseText,
  },
  instInput: {
    minWidth: 56,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // Active = the inline keypad is entering a custom 할부 개월 count.
  instInputActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLighter,
  },

  numPad: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.border,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
  },
  key: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyGhost: { backgroundColor: 'transparent' },
  keyPressed: { backgroundColor: colors.track },
  doneKey: {
    flex: 1,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  doneKeyText: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    color: colors.white,
  },

  saveBtn: { borderRadius: radii.xl, overflow: 'hidden' },
  saveBtnFill: {
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    fontFamily: fontFamily.bold,
    fontSize: 16,
    color: colors.white,
  },

  collapsedBar: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.border,
  },
  reopenBtn: {
    width: 48,
    height: 48,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlayStrong,
    justifyContent: 'flex-end',
  },
  sheet: {
    width: '100%',
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.xl,
    paddingTop: 18,
  },
  sheetHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sheetTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    color: colors.text,
  },
  fieldLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: 0.2,
    color: colors.textSub,
    marginBottom: 8,
  },
  quickDate: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
  },
  quickDateActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  stepBtn: { padding: 8 },
  stepValue: {
    fontFamily: fontFamily.semibold,
    fontSize: 15,
    color: colors.text,
  },
  sheetCta: { borderRadius: radii.lg, overflow: 'hidden', marginTop: 16 },
  sheetCtaFill: {
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetSecondary: {
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    marginTop: 16,
  },
  sheetSecondaryText: {
    fontFamily: fontFamily.semibold,
    fontSize: 14,
    color: colors.textSub,
  },

  hintBox: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: colors.warningLight,
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: radii.md,
    marginBottom: 12,
  },
  hintText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    color: colors.warningText,
    lineHeight: 18,
  },
  pasteInput: {
    minHeight: 130,
    padding: 14,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.primary,
    borderStyle: 'dashed',
    backgroundColor: colors.white,
    fontFamily: fontFamily.regular,
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
    textAlignVertical: 'top',
  },
  pasteTryBtn: {
    marginTop: 8,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  pasteTryText: {
    fontFamily: fontFamily.semibold,
    fontSize: 12,
    color: colors.primaryStrong,
  },
  previewCard: {
    marginTop: 12,
    padding: 14,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.primaryLight,
    borderRadius: radii.lg,
  },
  previewEyebrow: {
    fontFamily: fontFamily.bold,
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.primaryStrong,
    marginBottom: 8,
  },
  previewRow: {
    flexDirection: 'row',
    marginTop: 6,
  },
  previewKey: {
    width: 64,
    fontFamily: fontFamily.regular,
    fontSize: 13,
    color: colors.textSub,
  },
  previewVal: {
    flex: 1,
    fontFamily: fontFamily.semibold,
    fontSize: 13,
    color: colors.text,
  },
  previewWarn: {
    marginTop: 10,
    padding: 10,
    backgroundColor: colors.expenseLight,
    borderRadius: radii.sm,
  },
  previewWarnText: {
    fontFamily: fontFamily.regular,
    fontSize: 12,
    color: colors.expenseStrong,
    lineHeight: 17,
  },
});
