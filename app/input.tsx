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
  type LayoutChangeEvent,
  Platform,
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
import { describeAccount } from '@/lib/asset';
import { cardTypeOf, debitSourceAssetId, installmentPerMonth } from '@/lib/card';
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

// BATCH: home/input UI compaction — 52→45 (≈13% per key) combined with the
// KEY_GAP trim below brings the whole 4-row digit block down ≈14%, within
// the requested 10–15% without shrinking the digit fontSize (kept at 22 in
// NumKey below) or the touch target below a comfortable size.
const KEY_HEIGHT = 45;
const KEY_GAP = 5;

/**
 * NUMPAD BACKSPACE LONG-PRESS REPEAT UX FIX — same interaction as
 * src/components/ui/NumPad.tsx's backspace key, duplicated here (not
 * imported) because this screen's keypad is its own inline copy, not the
 * shared component. A tap deletes exactly one digit; holding repeats after a
 * short delay until release. `onBackspace` is called repeatedly from a plain
 * `setInterval` — this screen's `onKey('back')` already applies its edit via
 * a functional `setState(prev => ...)` update, so calling it many times in a
 * row is safe with no stale-value risk.
 */
const BACKSPACE_REPEAT_DELAY_MS = 400;
const BACKSPACE_REPEAT_INTERVAL_MS = 80;

/** `onPressIn`/`onPressOut` pair for a press-and-hold-to-repeat backspace key.
 *  Deliberately NOT `onPress` — layering `onPress` on top of an immediate
 *  onPressIn delete would double-delete every tap, and firing it again on
 *  release after a long-press would delete one extra digit. */
function useBackspaceRepeat(onBackspace: () => void) {
  const delayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = () => {
    if (delayTimer.current != null) {
      clearTimeout(delayTimer.current);
      delayTimer.current = null;
    }
    if (repeatTimer.current != null) {
      clearInterval(repeatTimer.current);
      repeatTimer.current = null;
    }
  };

  // Unmount / navigation-away safety — a held key never keeps deleting after
  // the screen is gone.
  useEffect(() => clearTimers, []);

  const onPressIn = () => {
    clearTimers(); // defensive: a stray leftover timer never survives a new press
    onBackspace(); // the tap itself — exactly one digit, immediately
    delayTimer.current = setTimeout(() => {
      delayTimer.current = null;
      repeatTimer.current = setInterval(onBackspace, BACKSPACE_REPEAT_INTERVAL_MS);
    }, BACKSPACE_REPEAT_DELAY_MS);
  };

  // Release OR cancel (RN fires onPressOut in both cases) -> stop immediately.
  const onPressOut = () => {
    clearTimers();
  };

  return { onPressIn, onPressOut };
}

/**
 * Breathing room left ABOVE the 결제수단 section (which now holds the
 * freshly-rendered 신용카드 panel) when it is auto-scrolled into view —
 * cosmetic padding on top of a *measured* onLayout coordinate, NOT a guessed
 * scroll position (see the credit auto-scroll handler below).
 */
const CREDIT_SCROLL_HEADROOM = 16;
/** Same idea for the 할부 상세 (개월 / preset / 직접 / preview) block. */
const INSTALLMENT_SCROLL_HEADROOM = 12;
/**
 * Same idea for the initial 메모 row reveal (see `maybeRevealMemoRowOnce`) —
 * deliberately the smallest spacing token, not a hand-picked number: the ask
 * is "just barely uncovered", so this should add as little extra scroll as
 * possible on top of the measured minimum.
 */
