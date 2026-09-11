import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { FinanceReadOnlyBanner } from '@/components/FinanceReadOnlyBanner';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { Card } from '@/components/ui/Card';
import { SegmentedTabs } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { Screen } from '@/components/ui/Screen';
import { HeaderIconButton, ScreenHeader } from '@/components/ui/ScreenHeader';
import { useToast } from '@/components/ui/Toast';
import { getCat } from '@/data/categories';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, weekdayKo } from '@/lib/format';
import { pendingPlannedRowLabel } from '@/lib/pendingPlannedLabel';
import type { EnqueueOutcome } from '@/services/offlineQueue/coordinator';
import { softDeletePlanned } from '@/services/remotePlannedWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead, type FinanceReadResult } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';
import type { PlannedExpense } from '@/store/types';

const DAY_MS = 86_400_000;
const TAG_STYLE = {
  expense: { bg: colors.expenseLight, fg: colors.expenseStrong },
  warning: { bg: colors.warningLight, fg: colors.warningText },
  violet: { bg: colors.primaryLight, fg: colors.primaryStrong },
} as const;

export default function PlannedScreen() {
  const router = useRouter();
  const toast = useToast();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const {
    status,
    error,
    planned,
    plannedMeta,
    // STEP 16-H2-E2 §4: the LIST renders `plannedManagementRows` (authoritative
    // server planned + pending CREATE synthetic + NOT-failed pending UPDATE
    // overlay − not-failed pending DELETE + failed-orphan synthetic). The
    // "앞으로 나갈 예정" money total below stays on the AUTHORITATIVE `planned`
    // (Budget-tab precedent), and Home keeps reading `planned` untouched.
    plannedManagementRows,
    pendingPlannedOps,
    notes,
    customCats,
    refresh,
  } = useFinanceRead();
  const pending = usePendingWrites();
  const financeRefresh = useRemoteFinanceRefreshControl();
  const [tab, setTab] = useState<'planned' | 'notes'>('planned');

  const deletingRef = useRef(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const canCreate = REMOTE_FINANCE_WRITE.plannedCreate;
  const canEdit = REMOTE_FINANCE_WRITE.plannedEdit;
  const canDelete = REMOTE_FINANCE_WRITE.plannedDelete;

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const groups = useMemo(() => {
    const sorted = [...plannedManagementRows].sort((a, b) => +new Date(a.date) - +new Date(b.date));
    const g: { overdue: Row[]; today: Row[]; week: Row[]; later: Row[] } = {
      overdue: [],
      today: [],
      week: [],
      later: [],
    };
    for (const p of sorted) {
      const diff = Math.round((+new Date(`${p.date}T00:00:00`) - +now) / DAY_MS);
      const row = { p, diff };
      if (diff < 0) g.overdue.push(row);
      else if (diff === 0) g.today.push(row);
      else if (diff <= 7) g.week.push(row);
      else g.later.push(row);
    }
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannedManagementRows]);

  // AUTHORITATIVE money total — never counts a pending/failed synthetic row,
  // and drops a queued-DELETE row only after the server confirms it (same as
  // Home). Deliberately reads `planned`, not `plannedManagementRows` (§4).
  const totalUpcoming = planned.reduce((s, p) => s + (p.amount || 0), 0);
  const listCount = plannedManagementRows.length;

  const enqueueFailMessage = (reason: Exclude<EnqueueOutcome, { ok: true }>['reason']): string => {
    switch (reason) {
      case 'not-hydrated':
        return '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.';
      case 'persist':
        return '예정 지출을 기기에 저장하지 못했어요. 다시 시도해주세요.';
      case 'cap':
        return '전송 대기 중인 항목이 너무 많아요. 인터넷 연결 후 다시 시도해주세요.';
      case 'existing-pending':
        return '이미 전송 대기 중인 변경이 있어요.';
    }
  };

  const discardFailed = (queueId: string) => {
    Alert.alert('실패한 변경을 버릴까요?', '다른 기기에 저장된 최신 예정 지출은 그대로 유지됩니다.', [
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

  const openAdd = () => router.push('/planned-add');
  const openEdit = (id: string) => router.push({ pathname: '/planned-add', params: { id } });

  const doDelete = async (id: string, token: string) => {
    if (deletingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    deletingRef.current = true;
    setDeletingId(id);

    const res = await softDeletePlanned({
      id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    if (res.ok) {
      await refresh();
      deletingRef.current = false;
      setDeletingId(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('예정 지출을 삭제했어요');
      return;
    }

    // STEP 16-H2-E2 §3: TRANSPORT failure (offline) -> durable soft-DELETE
    // queue with the token captured at delete-initiation time (frozen).
    if (res.transport === true) {
      const enq = await pending.enqueuePlannedDelete({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: id,
        expectedUpdatedAt: token,
      });
      deletingRef.current = false;
      setDeletingId(null);
      if (enq.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('예정 지출을 삭제했어요 · 인터넷에 연결되면 자동으로 반영할게요');
        return;
      }
      toast.show(enqueueFailMessage(enq.reason));
      return;
    }

    await refresh();
    deletingRef.current = false;
    setDeletingId(null);
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 곳에서 변경됐거나 삭제된 예정 지출이에요. 최신 내용을 불러왔어요.');
  };

  const confirmDelete = (p: PlannedExpense) => {
    if (!canDelete || deletingRef.current) return;
    // Capture the concurrency token at the moment the delete is initiated —
    // NOT after the Alert is confirmed — so a background refresh can't swap
    // it under us. No token => no safe concurrency-guarded delete.
    const token = plannedMeta[p.id]?.updatedAt ?? null;
    if (!token) {
      toast.show('예정 지출 정보를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.');
      return;
    }
    Alert.alert('예정 지출을 삭제할까요?', '실제 거래 내역에는 영향을 주지 않아요.', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => void doDelete(p.id, token) },
    ]);
  };

  if (status !== 'ready') {
    return (
      <Screen>
        <ScreenHeader title="예정 · 메모" />
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  return (
    <Screen refreshControl={financeRefresh}>
      <ScreenHeader
        title="예정 · 메모"
        right={
          canCreate && tab === 'planned' ? (
            <HeaderIconButton icon="plus" primary onPress={openAdd} />
          ) : undefined
        }
      />
      {/* The notes tab is still read-only; the planned tab now supports
          add/edit/delete, so the banner only applies to notes. */}
      {tab === 'notes' && <FinanceReadOnlyBanner />}

      <View style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.lg }}>
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'planned', label: `예정 지출${planned.length > 0 ? ` (${planned.length})` : ''}` },
            { value: 'notes', label: '메모' },
          ]}
        />
      </View>

      {tab === 'planned' ? (
        <>
          {planned.length > 0 && (
            <Card>
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.textSub }}>앞으로 나갈 예정</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
                <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 34, letterSpacing: -1, color: colors.text, ...tabularNums }}>
                  {fmt(totalUpcoming)}
                </Text>
                <Text style={{ fontFamily: fontFamily.medium, fontSize: 16, color: colors.textSub }}>원</Text>
              </View>
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub, marginTop: 6 }}>
                총 {planned.length}건 · 결제일 오면 앱이 알려드려요
              </Text>
            </Card>
          )}

          {listCount === 0 ? (
            <EmptyState
              icon={canCreate ? undefined : 'calendar'}
              onPress={canCreate ? openAdd : undefined}
              cta={canCreate ? '예정 지출 추가하기' : undefined}
              title="예정된 지출이 없어요"
              sub={
                canCreate
                  ? '예정된 지출을 추가해두면\n결제일이 올 때 홈에서 알려드려요'
                  : '우리집 가계부에 예정된 지출이 없어요'
              }
            />
          ) : (
            <>
              <Group
                label="지난 예정"
                color={colors.expenseStrong}
                rows={groups.overdue}
                customCats={customCats}
                deletingId={deletingId}
                pendingOps={pendingPlannedOps}
                onEdit={canEdit ? openEdit : undefined}
                onDelete={canDelete ? confirmDelete : undefined}
                onDiscard={discardFailed}
              />
              <Group
                label="오늘 · 임박"
                color={colors.warningText}
                rows={groups.today}
                customCats={customCats}
                deletingId={deletingId}
                pendingOps={pendingPlannedOps}
                onEdit={canEdit ? openEdit : undefined}
                onDelete={canDelete ? confirmDelete : undefined}
                onDiscard={discardFailed}
              />
              <Group
                label="이번 주 (7일 이내)"
                rows={groups.week}
                customCats={customCats}
                deletingId={deletingId}
                pendingOps={pendingPlannedOps}
                onEdit={canEdit ? openEdit : undefined}
                onDelete={canDelete ? confirmDelete : undefined}
                onDiscard={discardFailed}
              />
              <Group
                label="나중에"
                rows={groups.later}
                customCats={customCats}
                deletingId={deletingId}
                pendingOps={pendingPlannedOps}
                onEdit={canEdit ? openEdit : undefined}
                onDelete={canDelete ? confirmDelete : undefined}
                onDiscard={discardFailed}
              />
            </>
          )}
        </>
      ) : (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub, lineHeight: 18, marginBottom: spacing.md, paddingHorizontal: 4 }}>
            우리집 메모예요. 지금은 조회만 할 수 있어요.
          </Text>
          <TextInput
            value={notes}
            editable={false}
            multiline
            placeholder="아직 메모가 없어요"
            placeholderTextColor={colors.textMuted}
            style={{
              minHeight: 320,
              padding: 16,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radii.xl,
              backgroundColor: colors.track,
              fontFamily: fontFamily.regular,
              fontSize: 14,
              lineHeight: 24,
              color: colors.text,
              textAlignVertical: 'top',
            }}
          />
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textMuted, textAlign: 'right', marginTop: 6, ...tabularNums }}>
            {notes.length}자
          </Text>
        </View>
      )}
    </Screen>
  );
}

