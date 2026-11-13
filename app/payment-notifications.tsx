/**
 * "결제 알림 자동입력 (준비 중)" — STEP 1–2 dev / QA screen for the Android
 * notification-listener skeleton.
 *
 * What it does: shows the notification-access state, sends the user to the
 * system setting (after an in-app notice), edits the package allowlist and
 * lists what the listener captured on THIS device — each item with a test
 * preview of the parsed payment candidate (src/lib/paymentNotification/).
 *
 * STEP 3 — "자동입력 후보" (candidateInbox.ts): the readable notifications as
 * candidates with a device-local status. "가계부에 입력" only opens the
 * ordinary /input form with starting values; the user saves there. Opening
 * it marks the candidate "입력 화면으로 보냄" only.
 *
 * STEP 4 — the candidate's fingerprint rides along as `sourceCandidateId`;
 * /input marks it 처리 완료 itself once that transaction's save succeeded
 * (src/lib/paymentNotification/candidateAutoHandle.ts). Leaving /input
 * without saving keeps it pending. The 처리 완료 button stays as the
 * fallback, and the stored state is re-read whenever this screen regains
 * focus.
 *
 * STEP 5 — server dedup: every candidate is registered (best effort, in the
 * background) with register_payment_notification_event so several phones of
 * the household keep ONE server event per real money move
 * (src/lib/paymentNotification/serverDedup.ts). Only a hash and the parsed
 * amount / last 4 / type / time are sent — never the notification text. A
 * failed registration changes nothing on this screen and is retried on the
 * next pass.
 *
 * STEP 6 — "확실한 카드 결제 자동입력" (default OFF, device-local): with it on,
 * a registered card payment the parser read with full confidence that
 * arrived after the setting was turned on is saved as 지출 · 기타
 * (src/lib/paymentNotification/autoSave.ts) and linked to its server event;
 * a manual save from the 후보함 is linked too. All of it runs in the shared
 * pass (src/services/paymentNotificationProcessor.ts) — on app start / back
 * to the foreground, and while this screen is open. Everything else stays
 * in the 후보함.
 *
 * 카드 결제 취소 — "원결제 찾기" lists the expenses that could be the
 * original payment (src/lib/paymentNotification/refundMatch.ts); the user
 * picks one and confirms, and only then it is deleted the ordinary way
 * (soft delete / offline delete queue) and the cancellation marked 처리 완료.
 * Full cancellations only; nothing is matched, deleted or created by itself.
 *
 * What it deliberately does not do yet: save 입금 / 출금 automatically, link
 * a card, pick a category other than 기타, apply a partial cancellation /
 * create a refund income, or merge a transfer pair.
 * This file is wiring only — the native calls live in
 * src/services/paymentNotificationListener.ts.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Pressable, Text, View } from 'react-native';

import { Field, TextField, Toggle } from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { DEFAULT_PAYMENT_NOTIFICATION_PACKAGES } from '@/data/paymentNotificationPackages';
import { fmt, toDateKey } from '@/lib/format';
import { inputPrefillToParams } from '@/lib/inputPrefill';
import {
  PAYMENT_AUTO_SAVE_BLOCKER_LABEL,
  PAYMENT_NOTIFICATION_AUTO_SAVE_ENABLED,
  paymentAutoSaveBlocker,
} from '@/lib/paymentNotification/autoSave';
import {
  buildPaymentInbox,
  clearOrphanedManualSave,
  markCandidateHandled,
  splitPaymentInbox,
  markCandidatePending,
  markCandidateSent,
  type PaymentCandidateState,
  type PaymentCandidateStateEntry,
  type PaymentInboxItem,
} from '@/lib/paymentNotification/candidateInbox';
import {
  diagnosePaymentCandidate,
  type CandidateDiagnostic,
  type QueuedTransactionDiagnostic,
} from '@/lib/paymentNotification/candidateDiagnostics';
import { capturedNotificationLabel, paymentCandidateStatusLabel } from '@/lib/paymentNotification/candidateStatusLabel';
import {
  EXISTING_PAYMENT_MESSAGE,
  findMismatchedManualSaves,
  findOrphanedManualSaves,
} from '@/lib/paymentNotification/existingPayment';
import type { ParsedPaymentCandidate } from '@/lib/paymentNotification/parserTypes';
import {
  REFUND_BLOCKER_MESSAGE,
  findPartialRefundCandidates,
  findRefundMatches,
  refundCardCancellation,
  type RefundMatch,
} from '@/lib/paymentNotification/refundMatch';
import { parsePaymentNotification } from '@/lib/paymentNotification/registry';
import { withPaymentRelations } from '@/lib/paymentNotification/relation';
import {
  CAPTURED_MAX_ENTRIES,
  normalizeAllowedPackages,
  type CapturedNotification,
} from '@/lib/paymentNotificationBuffer';
import {
  loadPaymentAutoSaveSince,
  paymentTransactionLiveness,
  paymentTransactionMatch,
  savePaymentAutoSaveEnabled,
} from '@/services/paymentAutoSave';
import { loadPaymentCandidateState, updatePaymentCandidateState } from '@/services/paymentCandidateState';
import { processPaymentNotifications } from '@/services/paymentNotificationProcessor';
import { paymentRefundIO } from '@/services/paymentRefund';
import {
  clearCapturedNotifications,
  getAllowedPackages,
  getCapturedNotifications,
  isNotificationAccessGranted,
  isPaymentNotificationSupported,
  openNotificationAccessSettings,
  setAllowedPackages,
} from '@/services/paymentNotificationListener';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import type { Transaction } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

const DISCLOSURE =
  '돈돈은 사용자가 허용한 금융 앱의 결제 알림을 읽어 가계부 입력을 돕기 위해 사용합니다.\n\n' +
  '알림 원문은 서버로 전송되지 않고 이 기기에만 임시 저장됩니다. 같은 결제가 여러 기기에서 중복으로 ' +
  '처리되지 않도록 금액·카드/계좌 끝 4자리·거래 종류·시각과, 거래 정보와 이 앱 설치를 구분하는 해시값만 ' +
  '우리집 가계부 서버에 기록돼요. 잔액과 가맹점·상대방 이름은 기록되지 않아요.';

const pad2 = (n: number) => String(n).padStart(2, '0');
const formatPostedAt = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export default function PaymentNotifications() {
  const router = useRouter();
  const toast = useToast();
  const supported = isPaymentNotificationSupported();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const userId = session?.user?.id ?? null;
  const householdId = userId ? (activeHousehold?.id ?? null) : null;

  const [granted, setGranted] = useState(false);
  const [packages, setPackages] = useState<string[]>([]);
  const [captured, setCaptured] = useState<CapturedNotification[]>([]);
  const [packageDraft, setPackageDraft] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [handledOpen, setHandledOpen] = useState(false);
  const [devInfoOpen, setDevInfoOpen] = useState(false);
  // 후보함 status (device-local). Actions wait for the stored state so a tap
  // can never overwrite it with an empty map.
  const [candidateState, setCandidateState] = useState<PaymentCandidateState>({});
  const [candidateStateLoaded, setCandidateStateLoaded] = useState(false);
  const [focusLoads, setFocusLoads] = useState(0);
  const candidateStateRef = useRef<PaymentCandidateState>({});
  // Bumped on every local change, so a focus reload that started before it
  // never replaces it.
  const candidateStateSeqRef = useRef(0);
  // STEP 6: "확실한 카드 결제 자동입력". null = off (default). Nothing runs
  // until the stored value is known.
  const [autoSaveSince, setAutoSaveSince] = useState<number | null>(null);
  const [autoSaveLoaded, setAutoSaveLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadPaymentAutoSaveSince().then((since) => {
      if (!alive) return;
      setAutoSaveSince(since);
      setAutoSaveLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const toggleAutoSave = (on: boolean) => {
    if (!autoSaveLoaded) return;
    void savePaymentAutoSaveEnabled(on, Date.now()).then(setAutoSaveSince);
  };

  // Aligned with `captured`. Display only — nothing is saved or merged.
  const candidates = useMemo(() => withPaymentRelations(captured.map(parsePaymentNotification)), [captured]);

  const inbox = useMemo(
    () => buildPaymentInbox(captured, candidateState, toDateKey(new Date())),
    [captured, candidateState],
  );
  const { pending: pendingItems, autoSaved: autoSavedItems, handled: handledItems } = splitPaymentInbox(inbox.items);
  const [autoSavedOpen, setAutoSavedOpen] = useState(false);

  // On first focus and on coming back from /input (which may have marked a
  // candidate 처리 완료 after saving).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const seq = candidateStateSeqRef.current;
      void loadPaymentCandidateState().then((loaded) => {
        if (!alive || seq !== candidateStateSeqRef.current) return;
        candidateStateRef.current = loaded;
        setCandidateState(loaded);
        setCandidateStateLoaded(true);
        setFocusLoads((n) => n + 1);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  const updateCandidateState = (change: (state: PaymentCandidateState) => PaymentCandidateState) => {
    if (!candidateStateLoaded) return;
    const next = change(candidateStateRef.current);
    const seq = (candidateStateSeqRef.current += 1);
    candidateStateRef.current = next;
    setCandidateState(next);
    // The stored result also carries writes made elsewhere meanwhile.
    void updatePaymentCandidateState(change, next).then((stored) => {
      if (seq !== candidateStateSeqRef.current) return;
      candidateStateRef.current = stored;
      setCandidateState(stored);
    });
  };

  // STEP 5/6: registration, link retries and the automatic save run in the
  // shared pass (src/services/paymentNotificationProcessor.ts) — the same
  // single flight the app start / foreground trigger uses, so this screen
  // and that trigger never save twice. Run when the captured list or the
  // setting changes; a pass that changed the stored state reloads it here.
  // The "N원 자동 입력" toast comes from the app-wide trigger's listener.
  const reloadCandidateState = () => {
    const seq = candidateStateSeqRef.current;
    void loadPaymentCandidateState().then((loaded) => {
      if (seq !== candidateStateSeqRef.current) return;
      candidateStateRef.current = loaded;
      setCandidateState(loaded);
    });
  };
  useEffect(() => {
    if (!candidateStateLoaded || !autoSaveLoaded || !householdId || !userId) return;
    void processPaymentNotifications({ householdId, userId }).then((res) => {
      if (res.changed) reloadCandidateState();
    });
    // reloadCandidateState is a plain closure over refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captured, householdId, userId, candidateStateLoaded, autoSaveLoaded, autoSaveSince]);

  const openInput = (item: PaymentInboxItem) => {
    if (!item.prefill || !candidateStateLoaded) return;
    updateCandidateState((state) => markCandidateSent(state, item.fingerprint, Date.now()));
    router.push({ pathname: '/input', params: inputPrefillToParams(item.prefill, item.fingerprint) });
  };

  // 카드 결제 취소 → 원결제 찾기. Only rows with a known server version and
  // no offline change pending can be deleted (the delete needs the token).
  const finance = useFinanceRead();
  const pending = usePendingWrites();

  // A 처리 완료 from a manual save whose transaction is not in this
  // household's ledger at all — no row, nothing queued — goes back to 확인
  // 대기 (findOrphanedManualSaves → clearOrphanedManualSave). Once per focus,
  // and only with the offline queue loaded: before that a queued create would
  // read as missing.
  const queueReady = pending.hydration === 'ready';
  useEffect(() => {
    if (!candidateStateLoaded || !householdId || !queueReady) return;
    let alive = true;
    const queued = (id: string) => {
      const op = pending.opByEntity.get(id);
      return op ? { op, failed: pending.failedTransactionIds.has(id) } : null;
    };
    void findOrphanedManualSaves(candidateStateRef.current, householdId, {
      queued,
      serverLiveness: (id) => paymentTransactionLiveness(householdId, id),
    }).then((orphans) => {
      if (!alive) return;
      for (const o of orphans) {
        updateCandidateState((state) => clearOrphanedManualSave(state, o.fingerprint, o.transactionId, householdId));
      }
    });
    return () => {
      alive = false;
    };
    // Once per focus load; the queue is read as it is at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLoads, candidateStateLoaded, householdId, queueReady]);

  // A manual save alive in this household but not the candidate's amount /
  // type: only SHOWN (확인 필요) — the amount may have been corrected on
  // purpose. Nothing is cleared here; /input asks before entering it anew.
  // Screen-only, never stored.
  const [mismatched, setMismatched] = useState<Record<string, { transactionId: string; amount: number }>>({});
  const inboxItemCount = inbox.items.length;
  useEffect(() => {
    if (!candidateStateLoaded || !householdId || !queueReady) return;
    let alive = true;
    const prefillOf = new Map(inbox.items.map((i) => [i.fingerprint, i.prefill] as const));
    void findMismatchedManualSaves(candidateStateRef.current, householdId, {
      queued: (id) => {
        const op = pending.opByEntity.get(id);
        return op ? { op, failed: pending.failedTransactionIds.has(id) } : null;
      },
      expected: (fingerprint) => {
        const p = prefillOf.get(fingerprint);
        return p ? { amount: p.amount, type: p.type } : null;
      },
      serverMatch: (id, expected) => paymentTransactionMatch(householdId, id, expected),
    }).then((found) => {
      if (!alive) return;
      setMismatched(Object.fromEntries(found.map((m) => [m.fingerprint, { transactionId: m.transactionId, amount: m.amount }])));
    });
    return () => {
      alive = false;
    };
    // Once per focus load (and once the notifications are read).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLoads, candidateStateLoaded, householdId, queueReady, inboxItemCount]);
  const mismatchAmountOf = (fingerprint: string): number | undefined => {
    const m = mismatched[fingerprint];
    return m && candidateState[fingerprint]?.manualTxnId === m.transactionId ? m.amount : undefined;
  };
  const deletableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of finance.transactions) {
      if (finance.transactionMeta[t.id] && !finance.pendingTransactionOps.has(t.id) && !finance.failedTransactionIds.has(t.id)) {
        ids.add(t.id);
      }
    }
    return ids;
  }, [finance.transactions, finance.transactionMeta, finance.pendingTransactionOps, finance.failedTransactionIds]);
  const [refundOpenFor, setRefundOpenFor] = useState<string | null>(null);
  const [refunding, setRefunding] = useState(false);
  const refundingRef = useRef(false);
  const refundLookup = (item: PaymentInboxItem) => {
    const input = {
      cancel: item,
      items: inbox.items,
      state: candidateState,
      householdId: householdId ?? '',
      transactions: finance.transactions,
      deletableIds,
    };
    return { matches: findRefundMatches(input), partials: findPartialRefundCandidates(input) };
  };

  const runRefund = async (item: PaymentInboxItem, txn: Transaction) => {
    if (refundingRef.current || !householdId || !userId) return;
    refundingRef.current = true;
    setRefunding(true);
    try {
      const out = await refundCardCancellation(
        item,
        txn,
        deletableIds,
        paymentRefundIO({
          householdId,
          userId,
          expectedUpdatedAt: (id) => finance.transactionMeta[id]?.updatedAt ?? null,
          enqueueTransactionDelete: pending.enqueueTransactionDelete,
        }),
      );
      if (out.kind === 'refunded') {
        candidateStateSeqRef.current += 1;
        reloadCandidateState();
        setRefundOpenFor(null);
        if (!out.queued) await finance.refresh();
        toast.show(out.queued ? '환불 처리했어요 · 인터넷에 연결되면 자동으로 반영할게요' : '환불 처리했어요');
        return;
      }
      if (out.kind === 'blocked') {
        toast.show(REFUND_BLOCKER_MESSAGE[out.blocker]);
        return;
      }
      if (out.kind === 'queue-failed') {
        toast.show(
          out.reason === 'existing-pending'
            ? '이미 전송 대기 중인 변경이 있어요.'
            : out.reason === 'not-hydrated'
              ? '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.'
              : out.reason === 'cap'
                ? '오프라인에 저장할 수 있는 거래 수를 초과했어요. 인터넷 연결 후 다시 시도해주세요.'
                : '처리하지 못했어요. 잠시 후 다시 시도해주세요.',
        );
        return;
      }
      // conflict / deleted / gone — the list is stale: reload it.
      if (out.reason !== 'identity' && out.reason !== 'error') await finance.refresh();
      toast.show(out.message ?? '처리하지 못했어요. 잠시 후 다시 시도해주세요.');
    } finally {
      refundingRef.current = false;
      setRefunding(false);
    }
  };

  const confirmRefund = (item: PaymentInboxItem, match: RefundMatch) => {
    if (refundingRef.current) return;
    const t = match.transaction;
    const d = new Date(t.date);
    const name = t.memo.trim() || item.candidate.merchantCandidate || '지출';
    Alert.alert(
      `${name} ${fmt(t.amount)}원`,
      `${d.getMonth() + 1}월 ${d.getDate()}일 거래를 카드 결제 취소로 처리할까요?\n\n처리하면 원래 지출 거래가 삭제되어 지출 합계와 연결된 잔액/카드 금액에서 빠집니다.`,
      [
        { text: '취소', style: 'cancel' },
        { text: '환불 처리', style: 'destructive', onPress: () => void runRefund(item, t) },
      ],
    );
  };

  const refundPropsFor = (item: PaymentInboxItem) => {
    if (item.kind !== 'card_cancellation' || item.refundTxnId) return undefined;
    const open = refundOpenFor === item.fingerprint;
    return {
      open,
      ready: finance.status === 'ready' && !!householdId,
      busy: refunding,
      lookup: open ? refundLookup(item) : null,
      onToggle: () => setRefundOpenFor((cur) => (cur === item.fingerprint ? null : item.fingerprint)),
      onChoose: (m: RefundMatch) => confirmRefund(item, m),
      onEdit: (t: Transaction) => router.push({ pathname: '/input', params: { id: t.id } }),
    };
  };

  const reload = useCallback(async () => {
    if (!supported) return;
    const [access, list] = await Promise.all([isNotificationAccessGranted(), getCapturedNotifications()]);
    setGranted(access);
    setCaptured(list);
  }, [supported]);

  // The allowlist lives on the native side (the service reads it while the
  // app is closed). Built-in defaults are merged in once per visit.
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void (async () => {
      const stored = await getAllowedPackages();
      const merged = normalizeAllowedPackages([...DEFAULT_PAYMENT_NOTIFICATION_PACKAGES, ...stored]);
      const next = merged.length === stored.length ? stored : await setAllowedPackages(merged);
      if (alive) setPackages(next);
    })();
    return () => {
      alive = false;
    };
  }, [supported]);

  // Coming back from the system settings screen re-reads the access state.
  useEffect(() => {
    void reload();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void reload();
    });
    return () => sub.remove();
  }, [reload]);

  const requestAccess = () => {
    Alert.alert('알림 접근 안내', DISCLOSURE, [
      { text: '취소', style: 'cancel' },
      {
        text: '확인',
        onPress: () => {
          void openNotificationAccessSettings().then((opened) => {
            if (!opened) toast.show('알림 접근 설정을 열지 못했어요');
          });
        },
      },
    ]);
  };

  const addPackage = async () => {
    const name = packageDraft.trim();
    if (!name) return;
    setPackages(await setAllowedPackages([...packages, name]));
    setPackageDraft('');
  };

  const removePackage = async (name: string) => {
    setPackages(await setAllowedPackages(packages.filter((p) => p !== name)));
  };

  const clearCaptured = () => {
    Alert.alert('캡처된 알림을 모두 지울까요?', '이 기기에 임시 저장된 알림만 지워져요.', [
      { text: '취소', style: 'cancel' },
      {
        text: '지우기',
        style: 'destructive',
        onPress: () => {
          void clearCapturedNotifications().then(() => reload());
        },
      },
    ]);
  };

  return (
    <ModalScreen title="결제 알림 자동입력 (준비 중)" onClose={() => router.back()}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl, gap: spacing.md }}>
        <Panel>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text, ...noPad }}>
            아직 준비 중인 기능이에요
          </Text>
          <Text style={bodyStyle}>
            카드·은행 앱의 결제 알림을 읽어 가계부 입력을 돕는 기능을 만들고 있어요. 받은 알림은 아래
            「자동입력 후보」에 모여요. 「가계부에 입력」을 누르면 입력 화면이 열리고, 내용을 확인한 뒤 직접
            저장해야 가계부에 들어가요.
            {PAYMENT_NOTIFICATION_AUTO_SAVE_ENABLED &&
              ' 「확실한 카드 결제 자동입력」을 켠 경우에만 신뢰도 높은 카드 결제가 자동으로 저장돼요.'}
          </Text>
          <Text style={bodyStyle}>{DISCLOSURE}</Text>
        </Panel>

        {!supported ? (
          <Panel>
            <Text style={bodyStyle}>
              이 기기에서는 사용할 수 없어요. Android 전용 기능이고, 이 기능이 포함된 앱 버전이 필요해요.
            </Text>
          </Panel>
        ) : (
          <>
            <Panel>
              <StatusRow label="알림 접근 권한" value={granted ? '허용됨' : '꺼져 있음'} ok={granted} />
              <ActionButton label={granted ? '알림 접근 설정 열기' : '알림 접근 허용하기'} onPress={requestAccess} />
            </Panel>

            <Panel>
              <StatusRow label="알림을 읽을 앱" value={`${packages.length}개`} ok={packages.length > 0} />
              <Text style={bodyStyle}>
                여기에 추가한 앱(패키지명)의 알림만 저장돼요. 목록이 비어 있으면 아무 알림도 저장하지 않아요.
              </Text>
              {packages.map((name) => (
                <View key={name} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ flex: 1, fontFamily: fontFamily.medium, fontSize: 13, color: colors.text }}>
                    {name}
                  </Text>
                  <Pressable onPress={() => void removePackage(name)} hitSlop={8}>
                    <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.expenseText }}>삭제</Text>
                  </Pressable>
                </View>
              ))}
              <Field label="패키지명 추가 (테스트용)">
                <TextField
                  value={packageDraft}
                  onChangeText={setPackageDraft}
                  placeholder="예: com.example.app"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={() => void addPackage()}
                />
              </Field>
              <ActionButton label="추가" onPress={() => void addPackage()} disabled={!packageDraft.trim()} />
            </Panel>

            {/* The setting only while the automatic save is switched on for
                this build (autoSave.ts); past automatic saves stay listed. */}
            {(PAYMENT_NOTIFICATION_AUTO_SAVE_ENABLED || autoSavedItems.length > 0) && (
              <Panel>
                {PAYMENT_NOTIFICATION_AUTO_SAVE_ENABLED && (
                  <>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <Text style={{ flex: 1, fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, ...noPad }}>
                        확실한 카드 결제 자동입력
                      </Text>
                      <Toggle value={autoSaveSince != null} onChange={toggleAutoSave} disabled={!autoSaveLoaded} />
                    </View>
                    <Text style={bodyStyle}>
                      켠 뒤에 받은 신뢰도 높은 카드 결제만 지출로 자동 기록해요. 입금·출금·취소와 애매한 알림은 직접
                      확인해 주세요.
                    </Text>
                    <Text style={{ ...bodyStyle, fontSize: 12, color: colors.textMuted }}>
                      카테고리는 「기타」로 저장되고 결제수단(카드)은 연결하지 않아요. 거래내역에서 언제든 수정할 수
                      있어요. 돈돈 앱을 열거나 다시 돌아올 때 처리돼요.
                    </Text>
                  </>
                )}
                {autoSavedItems.length > 0 && (
                  <ActionButton
                    label={autoSavedOpen ? '자동저장 내역 접기' : `자동저장 내역 ${autoSavedItems.length}건 보기`}
                    onPress={() => setAutoSavedOpen((open) => !open)}
                  />
                )}
                {autoSavedOpen &&
                  autoSavedItems.map((item) => (
                    <InboxCard
                      key={item.fingerprint}
                      item={item}
                      entry={candidateState[item.fingerprint]}
                      disabled={!candidateStateLoaded}
                    />
                  ))}
              </Panel>
            )}

            <Panel>
              <StatusRow label="자동입력 후보" value={`확인 대기 ${pendingItems.length}건`} ok={pendingItems.length > 0} />
              {pendingItems.length === 0 && <Text style={bodyStyle}>확인할 결제 알림이 없어요.</Text>}
              {pendingItems.map((item) => (
                <InboxCard
                  key={item.fingerprint}
                  item={item}
                  entry={candidateState[item.fingerprint]}
                  mismatchAmount={mismatchAmountOf(item.fingerprint)}
                  disabled={!candidateStateLoaded}
                  autoSaveOn={PAYMENT_NOTIFICATION_AUTO_SAVE_ENABLED && autoSaveSince != null}
                  onInput={() => openInput(item)}
                  onHandled={() =>
                    updateCandidateState((state) => markCandidateHandled(state, item.fingerprint, Date.now()))
                  }
                  refund={refundPropsFor(item)}
                />
              ))}
              {inbox.unreadableCount > 0 && (
                <Text style={{ ...bodyStyle, fontSize: 12, color: colors.warningText }}>
                  확인 필요 · 아직 지원하지 않는 알림 형식 {inbox.unreadableCount}건 — 아래 테스트 알림 목록에서 원문을
                  볼 수 있어요. 지원되면 후보로 나타나요.
                </Text>
              )}
              {inbox.ignoredCount > 0 && (
                <Text style={{ ...bodyStyle, fontSize: 12, color: colors.textMuted }}>
                  광고/혜택 알림 {inbox.ignoredCount}건은 후보에서 제외했어요.
                </Text>
              )}
              {handledItems.length > 0 && (
                <ActionButton
                  label={handledOpen ? '처리한 후보 접기' : `처리한 후보 ${handledItems.length}건 보기`}
                  onPress={() => setHandledOpen((open) => !open)}
                />
              )}
              {handledOpen &&
                handledItems.map((item) => (
                  <InboxCard
                    key={item.fingerprint}
                    item={item}
                    entry={candidateState[item.fingerprint]}
                    mismatchAmount={mismatchAmountOf(item.fingerprint)}
                    disabled={!candidateStateLoaded}
                    onPending={() => updateCandidateState((state) => markCandidatePending(state, item.fingerprint))}
                  />
                ))}
            </Panel>

            <Panel>
              <StatusRow
                label="캡처된 금융 알림"
                value={`${captured.length}건 / 최대 ${CAPTURED_MAX_ENTRIES}건`}
                ok={captured.length > 0}
              />
              <Text style={bodyStyle}>이 기기에만 최대 7일 동안 임시 저장돼요.</Text>
              <ActionButton
                label={listOpen ? '테스트 알림 목록 접기' : '테스트 알림 목록 보기'}
                onPress={() => {
                  setListOpen((open) => !open);
                  void reload();
                }}
              />
              {/* Internal ids / queue / server state: development builds only, folded by default. */}
              {__DEV__ && listOpen && !!householdId && (
                <ActionButton
                  label={devInfoOpen ? '개발자 정보 접기' : '개발자 정보 보기'}
                  onPress={() => setDevInfoOpen((open) => !open)}
                />
              )}
              {__DEV__ && listOpen && devInfoOpen && !!householdId && (
                <CandidateDiagnosticsList items={inbox.items} state={candidateState} householdId={householdId} />
              )}
              {listOpen && captured.length === 0 && <Text style={bodyStyle}>아직 캡처된 알림이 없어요.</Text>}
              {listOpen &&
                captured.map((item, index) => (
                  <View
                    key={`${item.notificationKey}|${item.postedAt}|${item.text}`}
                    style={{
                      padding: 12,
                      borderRadius: radii.md,
                      backgroundColor: colors.bg,
                      borderWidth: 1,
                      borderColor: colors.border,
                      gap: 4,
                    }}
                  >
                    <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: colors.textMuted }}>
                      {formatPostedAt(item.postedAt)} · {item.packageName}
                    </Text>
                    {!!item.title && (
                      <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>{item.title}</Text>
                    )}
                    {!!item.text && <Text style={bodyStyle}>{item.text}</Text>}
                    <CandidatePreview candidate={candidates[index] ?? null} />
                  </View>
                ))}
              {captured.length > 0 && <ActionButton label="캡처된 알림 모두 지우기" onPress={clearCaptured} danger />}
            </Panel>
          </>
        )}
      </View>
    </ModalScreen>
  );
}