const MEMO_ROW_SCROLL_HEADROOM = spacing.xs;

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
  const { status, error, cards, assets, customCats, catOrder, refresh } = useFinanceRead();
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
  // 출금 계좌 — a record of which account paid; never changes a balance.
  // 이체: picked by the user. 체크: COPIED from the 체크카드's linked account
  // when the card is chosen, so an edit keeps the account this transaction
  // was saved with even if the card has been re-linked since.
  const [sourceAssetId, setSourceAssetId] = useState<string | undefined>(
    editing?.paymentMethod === 'transfer' || editing?.paymentMethod === 'debit'
      ? editing.sourceAssetId
      : undefined,
  );
  // 수입 입금처 — 'transfer' + this account, or 'cash' with no account. Never
  // required; a legacy income simply has neither.
  const [destinationAssetId, setDestinationAssetId] = useState<string | undefined>(
    editing?.type === 'income' && editing.paymentMethod === 'transfer'
      ? editing.destinationAssetId
      : undefined,
  );
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

  // 지출 <-> 수입: 결제수단 and 입금처 are different things, so a real type
  // flip clears the whole payment link (card, 할부, 출금 계좌, 입금처). Keyed
  // on an actual CHANGE so an edit form's initial values are never wiped.
  const prevTypeRef = useRef(type);
  useEffect(() => {
    if (prevTypeRef.current === type) return;
    prevTypeRef.current = type;
    setPaymentMethod(undefined);
    setCardId(undefined);
    setInstallmentOn(false);
    setSourceAssetId(undefined);
    setDestinationAssetId(undefined);
  }, [type]);

  // Detail links only apply to their own method; clear them otherwise:
  // card -> 신용/체크, 할부 -> 신용 only, 출금 계좌 -> 이체/체크 only,
  // 입금처 계좌 -> 수입 'transfer' only.
  useEffect(() => {
    if (paymentMethod !== 'credit' && paymentMethod !== 'debit' && cardId !== undefined) {
      setCardId(undefined);
    }
    if (paymentMethod !== 'credit' && installmentOn) setInstallmentOn(false);
    if (paymentMethod !== 'transfer' && paymentMethod !== 'debit' && sourceAssetId !== undefined) {
      setSourceAssetId(undefined);
    }
    if (paymentMethod !== 'transfer' && destinationAssetId !== undefined) {
      setDestinationAssetId(undefined);
    }
  }, [paymentMethod, cardId, installmentOn, sourceAssetId, destinationAssetId]);

  // Picker lists. The card / account already on this transaction stays listed
  // even if it no longer matches the filter (e.g. its type was changed later).
  const creditCards = cards.filter((c) => cardTypeOf(c) === 'credit' || c.id === cardId);
  const debitCards = cards.filter((c) => cardTypeOf(c) === 'debit' || c.id === cardId);
  const accounts = assets.filter((a) => a.type === 'bank' || a.id === sourceAssetId);
  // A stored 출금 계좌 that is no longer an active asset (soft-deleted): kept
  // as-is on save, just not selectable.
  const sourceAssetMissing = !!sourceAssetId && !assets.some((a) => a.id === sourceAssetId);
  const sourceAsset = sourceAssetId ? assets.find((a) => a.id === sourceAssetId) : undefined;
  // 수입 입금처 choices: active 은행계좌 (+ the stored one if its type changed).
  const depositAccounts = assets.filter((a) => a.type === 'bank' || a.id === destinationAssetId);
  const destinationMissing =
    !!destinationAssetId && !assets.some((a) => a.id === destinationAssetId);

  /** The account to copy onto a NEW 체크카드 pick — only an active one. */
  const debitAccountFor = (card: (typeof cards)[number]): string | undefined => {
    const linked = debitSourceAssetId(card);
    return linked && assets.some((a) => a.id === linked) ? linked : undefined;
  };

  // 체크카드 ↔ 출금 계좌. The account is COPIED onto the transaction when a
  // card is picked (balance sync moves THAT account). An edit that keeps the
  // transaction's original card keeps its original account — or, for a
  // legacy row saved before cards had accounts, keeps having none.
  const selectedDebitCard =
    type === 'expense' && paymentMethod === 'debit' && cardId ? cards.find((c) => c.id === cardId) : undefined;
  const isOriginalDebitPick =
    !!editing && editing.paymentMethod === 'debit' && editing.cardId === cardId;
  // A card picked here that only got its account just now (e.g. the user
  // linked it via 「카드 수정」 and came back): pick that account up.
  const pendingDebitAccount =
    selectedDebitCard && !sourceAssetId && !isOriginalDebitPick ? debitAccountFor(selectedDebitCard) : undefined;
  useEffect(() => {
    if (pendingDebitAccount) setSourceAssetId(pendingDebitAccount);
  }, [pendingDebitAccount]);
  // A newly picked 체크카드 with no active 출금 계좌 can't be saved: its spend
  // would have no account to come out of.
  const debitNeedsAccount = !!selectedDebitCard && !sourceAssetId && !isOriginalDebitPick && !pendingDebitAccount;

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
    (!installmentActive || instMonths >= 2) &&
    !debitNeedsAccount;
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
  // NUMPAD BACKSPACE LONG-PRESS REPEAT UX FIX — repeats the SAME onKey('back')
  // (so amount / split / installment-months semantics per `numTarget` are
  // completely unchanged) while the key is held; see `useBackspaceRepeat`.
  const backspaceRepeat = useBackspaceRepeat(() => onKey('back'));

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

  // ---- 결제수단 section auto-scroll (input auto-scroll fix) ----
  // The form is ONE <ScrollView>; the number pad is a normal-flow sibling
  // BELOW it (styles.numPad, no overlay), so opening it flex-shrinks the
  // ScrollView. We track the ScrollView's OWN onLayout height as the real
  // visible viewport (no numPad-height spacer — that double-counted the pad
  // and over-scrolled). Targets are summed direct-parent onLayout offsets —
  // no measureLayout/findNodeHandle (they throw on Android RN).
  //
  // Three ONE-SHOT intents, one consumer each, armed only by a direct tap:
  //   creditScrollArmRef      "신용" chip  -> handlePaySectionLayout   (top-align)
  //   installmentScrollArmRef "할부" chip  -> handleInstallmentBlockLayout (top-align)
  //   pendingDirectScrollRef  "직접" box (pad closed) -> ScrollView onLayout
  //     (fires once the pad has shrunk the viewport) -> BOTTOM-align above pad
  const formScrollRef = useRef<ScrollView>(null);
  const creditScrollArmRef = useRef(false);
  const installmentScrollArmRef = useRef(false);
  const pendingDirectScrollRef = useRef(false);
  // "체크" / "이체" chip -> handlePayDetailPanelLayout (bottom-align above pad)
  const payDetailScrollArmRef = useRef(false);
  // Measured, cached-fresh geometry (all from plain onLayout events):
  const paySectionYRef = useRef(0); // paySection.y in the scroll content
  const creditPanelYRef = useRef(0); // creditPanel.y in paySection
  const installmentBlockYRef = useRef(0); // 할부 상세 block.y in creditPanel
  const installmentBlockHeightRef = useRef(0); // 할부 상세 block height
  const formViewportHeightRef = useRef(0); // ScrollView's own visible height
  // 메모 입력칸 first-open reveal — see `maybeRevealMemoRowOnce` below.
  const memoRowYRef = useRef(0); // memoRow.y directly in the scroll content
  const memoRowHeightRef = useRef(0); // memoRow height
  // typeTabs.y directly in the scroll content — the hard upper bound on the
  // reveal scroll below (scrolling past this clips 지출/수입 tabs).
  const typeTabsYRef = useRef(0);
  // ONE-SHOT for the LIFETIME of this mount: consumed the first time all
  // measurements below are available, then never re-evaluated again — a
  // later user scroll (or showQuick toggle, or keyboard open) must never be
  // fought or re-corrected.
  const initialMemoScrollArmRef = useRef(true);

  /** 할부 상세 block top in scroll-content coords (summed parent offsets). */
  const installmentBlockTop = () =>
    paySectionYRef.current + creditPanelYRef.current + installmentBlockYRef.current;

  /** "할부" path: bring the block's TOP just inside the viewport. */
  const scrollInstallmentIntoView = () => {
    formScrollRef.current?.scrollTo({
      y: Math.max(0, installmentBlockTop() - INSTALLMENT_SCROLL_HEADROOM),
      animated: true,
    });
  };

  /** "직접" path: the number pad is up, so BOTTOM-align — the block's bottom
   *  edge sits ~gap inside the (shrunk) viewport, right above the pad, not
   *  yanked to the top. Falls back to top-align only if the block is taller
   *  than the viewport. All measured, no fixed pixel target. */
  const scrollInstallmentAbovePad = () => {
    const top = installmentBlockTop();
    const blockH = installmentBlockHeightRef.current;
    const viewportH = formViewportHeightRef.current;
    if (viewportH <= 0 || blockH <= 0) {
      scrollInstallmentIntoView();
      return;
    }
    const y =
      blockH + INSTALLMENT_SCROLL_HEADROOM * 2 <= viewportH
        ? top + blockH - viewportH + INSTALLMENT_SCROLL_HEADROOM // bottom-align
        : top - INSTALLMENT_SCROLL_HEADROOM; // block bigger than viewport
    formScrollRef.current?.scrollTo({ y: Math.max(0, y), animated: true });
  };

  /** ScrollView onLayout — records its real visible height. When a "직접"
   *  scroll is pending (set only by a direct 직접 tap while the pad was
   *  closed), this fires right after the pad mounts and shrinks the
   *  ScrollView, so the measured height is already the post-shrink one. */
  const handleFormScrollLayout = (e: LayoutChangeEvent) => {
    formViewportHeightRef.current = e.nativeEvent.layout.height;
    maybeRevealMemoRowOnce();
    if (!pendingDirectScrollRef.current) return;
    pendingDirectScrollRef.current = false;
    requestAnimationFrame(scrollInstallmentAbovePad);
  };

  /** 메모 입력칸 onLayout — caches its position in the scroll content (a
   *  direct ScrollView child, so no summed parent offsets needed, unlike
   *  the 할부 block above). Also drives the one-shot initial reveal. */
  const handleMemoRowLayout = (e: LayoutChangeEvent) => {
    memoRowYRef.current = e.nativeEvent.layout.y;
    memoRowHeightRef.current = e.nativeEvent.layout.height;
    maybeRevealMemoRowOnce();
  };

  /** typeTabs (지출/수입) onLayout — caches its own top position, the hard
   *  ceiling the reveal scroll below must never exceed. Also drives the
   *  one-shot initial reveal, same as the other two measurements. */
  const handleTypeTabsLayout = (e: LayoutChangeEvent) => {
    typeTabsYRef.current = e.nativeEvent.layout.y;
    maybeRevealMemoRowOnce();
  };

  /**
   * The keypad opens by default (`numTarget` starts as `{kind:'main'}`), so
   * on a short viewport 메모 row can land partly hidden behind it on first
   * open. This fires from the ScrollView's own onLayout, 메모 row's onLayout,
   * and typeTabs' onLayout — whichever settles last is the one that actually
   * has all three measurements — and runs AT MOST ONCE per mount
   * (`initialMemoScrollArmRef`), so it is purely a first-open correction,
   * never a recurring "pull the user back down" behaviour.
   *
   * The scroll target is the MINIMUM needed to clear 메모 row (no extra
   * buffer beyond `MEMO_ROW_SCROLL_HEADROOM`), and is additionally capped at
   * typeTabs' own top (`typeTabsYRef`) so 지출/수입 tabs can never be scrolled
   * out of view for this — if the two constraints can't both be fully
   * satisfied on a given device, keeping 지출/수입 tabs uncropped wins.
   */
  const maybeRevealMemoRowOnce = () => {
    if (!initialMemoScrollArmRef.current) return;
    const viewportH = formViewportHeightRef.current;
    const memoH = memoRowHeightRef.current;
    const typeTabsTop = typeTabsYRef.current;
    if (viewportH <= 0 || memoH <= 0 || typeTabsTop <= 0) return; // wait for all three
    initialMemoScrollArmRef.current = false; // consume now, whatever the outcome
    if (!padVisible) return; // nothing hidden behind a pad that isn't open
    const memoBottom = memoRowYRef.current + memoH;
    const rawY = memoBottom - viewportH + MEMO_ROW_SCROLL_HEADROOM;
    if (rawY <= 0) return; // 메모 row already fully visible — do nothing
    const y = Math.min(rawY, typeTabsTop); // never crop into typeTabs
    if (y <= 0) return;
    requestAnimationFrame(() => {
      formScrollRef.current?.scrollTo({ y, animated: false });
    });
  };

  /** 결제수단 section onLayout — caches paySection.y; when the "신용" intent is
   *  armed, brings the section (now holding the 신용카드 panel) to the top. */
  const handlePaySectionLayout = (e: LayoutChangeEvent) => {
    paySectionYRef.current = e.nativeEvent.layout.y;
    if (!creditScrollArmRef.current) return;
    creditScrollArmRef.current = false;
    formScrollRef.current?.scrollTo({
      y: Math.max(0, paySectionYRef.current - CREDIT_SCROLL_HEADROOM),
      animated: true,
    });
  };

  /** 신용카드 panel onLayout — caches its offset within paySection. */
  const handleCreditPanelLayout = (e: LayoutChangeEvent) => {
    creditPanelYRef.current = e.nativeEvent.layout.y;
  };

  /** 체크카드 / 출금 계좌 panel onLayout. Unlike "신용", picking 체크/이체 keeps
   *  the number pad open, so the panel that just mounted under the chips
   *  lands below the pad-shrunk viewport. When armed (a direct 체크/이체 tap),
   *  BOTTOM-align the panel just above the pad — the smallest scroll that
   *  uncovers it — but never further than top-aligning the 결제수단 section,
   *  so a panel taller than the viewport still shows from its heading down. */
  const handlePayDetailPanelLayout = (e: LayoutChangeEvent) => {
    if (!payDetailScrollArmRef.current) return;
    payDetailScrollArmRef.current = false;
    const viewportH = formViewportHeightRef.current;
    if (viewportH <= 0) return;
    const { y: panelY, height: panelH } = e.nativeEvent.layout;
    const panelBottom = paySectionYRef.current + panelY + panelH;
    const y = Math.min(
      panelBottom - viewportH + CREDIT_SCROLL_HEADROOM,
      paySectionYRef.current - CREDIT_SCROLL_HEADROOM,
    );
    if (y <= 0) return; // already fully visible from the top of the form
    requestAnimationFrame(() => {
      formScrollRef.current?.scrollTo({ y, animated: true });
    });
  };

  /** 할부 상세 block onLayout — caches its y + height; when the "할부" intent
   *  is armed (block just mounted from a 할부 tap), scroll it into view. A
   *  later onLayout from 개월/preview 높이 변경 just refreshes the cache. */
  const handleInstallmentBlockLayout = (e: LayoutChangeEvent) => {
    installmentBlockYRef.current = e.nativeEvent.layout.y;
    installmentBlockHeightRef.current = e.nativeEvent.layout.height;
    if (!installmentScrollArmRef.current) return;
    installmentScrollArmRef.current = false;
    scrollInstallmentIntoView();
  };

  /** Draft-state -> NewTransactionDraft, or null when the form isn't valid. */
  const buildDraft = (): NewTransactionDraft | null => {
    // Defensive re-validation — the DB has CHECK/FK constraints but we do
    // not lean on them for UX (STEP 16-G2-A2 §12).
    if (!(total > 0)) return null;
    if (type !== 'expense' && type !== 'income') return null;
    const isCredit = type === 'expense' && paymentMethod === 'credit';
    const isCard = isCredit || (type === 'expense' && paymentMethod === 'debit');
    const isTransfer = type === 'expense' && paymentMethod === 'transfer';
    const isDebit = type === 'expense' && paymentMethod === 'debit';
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
      // 지출: 결제수단. 수입: 입금 방식 ('cash' / 'transfer'). The mapper keeps
      // only what fits the type (src/lib/paymentLink.ts).
      paymentMethod: paymentMethod ?? undefined,
      cardId: isCard ? cardId ?? undefined : undefined,
      sourceAssetId: isTransfer || isDebit ? sourceAssetId ?? undefined : undefined,
      destinationAssetId:
        type === 'income' && paymentMethod === 'transfer' ? destinationAssetId ?? undefined : undefined,
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
    setSourceAssetId(undefined);
    setDestinationAssetId(undefined);
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
    setSourceAssetId(undefined);
    setDestinationAssetId(undefined);
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

        <Pressable onPress={() => setShowDate(true)} hitSlop={6} style={styles.datePill}>
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
        ref={formScrollRef}
        style={styles.formScroll}
        contentContainerStyle={styles.formContent}
        onLayout={handleFormScrollLayout}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
      {/* Type tabs */}
      <View style={styles.typeTabs} onLayout={handleTypeTabsLayout}>
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

        <View
          style={styles.memoRow}
          onTouchStart={collapsePadForKeyboard}
          onLayout={handleMemoRowLayout}
        >
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
            <View style={styles.paySection} onLayout={handlePaySectionLayout}>
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
                        // 신용 and 체크 pick from different card lists — a card
                        // chosen under one method never carries over.
                        if (!active) {
                          setCardId(undefined);
                          setSourceAssetId(undefined);
                        }
                        if (pm.value === 'credit' && !active) {
                          setPadVisible(false);
                          // non-credit -> credit by a DIRECT user tap: arm the
                          // one-shot auto-scroll so the 신용카드 panel that is
                          // about to render is brought into view.
                          creditScrollArmRef.current = true;
                        }
                        // -> 체크 / 이체 by a DIRECT user tap: the pad stays
                        // open, so arm the one-shot scroll that lifts the
                        // detail panel about to render above it. Any other
                        // tap disarms a stale intent. iOS only — this was
                        // an iOS-reported issue; on Android the ref never
                        // arms, so handlePayDetailPanelLayout stays a no-op.
                        payDetailScrollArmRef.current =
                          Platform.OS === 'ios' &&
                          !active &&
                          (pm.value === 'debit' || pm.value === 'transfer');
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
                <View style={styles.creditPanel} onLayout={handleCreditPanelLayout}>
                  <Text style={styles.creditLabel}>신용카드</Text>
                  <View style={styles.payChipRow}>
                    {creditCards.map((c) => {
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
                  {creditCards.length === 0 && (
                    <Text style={styles.creditHint}>
                      등록된 신용카드가 없어요. 지금 저장하면 「카드 미지정」으로 기록돼요.
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
                            if (k === 'inst' && !installmentOn) {
                              // non-installment -> 할부 by a DIRECT user tap:
                              // arm the one-shot auto-scroll for the 할부 상세
                              // block that is about to render.
                              installmentScrollArmRef.current = true;
                            }
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
                    <View onLayout={handleInstallmentBlockLayout}>
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
                            // "직접": open the pad for custom months, then
                            // bottom-align the 할부 상세 block just above it.
                            //   pad already open -> viewport already shrunk &
                            //     measured, so one rAF is enough;
                            //   pad closed -> mark the intent; the ScrollView's
                            //     onLayout fires once the pad has shrunk it and
                            //     runs the scroll with the post-shrink height.
                            const padWasOpen = numTarget !== null;
                            Keyboard.dismiss();
                            setNumTarget({ kind: 'installment' });
                            if (padWasOpen) {
                              requestAnimationFrame(scrollInstallmentAbovePad);
                            } else {
                              pendingDirectScrollRef.current = true;
                            }
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
                    </View>
                  )}
                </View>
              )}

              {/* 체크카드 — 즉시 지출: no 할부, never part of the 예상 카드값. */}
              {paymentMethod === 'debit' && (
                <View style={styles.creditPanel} onLayout={handlePayDetailPanelLayout}>
                  <Text style={styles.creditLabel}>체크카드</Text>
                  <View style={styles.payChipRow}>
                    {debitCards.map((c) => {
                      const active = cardId === c.id;
                      return (
                        <Pressable
                          key={c.id}
                          onPress={() => {
                            tap();
                            setCardId(active ? undefined : c.id);
                            // Copy the card's account NOW; later re-links of
                            // the card never touch this transaction.
                            setSourceAssetId(active ? undefined : debitAccountFor(c));
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
                      onPress={() => router.push({ pathname: '/card-add', params: { type: 'debit' } })}
                      style={styles.payChipAdd}
                    >
                      <AppIcon name="plus" size={12} color={colors.primaryStrong} strokeWidth={2.6} />
                      <Text style={styles.payChipAddText}>체크카드 등록</Text>
                    </Pressable>
                  </View>
                  {debitCards.length === 0 && (
                    <Text style={styles.creditHint}>
                      등록된 체크카드가 없어요. 카드 없이 저장해도 체크카드 지출로 기록돼요.
                    </Text>
                  )}
                  {sourceAssetId && (
                    <Text style={styles.creditHint}>
                      출금 계좌 · {sourceAsset ? describeAccount(sourceAsset) : '삭제된 계좌'}
                    </Text>
                  )}
                  {debitNeedsAccount && selectedDebitCard && (
                    <Pressable
                      onPress={() => router.push({ pathname: '/card-add', params: { id: selectedDebitCard.id } })}
                      hitSlop={6}
                    >
                      <Text style={[styles.creditHint, { color: colors.expenseText }]}>
                        체크카드의 출금 계좌를 먼저 연결해주세요.{' '}
                        <Text style={{ fontFamily: fontFamily.bold, color: colors.primaryStrong }}>카드 수정</Text>
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}

              {/* 이체 — 출금 계좌; the DB trigger takes the amount out of it on save. */}
              {paymentMethod === 'transfer' && (
                <View style={styles.creditPanel} onLayout={handlePayDetailPanelLayout}>
                  <Text style={styles.creditLabel}>출금 계좌</Text>
                  <View style={styles.payChipRow}>
                    {accounts.map((a) => {
                      const active = sourceAssetId === a.id;
                      return (
                        <Pressable
                          key={a.id}
                          onPress={() => {
                            tap();
                            setSourceAssetId(active ? undefined : a.id);
                          }}
                          style={[styles.payChip, active && styles.payChipOn]}
                        >
                          <Text style={[styles.payChipText, active && styles.payChipTextOn]}>
                            {describeAccount(a)}
                          </Text>
                        </Pressable>
                      );
                    })}
                    <Pressable onPress={() => router.push('/asset-add')} style={styles.payChipAdd}>
                      <AppIcon name="plus" size={12} color={colors.primaryStrong} strokeWidth={2.6} />
                      <Text style={styles.payChipAddText}>계좌 등록</Text>
                    </Pressable>
                  </View>
                  {accounts.length === 0 && !sourceAssetMissing && (
                    <Text style={styles.creditHint}>
                      등록된 계좌가 없어요. 자산 관리에 은행계좌를 등록하면 선택할 수 있어요.
                    </Text>
                  )}
                  {sourceAssetMissing && (
                    <Text style={styles.creditHint}>
                      삭제된 계좌로 기록된 거래예요. 다른 계좌를 고르지 않으면 그대로 유지돼요.
                    </Text>
                  )}
                </View>
              )}
            </View>
          )}

          {/* 수입 입금처 — never required. 현금 = 'cash' (no Asset needed); an
              account = 'transfer' + destination (the DB trigger adds it to that account). */}
          {type === 'income' && (
            <View style={styles.paySection}>
              <Text style={styles.catLabel}>입금처 (선택)</Text>
              <View style={styles.payChipRow}>
                {(() => {
                  const cashOn = paymentMethod === 'cash';
                  return (
                    <Pressable
                      onPress={() => {
                        tap();
                        setDestinationAssetId(undefined);
                        setPaymentMethod(cashOn ? undefined : 'cash');
                      }}
                      style={[styles.payChip, cashOn && styles.payChipOn]}
                    >
                      <Text style={[styles.payChipText, cashOn && styles.payChipTextOn]}>현금</Text>
                    </Pressable>
                  );
                })()}
                {depositAccounts.map((a) => {
                  const active = paymentMethod === 'transfer' && destinationAssetId === a.id;
                  return (
                    <Pressable
                      key={a.id}
                      onPress={() => {
                        tap();
                        setPaymentMethod(active ? undefined : 'transfer');
                        setDestinationAssetId(active ? undefined : a.id);
                      }}
                      style={[styles.payChip, active && styles.payChipOn]}
                    >
                      <Text style={[styles.payChipText, active && styles.payChipTextOn]}>
                        {describeAccount(a)}
                      </Text>
                    </Pressable>
                  );
                })}
                <Pressable onPress={() => router.push('/asset-add')} style={styles.payChipAdd}>
                  <AppIcon name="plus" size={12} color={colors.primaryStrong} strokeWidth={2.6} />
                  <Text style={styles.payChipAddText}>계좌 등록</Text>
                </Pressable>
              </View>
              {destinationMissing && (
                <Text style={styles.creditHint}>
                  삭제된 계좌로 기록된 수입이에요. 다른 입금처를 고르지 않으면 그대로 유지돼요.
                </Text>
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
                onPressIn={backspaceRepeat.onPressIn}
                onPressOut={backspaceRepeat.onPressOut}
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
              // FINAL BATCH: keypad→save gap trimmed slightly (was 10).
              { opacity: !canSave || submitting || deleting ? 0.4 : pressed ? 0.92 : 1, marginTop: 8 },
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
    paddingBottom: spacing.xs,
  },
  // FINAL BATCH: fixed 30x30 box + centered content so the X icon's visual
  // center lines up with the date pill's center along the header's row axis
  // — icon size/color/hitSlop/onPress all untouched.
  iconBtn: { padding: 4, width: 30, height: 30, justifyContent: 'center', alignItems: 'center' },
  // BATCH: date pill ≈18% shorter (paddingVertical 8→6.5px equiv via 6, plus
  // horizontal trim) — hitSlop added at the call site so the smaller box
  // doesn't shrink the tap target. Icon/text/chevron content untouched.
  datePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
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
    marginTop: 6,
    padding: 4,
    backgroundColor: colors.border,
    borderRadius: radii.md,
  },
  // BATCH: ≈25% shorter tab (paddingVertical 8→6). Active-tab white fill/
  // radius, selection state/logic untouched.
  typeTab: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 9,
  },
  typeTabActive: {
    backgroundColor: colors.white,
  },

  pillRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
  },
  // BATCH: ≈19% shorter pill (paddingVertical 8→5) + slightly tighter
  // horizontal padding. Icon/text/onPress untouched; both pills share this
  // one style so their heights stay identical.
  pastePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 12,
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
    // BATCH: vertical-centering fix — was 'baseline', which combined with
    // the asymmetric padding below made "0원" read as sitting low in the
    // card. True cross-axis centering instead of baseline alignment.
    alignItems: 'center',
    marginTop: spacing.xs,
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.lg,
    // BATCH: history above says padding.xs(4) was tried and rejected as
    // "too flat" — total vertical padding kept the same as before (14),
    // just made symmetric (was 10/4, now 7/7) so the text doesn't sag
    // toward the bottom of the card.
    // iOS: the amount's line box is 12px taller there (see `amount.lineHeight`),
    // so the padding gives those 12px back — the card stays 58px tall on both.
    paddingTop: Platform.OS === 'ios' ? 1 : 7,
    paddingBottom: Platform.OS === 'ios' ? 1 : 7,
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
    // Android's default font padding on this custom (Noto Sans KR) font
    // reserves far more vertical space than the 44px glyph actually needs —
    // same fix as NumKey's digits, see `noPad`'s doc comment. This, not
    // amountRow's own padding, was the real driver of the card's height.
    ...noPad,
    // BATCH: lineHeight trimmed to match fontSize exactly (was 46, a 2px
    // excess) so the glyph box has no residual offset to center within.
    //
    // iOS: `includeFontPadding` / `textAlignVertical` are Android-only, so
    // nothing re-centres the glyph inside a 44px box there. Noto Sans KR's
    // own line box is ≈1.45em (≈64px at 44) and iOS keeps the descent
    // (≈13px) at the bottom of whatever lineHeight it is given — leaving
    // ≈31px above the baseline for digits that are ≈32px tall, so their tops
    // were drawn outside the Text's bounds and clipped. 56 leaves ≈11px
    // above / ≈13px below the digits.
    lineHeight: Platform.OS === 'ios' ? 56 : 44,
    textAlignVertical: 'center',
  },
  unit: {
    fontFamily: fontFamily.semibold,
    fontSize: 20,
    color: colors.textSub,
    marginLeft: 8,
    ...noPad,
    lineHeight: 24,
  },
  unitActive: {
    color: colors.primaryStrong,
  },

  // BATCH: ≈25% shorter row (paddingVertical 12→9). Icon/placeholder/
  // TextInput behaviour untouched.
  memoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingVertical: 9,
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
    // FINAL BATCH: tighter title→list gap (was spacing.sm=8). Shared by both
    // the "카테고리" and "결제수단" titles.
    paddingBottom: spacing.xs,
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
  // FINAL BATCH: 30→28 (2px trim, within the requested cap).
  catPickIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ---- split expense ---- */
  // BATCH: ≈20% shorter row (paddingVertical 10→8). Checkbox/text/hint and
  // the toggle's tap target untouched.
  splitToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    paddingVertical: 8,
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
  // FINAL BATCH: marginTop trimmed (was spacing.sm=8) for a tighter section gap.
  paySection: {
    marginTop: 6,
    paddingBottom: spacing.md,
  },
  payChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 5,
  },
  payMethodRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    paddingHorizontal: spacing.lg,
  },
  // FINAL BATCH: ≈11% shorter pill (paddingVertical 7→5) + slightly tighter
  // horizontal padding (14→12). fontSize/selected-state styling untouched.
  payChip: {
    paddingVertical: 5,
    paddingHorizontal: 12,
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
    paddingVertical: 5,
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
    // FINAL BATCH: spacing.sm(8)→10 — a small breathing gap so the keypad
    // sheet doesn't read as touching the category/payment content right
    // above it. Key height/gap/digit size untouched, so total keypad height
    // barely moves.
    paddingTop: 10,
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
  // BATCH: ≈11% shorter (54→48) so it doesn't read as over-thick next to
  // the now-shorter keypad; still comfortably tappable. disabled/enabled
  // opacity and the save() call at the Pressable are untouched.
  saveBtnFill: {
    height: 48,
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
    // FINAL BATCH: matches numPad's paddingTop bump (8→10) for the same
    // breathing-room reason, so collapsed/expanded states stay consistent.
    paddingTop: 10,
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
    ...StyleSheet.absoluteFill,
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