interface Row {
  p: PlannedExpense;
  diff: number;
}

function Group({
  label,
  color,
  rows,
  customCats,
  deletingId,
  pendingOps,
  onEdit,
  onDelete,
  onDiscard,
}: {
  label: string;
  color?: string;
  rows: Row[];
  customCats: Parameters<typeof getCat>[2];
  deletingId: string | null;
  /** planned id -> offline-op state (STEP 16-H2-E2). A row present here is
   *  read-only: no tap-to-edit, no delete. */
  pendingOps: FinanceReadResult['pendingPlannedOps'];
  onEdit?: (id: string) => void;
  onDelete?: (p: PlannedExpense) => void;
  onDiscard?: (queueId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <Text
        style={{
          fontFamily: fontFamily.bold,
          fontSize: 11,
          letterSpacing: 0.2,
          color: color ?? colors.textSub,
          marginHorizontal: spacing.xl,
          marginBottom: spacing.sm,
        }}
      >
        {label}
      </Text>
      {rows.map(({ p, diff }) => {
        const cat = getCat(p.category, p.type, customCats);
        const d = new Date(`${p.date}T00:00:00`);
        const dayLabel = `${d.getMonth() + 1}/${d.getDate()}(${weekdayKo(d)})`;
        const status =
          diff < 0
            ? { text: `${Math.abs(diff)}일 지남`, tag: 'expense' as const }
            : diff === 0
              ? { text: '오늘', tag: 'warning' as const }
              : diff <= 3
                ? { text: `D-${diff}`, tag: 'warning' as const }
                : { text: `D-${diff}`, tag: 'violet' as const };
        const ts = TAG_STYLE[status.tag];
        const dimmed = deletingId === p.id;

        // STEP 16-H2-E2 §5–§13: a row with an in-flight / terminal-failed
        // offline op is READ-ONLY — no tap-to-edit, no delete button, no
        // second queued write. It shows a status line instead; a
        // terminal-failed op also offers "변경 버리기". The displayed row is
        // ALWAYS the authoritative server value when one exists (§8/§9/§11) —
        // `plannedManagementRows` already resolved that; `attemptedDraft` here
        // is conflict metadata only, never the row itself.
        const pendingOp = pendingOps.get(p.id);
        const pl = pendingOp ? pendingPlannedRowLabel(pendingOp) : null;

        // ROW LAYOUT FIX (PLANNED ROW LAYOUT ONLY — no queue/offline logic
        // touched here): the title and the D-day badge used to share ONE
        // horizontal row with no shrink/ellipsis on the title `<Text>`. RN's
        // default `flexShrink` is 0 (unlike CSS's 1), so a long title never
        // compressed — it rendered at its full intrinsic width and visually
        // overflowed the `flex:1` middle column's box, colliding with the
        // D-day badge and, further right, the amount column. Fix:
        //   - title now stands ALONE on its own line, `numberOfLines={1}` +
        //     `ellipsizeMode="tail"` inside a `flex:1, minWidth:0` container
        //     — it can only ellipsize, never overflow past its box.
        //   - the D-day badge moved to the meta line (`flexShrink:0`, fixed
        //     content width, never compressed) ahead of the date/category/
        //     memo text (`flexShrink:1` + `numberOfLines={1}`, so IT
        //     ellipsizes instead of pushing the badge or wrapping).
        //   - amount is a RIGHT-COLUMN sibling of the icon+content row, not
        //     nested inside the shrinkable middle column, with
        //     `flexShrink: 0` and `numberOfLines={1}` — it always renders in
        //     full and never competes for width with the title/meta/badge.
        // No absolute positioning; no font-size reduction.
        const body = (
          <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
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
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{ fontFamily: fontFamily.semibold, fontSize: 14, lineHeight: 17, color: colors.text, ...noPad }}
              >
                {p.name}
              </Text>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <View
                  style={{
                    flexShrink: 0,
                    backgroundColor: ts.bg,
                    paddingHorizontal: 6,
                    paddingVertical: 1,
                    borderRadius: 4,
                  }}
                >
                  <Text style={{ fontFamily: fontFamily.bold, fontSize: 9, color: ts.fg }}>{status.text}</Text>
                </View>
                <Text
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  style={{ flexShrink: 1, fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 14, color: colors.textMuted, ...noPad }}
                >
                  {dayLabel} · {cat.name}
                  {p.memo ? ` · ${p.memo}` : ''}
                </Text>
              </View>
            </View>
            <Text
              numberOfLines={1}
              style={{ flexShrink: 0, fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, ...tabularNums }}
            >
              {p.type === 'income' ? '+' : '−'}{fmt(p.amount)}
            </Text>
          </View>
        );

        return (
          <View
            key={p.id}
            style={{
              marginHorizontal: spacing.lg,
              marginBottom: spacing.sm,
              paddingVertical: 14,
              paddingHorizontal: spacing.lg,
              backgroundColor: colors.white,
              borderWidth: 1,
              borderColor: pendingOp ? colors.primaryLight : colors.border,
              borderRadius: radii.xl,
              opacity: dimmed ? 0.5 : 1,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              {onEdit && !pendingOp ? (
                <Pressable
                  onPress={() => onEdit(p.id)}
                  disabled={dimmed}
                  style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.6 }]}
                >
                  {body}
                </Pressable>
              ) : (
                <View style={{ flex: 1 }}>{body}</View>
              )}

              {onDelete && !pendingOp && (
                <Pressable
                  onPress={() => onDelete(p)}
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
            </View>

            {pl && pendingOp && (
              <View
                style={{
                  marginTop: 8,
                  paddingTop: 8,
                  borderTopWidth: 1,
                  borderTopColor: colors.border,
                  gap: 2,
                }}
              >
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
                  <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>
                    {pl.detail}
                  </Text>
                )}
                {pendingOp.failed && pendingOp.attemptedDraft && (
                  <Text
                    style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textMuted, ...tabularNums }}
                  >
                    시도한 금액: {fmt(pendingOp.attemptedDraft.amount)}원
                  </Text>
                )}
                {pendingOp.failed && pendingOp.queueId && onDiscard && (
                  <Pressable
                    onPress={() => onDiscard(pendingOp.queueId!)}
                    hitSlop={8}
                    style={{ alignSelf: 'flex-start', marginTop: 2 }}
                  >
                    <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.primaryStrong }}>
                      변경 버리기
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        );
      })}
    </>
  );
}
