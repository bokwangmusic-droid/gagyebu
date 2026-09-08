import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { Card } from '@/components/ui/Card';
import { SegmentedTabs, Toggle } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { getCat, type TxnType } from '@/data/categories';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt } from '@/lib/format';
import { describeSchedule } from '@/lib/recurring';
import { setRecurringActive, softDeleteRecurring } from '@/services/remoteRecurringWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import type { RecurringRule } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

export default function RecurringList() {
  const router = useRouter();
  const toast = useToast();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { status, error, recurring, recurringMeta, customCats, refresh } = useFinanceRead();
  const [tab, setTab] = useState<TxnType>('expense');

  // One row-level write at a time (toggle OR delete). Dims + disables that row.
  const pendingRef = useRef(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const canCreate = REMOTE_FINANCE_WRITE.recurringCreate;
  const canEdit = REMOTE_FINANCE_WRITE.recurringEdit;
  const canToggle = REMOTE_FINANCE_WRITE.recurringToggle;
  const canDelete = REMOTE_FINANCE_WRITE.recurringDelete;

  const filtered = useMemo(() => recurring.filter((r) => r.type === tab), [recurring, tab]);
  const monthlyTotal = filtered.filter((r) => r.active).reduce((s, r) => s + r.amount, 0);
  const activeCount = recurring.filter((r) => r.active).length;
  const pausedCount = recurring.length - activeCount;

  const openAdd = () => router.push({ pathname: '/recurring-add', params: { type: tab } });
  const openEdit = (id: string) => router.push({ pathname: '/recurring-add', params: { id } });

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

    await refresh();
    pendingRef.current = false;
    setPendingId(null);

    if (res.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      return;
    }
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 기기에서 변경됐어요. 최신 상태를 불러왔어요.');
  };

  const toggleRule = (r: RecurringRule) => {
    if (!canToggle || pendingRef.current) return;
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

    await refresh();
    pendingRef.current = false;
    setPendingId(null);

    if (res.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('반복 항목을 삭제했어요');
      return;
    }
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 곳에서 변경됐거나 삭제된 반복 항목이에요. 최신 내용을 불러왔어요.');
  };

  const confirmDelete = (r: RecurringRule) => {
    if (!canDelete || pendingRef.current) return;
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
    <ModalScreen title="반복 지출·수입" onClose={() => router.back()} right={addBtn}>
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
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.sm,
                  marginHorizontal: spacing.lg,
                  marginBottom: spacing.sm,
                  paddingVertical: 12,
                  paddingHorizontal: spacing.lg,
                  backgroundColor: colors.white,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: radii.xl,
                  opacity: rowPending ? 0.5 : r.active ? 1 : 0.6,
                }}
              >
                {canEdit ? (
                  <Pressable
                    onPress={() => openEdit(r.id)}
                    disabled={rowPending}
                    style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.6 }]}
                  >
                    {body}
                  </Pressable>
                ) : (
                  body
                )}

                {canToggle && (
                  <Toggle
                    value={r.active}
                    onChange={() => toggleRule(r)}
                    disabled={rowPending}
                  />
                )}

                {canDelete && (
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
            );
          })}
        </View>
      )}
    </ModalScreen>
  );
}
