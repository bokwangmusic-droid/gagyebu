import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { Card } from '@/components/ui/Card';
import { SegmentedTabs, Toggle } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { getCat, type TxnType } from '@/data/categories';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt } from '@/lib/format';
import { attemptedActiveLabel, pendingRecurringRowLabel } from '@/lib/pendingRecurringLabel';
import { describeSchedule } from '@/lib/recurring';
import type { EnqueueOutcome } from '@/services/offlineQueue/coordinator';
import { setRecurringActive, softDeleteRecurring } from '@/services/remoteRecurringWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead, type FinanceReadResult } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import type { RecurringRule } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

export default function RecurringList() {
  const router = useRouter();
  const toast = useToast();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const {
    status,
    error,
    recurring,
    recurringMeta,
    // STEP 16-H2-F2 §5: the LIST renders `recurringManagementRows`
    // (authoritative server `recurring` + pending CREATE synthetic + a
    // NOT-failed pending FULL UPDATE / ACTIVE toggle overlay − a not-failed
    // pending DELETE + a failed-orphan FULL-UPDATE synthetic). The money
    // total / active-paused counts below stay on AUTHORITATIVE `recurring`
    // (Budget/Planned precedent).
    recurringManagementRows,
    pendingRecurringOps,
    customCats,
    refresh,
  } = useFinanceRead();
  const pending = usePendingWrites();
  const financeRefresh = useRemoteFinanceRefreshControl();
  const [tab, setTab] = useState<TxnType>('expense');

  // One row-level write at a time (toggle OR delete). Dims + disables that row.
  const pendingRef = useRef(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const canCreate = REMOTE_FINANCE_WRITE.recurringCreate;
  const canEdit = REMOTE_FINANCE_WRITE.recurringEdit;
  const canToggle = REMOTE_FINANCE_WRITE.recurringToggle;
  const canDelete = REMOTE_FINANCE_WRITE.recurringDelete;

  const filtered = useMemo(
    () => recurringManagementRows.filter((r) => r.type === tab),
    [recurringManagementRows, tab],
  );
  // AGGREGATE ISOLATION (device QA regression, STEP 16-H2-F2 fix) — these
  // three MUST read `recurring` (authoritative `financeRead().recurring`,
  // untouched by any pending/failed queue op), NEVER `recurringManagementRows`.
  // A pending DELETE optimistically hides its row from the LIST
  // (`filtered`, above) but must NOT move this total/count until the server
  // actually acks it — see src/lib/offlineQueue.recurring.cases.ts cases
  // A–D for the exact regression this guards.
  const monthlyTotal = recurring.filter((r) => r.type === tab && r.active).reduce((s, r) => s + r.amount, 0);
  const activeCount = recurring.filter((r) => r.active).length;
  const pausedCount = recurring.length - activeCount;

  const openAdd = () => router.push({ pathname: '/recurring-add', params: { type: tab } });
  const openEdit = (id: string) => {
    // §17: never open the edit form on a row with an in-flight/failed op —
    // the route guard in recurring-add.tsx also blocks this, but the list
    // never offers the tap in the first place (see the row below).
    if (pendingRecurringOps.has(id)) return;
    router.push({ pathname: '/recurring-add', params: { id } });
  };

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

  const discardFailed = (queueId: string) => {
    Alert.alert('실패한 변경을 버릴까요?', '다른 기기에 저장된 최신 반복 항목은 그대로 유지됩니다.', [
      { text: '취소', style: 'cancel' },
      {
        text: '버리기',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const r = await pending.discardPending(queueId);
            toast.show(r.ok ? '실패한 변경을 버렸어요' : '변경을 버리지 못했어요. 잠시 후 다시 시도해주세요.');
          })();
        },
      },
    ]);
  };

  // STEP 16-H2-F2 §13 — CRITICAL: an orphan failed ACTIVE toggle (server row
  // deleted by another device while this one was offline) gets NO row in
  // `recurringManagementRows` (an `{ active }`-only payload has no
  // name/amount/category to fabricate a `RecurringRule` from — see
  // `composeRecurringManagement`). It must still be visible + discardable,
  // so this reads the RAW current-scope recurring ops directly (never a
  // fabricated row) and renders a standalone notice for exactly the ones
  // that are terminal-failed AND have no corresponding management row.
  const managementRowIds = useMemo(
    () => new Set(recurringManagementRows.map((r) => r.id)),
    [recurringManagementRows],
  );
  const orphanActiveFailures = useMemo(
    () =>
      pending.pendingRecurringOps.filter(
        (op) =>
          op.entity === 'recurring' &&
          op.op === 'update' &&
          op.updateKind === 'active' &&
          pending.failedRecurringIds.has(op.entityId) &&
          !managementRowIds.has(op.entityId),
      ),
    [pending.pendingRecurringOps, pending.failedRecurringIds, managementRowIds],
  );

  /* ---------------- active toggle ---------------- */

  const doToggle = async (id: string, nextActive: boolean, token: string) => {
    if (pendingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    pendingRef.current = true;
    setPendingId(id);

    const res = await setRecurringActive({
      householdId: activeHousehold.id,
      recurringId: id,
      expectedUserId: session.user.id,
      active: nextActive,
      expectedUpdatedAt: token,
    });

    if (res.ok) {
      await refresh();
      pendingRef.current = false;
      setPendingId(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      return;
    }

    // STEP 16-H2-F2 §3: a TRANSPORT failure (offline) -> durable ACTIVE
    // toggle queue with the SAME frozen token captured BEFORE the toggle.
    if (res.transport === true) {
      const enq = await pending.enqueueRecurringActiveUpdate({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: id,
        active: nextActive,
        expectedUpdatedAt: token,
      });
      pendingRef.current = false;
      setPendingId(null);
      if (enq.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('상태 변경을 저장했어요 · 인터넷에 연결되면 자동으로 반영할게요');
        return;
      }
      toast.show(enqueueFailMessage(enq.reason));
      return;
    }

    await refresh();
    pendingRef.current = false;
    setPendingId(null);
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 기기에서 변경됐어요. 최신 상태를 불러왔어요.');
  };

  const toggleRule = (r: RecurringRule) => {
    // §3/§17: block a second write while ANY pending/failed op already sits
    // on this row (CREATE/FULL-UPDATE/ACTIVE/DELETE) — never a second toggle
    // stacked on top of an in-flight one.
    if (!canToggle || pendingRef.current || pendingRecurringOps.has(r.id)) return;
    const token = recurringMeta[r.id]?.updatedAt ?? null;
    if (!token) {
      toast.show('반복 항목 정보를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.');
      return;
    }
    void doToggle(r.id, !r.active, token);
  };

  /* ---------------- soft delete ---------------- */

  const doDelete = async (id: string, token: string) => {
    if (pendingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    pendingRef.current = true;
    setPendingId(id);

    const res = await softDeleteRecurring({
      id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    if (res.ok) {
      await refresh();
      pendingRef.current = false;
      setPendingId(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('반복 항목을 삭제했어요');
      return;
    }

    // STEP 16-H2-F2 §4: a TRANSPORT failure (offline) -> durable soft-DELETE
    // queue with the SAME frozen token captured before the confirm Alert.
    if (res.transport === true) {
      const enq = await pending.enqueueRecurringDelete({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: id,
        expectedUpdatedAt: token,
      });
      pendingRef.current = false;
      setPendingId(null);
      if (enq.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('반복 항목을 삭제했어요 · 인터넷에 연결되면 자동으로 반영할게요');
        return;
      }
      toast.show(enqueueFailMessage(enq.reason));
      return;
    }

    await refresh();
    pendingRef.current = false;
    setPendingId(null);
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 곳에서 변경됐거나 삭제된 반복 항목이에요. 최신 내용을 불러왔어요.');
  };

  const confirmDelete = (r: RecurringRule) => {
    if (!canDelete || pendingRef.current || pendingRecurringOps.has(r.id)) return;
    // Capture the concurrency token BEFORE the Alert — a background refresh
    // can't swap it under us. No token => no safe concurrency-guarded delete.
    const token = recurringMeta[r.id]?.updatedAt ?? null;
    if (!token) {
      toast.show('반복 항목 정보를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.');
      return;
    }
    Alert.alert('반복 항목을 삭제할까요?', '이미 기록된 거래에는 영향을 주지 않아요.', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => void doDelete(r.id, token) },
    ]);
  };

  if (status !== 'ready') {
    return (
      <ModalScreen title="반복 지출·수입" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  const addBtn = canCreate ? (
    <Pressable
      onPress={openAdd}
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

  return (
    <ModalScreen title="반복 지출·수입" onClose={() => router.back()} right={addBtn} refreshControl={financeRefresh}>
      <Card style={{ marginTop: spacing.xs }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: colors.textSub }}>
              이번 달 반복 예정
            </Text>
            <Text
              style={{
                fontFamily: fontFamily.extrabold,
                fontSize: 22,
                letterSpacing: -0.4,
                color: colors.text,
                marginTop: 4,
                ...tabularNums,
              }}
            >
              {monthlyTotal === 0 ? '' : tab === 'expense' ? '−' : '+'}
              {fmt(monthlyTotal)}
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 14, color: colors.textSub }}> 원</Text>
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 2 }}>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>
              활성 <Text style={{ fontFamily: fontFamily.bold, color: colors.text }}>{activeCount}개</Text>
            </Text>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>
              정지 <Text style={{ fontFamily: fontFamily.bold, color: colors.text }}>{pausedCount}개</Text>
            </Text>
          </View>
        </View>
      </Card>

      <View style={{ paddingHorizontal: spacing.lg }}>
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'expense', label: `지출 (${recurring.filter((r) => r.type === 'expense').length})`, tone: 'expense' },
            { value: 'income', label: `수입 (${recurring.filter((r) => r.type === 'income').length})`, tone: 'income' },
          ]}
        />
      </View>

      {filtered.length === 0 ? (
        <EmptyState
          icon={canCreate ? undefined : 'refresh'}
          onPress={canCreate ? openAdd : undefined}
          cta={canCreate ? '반복 항목 추가하기' : undefined}
          title="반복 항목이 없어요"
          sub={
            canCreate
              ? '매달·매주 반복되는 지출·수입을 등록해두면\n한눈에 관리할 수 있어요'
              : '우리집 가계부에 등록된 반복 항목이 없어요'
          }
        />
      ) : (
        <View style={{ marginTop: spacing.md }}>
          <Text
            style={{
              fontFamily: fontFamily.bold,
              fontSize: 11,
              letterSpacing: 0.2,
              color: colors.textSub,
              marginHorizontal: spacing.xl,
              marginBottom: spacing.sm,
            }}
          >
            {tab === 'expense' ? '나가는 돈' : '들어오는 돈'}
          </Text>
          {filtered.map((r) => {
            const cat = getCat(r.category, r.type, customCats);
            const rowPending = pendingId === r.id;

            // STEP 16-H2-F2 §6–§11/§17: a row with an in-flight / terminal-
            // failed offline op (CREATE, FULL UPDATE, ACTIVE toggle, or
            // DELETE) is READ-ONLY — no tap-to-edit, no toggle, no delete,
            // no second queued write. It shows a status block instead; a
            // terminal-failed op also offers "변경 버리기". The displayed
            // row is ALWAYS the authoritative server value when one exists
            // (`recurringManagementRows` already resolved that — a failed
            // ACTIVE toggle's row here always shows the authoritative
            // `active`, never the failed attempted one) — `attemptedDraft`/
            // `attemptedActive` are conflict metadata only.
            const pendingOp = pendingRecurringOps.get(r.id);
            const pl = pendingOp ? pendingRecurringRowLabel(pendingOp) : null;

            // The row body (tap -> edit) and the toggle / trash controls are
            // SIBLINGS, not nested — a tap lands on exactly one, so toggling
            // or deleting never also navigates to the edit screen.
            const body = (
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: radii.md,
                    backgroundColor: cat.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <AppIcon name={cat.icon} size={20} color={cat.color} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <Text
                    numberOfLines={1}
                    style={{ fontFamily: fontFamily.semibold, fontSize: 13, lineHeight: 16, color: colors.text, ...noPad }}
                  >
                    {r.name}
                  </Text>
                  <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, lineHeight: 12, color: colors.textMuted, ...noPad }}>
                    {describeSchedule(r)} · {r.active ? '활성' : '정지'}
                  </Text>
                </View>
                <Text
                  style={{
                    fontFamily: fontFamily.bold,
                    fontSize: 13,
                    color: r.type === 'income' ? colors.incomeStrong : colors.text,
                    ...tabularNums,
                  }}
                >
                  {r.type === 'income' ? '+' : '−'}
                  {fmt(r.amount)}
                </Text>
              </View>
            );

            return (
              <View
                key={r.id}
                style={{
                  marginHorizontal: spacing.lg,
                  marginBottom: spacing.sm,
                  paddingVertical: 12,
                  paddingHorizontal: spacing.lg,
                  backgroundColor: colors.white,
                  borderWidth: 1,
                  borderColor: pendingOp ? colors.primaryLight : colors.border,
                  borderRadius: radii.xl,
                  opacity: rowPending ? 0.5 : r.active ? 1 : 0.6,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  {canEdit && !pendingOp ? (
                    <Pressable
                      onPress={() => openEdit(r.id)}
                      disabled={rowPending}
                      style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.6 }]}
                    >
                      {body}
                    </Pressable>
                  ) : (
                    <View style={{ flex: 1 }}>{body}</View>
                  )}

                  {canToggle && !pendingOp && <Toggle value={r.active} onChange={() => toggleRule(r)} disabled={rowPending} />}

                  {canDelete && !pendingOp && (
                    <Pressable
                      onPress={() => confirmDelete(r)}
                      disabled={rowPending}
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
                </View>

                {pl && pendingOp && (
                  <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border, gap: 2 }}>
                    <Text
                      style={{
                        fontFamily: fontFamily.bold,
                        fontSize: 11,
                        color: pendingOp.failed ? colors.expenseText : colors.primaryStrong,
                      }}
                    >
                      {pl.primary}
                    </Text>
                    {pl.detail && (
                      <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>{pl.detail}</Text>
                    )}
                    {pendingOp.failed && pendingOp.attemptedDraft && (
                      <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textMuted, ...tabularNums }}>
                        시도한 금액: {fmt(pendingOp.attemptedDraft.amount)}원
                      </Text>
                    )}
                    {pendingOp.failed && pendingOp.attemptedActive !== undefined && (
                      <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textMuted }}>
                        {attemptedActiveLabel(pendingOp.attemptedActive)}
                      </Text>
                    )}
                    {pendingOp.failed && pendingOp.queueId && (
                      <Pressable onPress={() => discardFailed(pendingOp.queueId!)} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 2 }}>
                        <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.primaryStrong }}>변경 버리기</Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* STEP 16-H2-F2 §13 — orphan failed ACTIVE toggle: the recurring row
          it targeted is gone on the server, so there is nothing to overlay a
          row onto. Rendered as a small standalone, read-only notice —
          NEVER a fabricated RecurringRule — with the SAME generic
          discardPending(queueId) path as every other "변경 버리기". */}
      {orphanActiveFailures.length > 0 && (
        <View style={{ marginTop: spacing.md, marginHorizontal: spacing.lg, gap: spacing.sm }}>
          {orphanActiveFailures.map((op) => {
            if (op.entity !== 'recurring' || op.op !== 'update' || op.updateKind !== 'active') return null;
            return (
              <View
                key={op.queueId}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: spacing.lg,
                  backgroundColor: colors.white,
                  borderWidth: 1,
                  borderColor: colors.expenseLight,
                  borderRadius: radii.xl,
                  gap: 2,
                }}
              >
                <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.expenseText }}>
                  삭제된 반복거래의 상태 변경을 반영하지 못했어요
                </Text>
                <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textMuted }}>
                  {attemptedActiveLabel(op.payload.active)}
                </Text>
                <Pressable onPress={() => discardFailed(op.queueId)} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                  <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.primaryStrong }}>변경 버리기</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
    </ModalScreen>
  );
}