const bodyStyle = {
  fontFamily: fontFamily.regular,
  fontSize: 13,
  lineHeight: 20,
  color: colors.textSub,
} as const;

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        padding: spacing.lg,
        borderRadius: radii.xxl,
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 10,
      }}
    >
      {children}
    </View>
  );
}

/**
 * QA diagnostics (read-only, __DEV__ builds only): each 후보's stored state and, for a recorded
 * manual save, the liveness /input's existing-payment check would get and
 * whether this device's offline queue or the server decided it
 * (candidateDiagnostics.ts). Nothing here writes.
 */
function CandidateDiagnosticsList({
  items,
  state,
  householdId,
}: {
  items: readonly PaymentInboxItem[];
  state: PaymentCandidateState;
  householdId: string;
}) {
  const pending = usePendingWrites();
  const [rows, setRows] = useState<CandidateDiagnostic[] | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let alive = true;
    // The queue read /input's check uses (existingPaymentIO): op kind per id
    // + the terminal-failed set; the record itself only adds its details.
    const queued = (id: string): QueuedTransactionDiagnostic | null => {
      const op = pending.opByEntity.get(id);
      if (!op) return null;
      const rec = pending.pendingTransactionOps.find((o) => o.entityId === id);
      return {
        op,
        failed: pending.failedTransactionIds.has(id),
        attemptCount: rec?.attemptCount ?? null,
        enqueuedAt: rec?.enqueuedAt ?? null,
        lastAttemptAt: rec?.lastAttemptAt ?? null,
        lastError: rec?.lastError ?? null,
        lastErrorReason: rec?.lastErrorReason ?? null,
      };
    };
    const io = { queued, serverLiveness: (id: string) => paymentTransactionLiveness(householdId, id) };
    void Promise.all(items.map((i) => diagnosePaymentCandidate(i.fingerprint, state[i.fingerprint], householdId, io))).then(
      (out) => {
        if (alive) setRows(out);
      },
    );
    return () => {
      alive = false;
    };
  }, [items, state, householdId, pending.opByEntity, pending.pendingTransactionOps, pending.failedTransactionIds, reads]);

  const at = (ms: number | null) => (ms == null ? '-' : `${formatPostedAt(ms)} (${ms})`);
  const mono = { fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 16, color: colors.textSub } as const;
  return (
    <View style={{ padding: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, gap: 6 }}>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>후보 상태 진단 (읽기 전용 · QA)</Text>
      <Text style={mono}>
        household {householdId} · queue {pending.hydration} · 대기 op {pending.pendingTransactionOps.length}건 · 실패{' '}
        {pending.failedTransactionIds.size}건
      </Text>
      <ActionButton label="진단 다시 읽기" onPress={() => setReads((n) => n + 1)} />
      {rows == null && <Text style={mono}>읽는 중…</Text>}
      {rows?.length === 0 && <Text style={mono}>후보 없음</Text>}
      {rows?.map((d) => {
        const item = items.find((i) => i.fingerprint === d.fingerprint);
        const q = d.manual?.queued ?? null;
        return (
          <View key={d.fingerprint} style={{ paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.border, gap: 2 }}>
            <Text style={{ ...mono, fontFamily: fontFamily.bold, color: colors.text }}>
              {item ? `${KIND_LABEL[item.kind]} ${fmt(item.candidate.amount ?? 0)}원 · ${item.candidate.merchantCandidate ?? item.candidate.counterparty ?? '-'} · ${item.status}` : '-'}
            </Text>
            <Text style={mono} selectable>
              {[
                `fingerprint ${d.fingerprint}`,
                `registeredEventId ${d.registeredEventId ?? '-'}`,
                `registeredHouseholdId ${d.registeredHouseholdId ?? '-'}`,
                `manualTxnId ${d.manualTxnId ?? '-'}`,
                `manualHouseholdId ${d.manualHouseholdId ?? '-'}`,
                `manualSavedAt ${at(d.manualSavedAt)}`,
                `manualLinkedAt ${at(d.manualLinkedAt)}`,
                `manualLinkFailedAt ${at(d.manualLinkFailedAt)}`,
                `handledAt ${at(d.handledAt)}`,
                `sentAt ${at(d.sentAt)}`,
                `autoSaveTxnId ${d.autoSaveTxnId ?? '-'}`,
                ...(d.manual
                  ? [
                      `→ liveness ${d.manual.liveness} · source ${d.manual.source}${d.manual.sameHousehold ? '' : ' · 다른 household (입력 화면은 사용 안 함)'}`,
                      q
                        ? `→ queue op ${q.op} · ${q.failed ? 'failed (전송 실패, 보관됨)' : 'pending (전송 대기)'} · attempts ${q.attemptCount ?? '-'} · enqueued ${q.enqueuedAt ?? '-'} · lastAttempt ${q.lastAttemptAt ?? '-'} · reason ${q.lastErrorReason ?? '-'} · lastError ${q.lastError ?? '-'}`
                        : '→ queue op 없음',
                    ]
                  : []),
              ].join('\n')}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const DIRECTION_LABEL: Record<ParsedPaymentCandidate['direction'], string> = {
  outflow: '출금',
  inflow: '입금',
  unknown: '방향 확인 필요',
};
const CONFIDENCE_LABEL: Record<ParsedPaymentCandidate['confidence'], string> = {
  high: '신뢰도 높음',
  medium: '신뢰도 보통 · 일부 확인 필요',
  low: '신뢰도 낮음 · 확인 필요',
};

const KIND_LABEL: Record<PaymentInboxItem['kind'], string> = {
  card_payment: '카드 결제',
  card_cancellation: '카드 결제 취소',
  inflow: '입금',
  outflow: '출금',
};

/** 원결제 찾기 for one cancellation (refundMatch.ts). */
interface RefundCardProps {
  open: boolean;
  /** The ledger is loaded for the active household. */
  ready: boolean;
  busy: boolean;
  lookup: { matches: RefundMatch[]; partials: Transaction[] } | null;
  onToggle: () => void;
  onChoose: (match: RefundMatch) => void;
  onEdit: (transaction: Transaction) => void;
}

/**
 * One 후보함 entry. "가계부에 입력" only opens /input with starting values —
 * never saves. A cancellation has no input action; "원결제 찾기" lists the
 * possible original payments — choosing one asks for confirmation first.
 */
function InboxCard({
  item,
  entry,
  mismatchAmount,
  disabled,
  autoSaveOn,
  onInput,
  onHandled,
  onPending,
  refund,
}: {
  item: PaymentInboxItem;
  /** Its stored state — read for the status label only. */
  entry: PaymentCandidateStateEntry | undefined;
  /** Its manual save is alive but this amount (findMismatchedManualSaves). */
  mismatchAmount?: number;
  disabled: boolean;
  /** STEP 6: the setting is on — say why a card payment is not saved by itself. */
  autoSaveOn?: boolean;
  onInput?: () => void;
  onHandled?: () => void;
  onPending?: () => void;
  /** Pending, unprocessed cancellations only. */
  refund?: RefundCardProps;
}) {
  const c = item.candidate;
  const line = { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub } as const;
  const muted = { fontFamily: fontFamily.medium, fontSize: 11, color: colors.textMuted } as const;
  const notice = { fontFamily: fontFamily.bold, fontSize: 12, color: colors.warningText } as const;
  const isCard = item.kind === 'card_payment' || item.kind === 'card_cancellation';
  const last4 = c.accountLast4 ? `****${c.accountLast4}` : '확인 필요';
  const blocker =
    autoSaveOn && item.kind === 'card_payment' && item.status === 'pending' ? paymentAutoSaveBlocker(item, Date.now()) : null;
  return (
    <View
      style={{
        padding: 12,
        borderRadius: radii.md,
        backgroundColor: colors.bg,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 4,
      }}
    >
      <Text style={muted}>
        {formatPostedAt(c.occurredAt)} · {CONFIDENCE_LABEL[c.confidence]} · {paymentCandidateStatusLabel(item, entry)}
      </Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text }}>
        {KIND_LABEL[item.kind]} · {fmt(c.amount ?? 0)}원
      </Text>
      {mismatchAmount != null && (
        <Text style={notice}>
          확인 필요 · {EXISTING_PAYMENT_MESSAGE.mismatchNotice} (연결된 거래 {fmt(mismatchAmount)}원)
        </Text>
      )}
      {isCard ? (
        <>
          <Text style={line}>가맹점: {c.merchantCandidate ?? '확인 필요'}</Text>
          <Text style={line}>
            카드: {c.accountName ?? '확인 필요'} {last4}
          </Text>
        </>
      ) : (
        <>
          <Text style={line}>상대: {c.counterparty ?? '확인 필요'}</Text>
          {!!c.merchantCandidate && <Text style={line}>메모: {c.merchantCandidate}</Text>}
          <Text style={line}>
            계좌: {c.accountName ?? '확인 필요'} {last4}
          </Text>
        </>
      )}
      {item.autoSaved && (
        <Text style={{ ...muted, color: colors.primaryStrong }}>
          자동저장됨{item.autoSavedAt != null ? ` · ${formatPostedAt(item.autoSavedAt)}` : ''} · 「기타」로 저장했어요.
          거래내역에서 수정할 수 있어요.
        </Text>
      )}
      {item.linkConflict && (
        <Text style={notice}>다른 기기에서 입력된 같은 결제가 있을 수 있어요 · 가계부에서 중복인지 확인해 주세요</Text>
      )}
      {item.autoSaveFailed && item.status === 'pending' && (
        <Text style={notice}>자동저장 실패 · 직접 확인이 필요해요</Text>
      )}
      {!!blocker && !item.autoSaveFailed && (
        <Text style={muted}>자동입력 대상 아님 · {PAYMENT_AUTO_SAVE_BLOCKER_LABEL[blocker]}</Text>
      )}
      {item.kind === 'card_cancellation' &&
        (item.refundTxnId ? (
          <Text style={{ ...muted, color: colors.primaryStrong }}>환불 처리됨 · 원래 지출 거래를 삭제했어요</Text>
        ) : (
          <Text style={muted}>원결제를 찾아 직접 고르면 전액 취소로 처리할 수 있어요. 자동으로 처리되지는 않아요.</Text>
        ))}
      {item.transferWarning && (
        <Text style={notice}>
          계좌이체 가능성 ·{' '}
          {c.relationKey ? '같은 금액의 반대 방향 알림이 10초 안에 있어요' : '상대가 계좌 형식이에요'}. 내 계좌 간
          이동이라면 수입/지출로 입력하지 마세요.
        </Text>
      )}
      {item.kind === 'outflow' && !item.transferWarning && (
        <Text style={muted}>출금은 이체·카드대금일 수도 있어요. 지출이 맞는지 확인해 주세요.</Text>
      )}
      {item.sentToInput && item.status === 'pending' && (
        <Text style={muted}>입력 화면에서 저장하면 자동으로 처리 완료돼요. 그대로 남아 있다면 「처리 완료」를 눌러 주세요.</Text>
      )}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
        {!!onInput && !!item.prefill && (
          <View style={{ flex: 1 }}>
            <ActionButton
              label={item.kind === 'outflow' ? '지출로 입력' : item.kind === 'inflow' ? '수입으로 입력' : '가계부에 입력'}
              onPress={onInput}
              disabled={disabled}
            />
          </View>
        )}
        {!!refund && (
          <View style={{ flex: 1 }}>
            <ActionButton
              label={refund.open ? '원결제 찾기 닫기' : '원결제 찾기'}
              onPress={refund.onToggle}
              disabled={disabled || !refund.ready}
            />
          </View>
        )}
        {!!onHandled && (
          <View style={{ flex: 1 }}>
            <ActionButton label="처리 완료" onPress={onHandled} disabled={disabled} />
          </View>
        )}
        {!!onPending && (
          <View style={{ flex: 1 }}>
            <ActionButton label="확인 대기로 되돌리기" onPress={onPending} disabled={disabled} />
          </View>
        )}
      </View>
      {!!refund?.open && !!refund.lookup && (
        <RefundMatchList lookup={refund.lookup} busy={refund.busy || disabled} onChoose={refund.onChoose} onEdit={refund.onEdit} />
      )}
    </View>
  );
}

/**
 * The possible original payments, strongest first. Every one is listed —
 * nothing is chosen for the user; a tap only asks for confirmation.
 */
function RefundMatchList({
  lookup,
  busy,
  onChoose,
  onEdit,
}: {
  lookup: { matches: RefundMatch[]; partials: Transaction[] };
  busy: boolean;
  onChoose: (match: RefundMatch) => void;
  onEdit: (transaction: Transaction) => void;
}) {
  const muted = { fontFamily: fontFamily.medium, fontSize: 11, color: colors.textMuted } as const;
  const row = {
    padding: 10,
    borderRadius: radii.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  } as const;
  const title = (t: Transaction) => {
    const d = new Date(t.date);
    return `${d.getMonth() + 1}/${d.getDate()} · ${t.memo.trim() || '메모 없음'} · ${fmt(t.amount)}원`;
  };
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      {lookup.matches.length === 0 ? (
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.textSub }}>
          원결제를 찾지 못했어요. 직접 정리하려면 「처리 완료」를 눌러 주세요.
        </Text>
      ) : (
        <Text style={muted}>
          원결제 후보 {lookup.matches.length}건 · 맞는 거래를 직접 골라 주세요. 고른 뒤 한 번 더 확인해요.
        </Text>
      )}
      {lookup.matches.map((m) => (
        <Pressable
          key={m.transaction.id}
          onPress={() => onChoose(m)}
          disabled={busy}
          style={({ pressed }) => ({ ...row, opacity: busy ? 0.5 : pressed ? 0.7 : 1 })}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>{title(m.transaction)}</Text>
          <Text style={{ ...muted, color: m.basis === 'inbox' ? colors.primaryStrong : colors.textMuted }}>
            {m.reasons.join(' · ')}
          </Text>
        </Pressable>
      ))}
      {lookup.partials.length > 0 && (
        <>
          <Text style={{ ...muted, color: colors.warningText }}>{REFUND_BLOCKER_MESSAGE.partial}</Text>
          {lookup.partials.map((t) => (
            <View key={t.id} style={row}>
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.textSub }}>{title(t)}</Text>
              <ActionButton label="거래 수정" onPress={() => onEdit(t)} disabled={busy} />
            </View>
          ))}
        </>
      )}
    </View>
  );
}

/** STEP 2 test preview of the parser's reading. No save action on purpose. */
function CandidatePreview({ candidate }: { candidate: ParsedPaymentCandidate | null }) {
  const boxStyle = {
    marginTop: 4,
    padding: 8,
    borderRadius: radii.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  } as const;
  const line = { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub } as const;
  const muted = { fontFamily: fontFamily.medium, fontSize: 11, color: colors.textMuted } as const;
  const notCandidate = capturedNotificationLabel(candidate);
  if (notCandidate || !candidate || candidate.amount == null) {
    return (
      <View style={boxStyle}>
        <Text style={muted}>해석 결과</Text>
        <Text
          style={{
            fontFamily: fontFamily.bold,
            fontSize: 12,
            color: candidate?.ignoredReason ? colors.textMuted : colors.warningText,
          }}
        >
          {notCandidate}
        </Text>
        {!!candidate && !candidate.ignoredReason && candidate.reasons.length > 0 && (
          <Text style={muted}>{candidate.reasons.join(' · ')}</Text>
        )}
      </View>
    );
  }
  const isCard = candidate.instrument === 'card';
  return (
    <View style={boxStyle}>
      <Text style={muted}>해석 결과 (테스트 · 저장되지 않음)</Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>
        {isCard ? (candidate.kind === 'cancellation' ? '카드 결제 취소' : '카드 결제') : DIRECTION_LABEL[candidate.direction]} · {fmt(candidate.amount)}원
      </Text>
      <Text style={line}>
        {isCard ? '카드' : '계좌'}:{' '}
        {candidate.accountName
          ? `${candidate.accountName}${candidate.accountLast4 ? ` ****${candidate.accountLast4}` : ''}`
          : '확인 필요'}
      </Text>
      {isCard ? (
        <Text style={line}>가맹점 후보: {candidate.merchantCandidate ?? '확인 필요'}</Text>
      ) : (
        <>
          <Text style={line}>상대: {candidate.counterparty ?? '확인 필요'}</Text>
          {!!candidate.merchantCandidate && <Text style={line}>메모/가맹점 후보: {candidate.merchantCandidate}</Text>}
        </>
      )}
      {!!candidate.relationKey && (
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.primaryStrong }}>
          관련 알림 가능성 있음 · 같은 금액의 반대 방향 알림이 10초 안에 있어요
        </Text>
      )}
      <Text style={{ ...muted, color: candidate.confidence === 'high' ? colors.textMuted : colors.warningText }}>
        {CONFIDENCE_LABEL[candidate.confidence]}
      </Text>
    </View>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ flex: 1, fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, ...noPad }}>{label}</Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: ok ? colors.primaryStrong : colors.textMuted }}>
        {value}
      </Text>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  disabled,
  danger,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: radii.xl,
        borderWidth: 1,
        borderColor: danger ? colors.expense : colors.border,
        backgroundColor: danger ? colors.expenseLight : colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: danger ? colors.expenseText : colors.text }}>
        {label}
      </Text>
    </Pressable>
  );
}
