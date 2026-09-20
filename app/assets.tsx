import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { assetTypeIcon, describeAssetType } from '@/lib/asset';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt } from '@/lib/format';
import { summarizeNetWorth } from '@/lib/netWorth';
import { useFinanceRead } from '@/store/financeRead';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

/**
 * 자산관리 목록 — 전체자산/순자산 STEP 5.
 *
 * cards.tsx/loans.tsx/goals.tsx와 동일한 뼈대: `ModalScreen` + 상단 요약
 * 그라디언트 카드 + `EmptyState`/목록 + 우상단 추가 버튼. `useFinanceRead()`
 * 만 읽고, 로컬 `useStore()`는 전혀 사용하지 않는다 — household finance는
 * 항상 remote-only.
 *
 * assets는 아직 오프라인 큐에 연결되지 않았다(STEP 4/5 범위 밖) — 그래서
 * cards.tsx/loans.tsx/goals.tsx가 쓰는 `*ManagementRows`/`pending*Ops`
 * 오버레이가 없다. 여기서는 `useFinanceRead().assets`(authoritative-server
 * 그대로)를 직접 렌더링한다. 정렬도 하지 않는다 — 서버가 반환한 순서 그대로
 * (다른 엔티티 목록 화면들도 클라이언트 정렬을 하지 않는 것과 동일).
 *
 * 삭제는 이 화면에 없다 — asset-add.tsx의 수정 모드에서만 가능(loan-add.tsx
 * 패턴과 동일).
 */
export default function AssetsList() {
  const router = useRouter();
  const { status, error, assets, loans, refresh } = useFinanceRead();
  const financeRefresh = useRemoteFinanceRefreshControl();

  const canCreate = REMOTE_FINANCE_WRITE.assetCreate;
  const canEdit = REMOTE_FINANCE_WRITE.assetEdit;

  const openAdd = () => router.push('/asset-add');
  const openEdit = (id: string) => router.push({ pathname: '/asset-add', params: { id } });

  if (status !== 'ready') {
    return (
      <ModalScreen title="자산관리" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  // netWorth.ts 재사용 — 이 파일에서 직접 합계식을 다시 만들지 않는다.
  const { totalAssets, totalDebt, netWorth } = summarizeNetWorth(assets, loans);

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
    <ModalScreen title="자산관리" onClose={() => router.back()} right={addBtn} refreshControl={financeRefresh}>
      <LinearGradient
        colors={gradients.primary}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          marginHorizontal: spacing.lg,
          marginTop: spacing.sm,
          marginBottom: 18,
          padding: spacing.xl,
          borderRadius: radii.card,
        }}
      >
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: 'rgba(255,255,255,0.9)' }}>
          내 순자산
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
          <Text
            style={{ fontFamily: fontFamily.extrabold, fontSize: 30, letterSpacing: -1, color: colors.white, ...tabularNums }}
          >
            {netWorth < 0 ? '−' : ''}{fmt(netWorth)}
          </Text>
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 15, color: 'rgba(255,255,255,0.9)' }}>원</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 14, marginTop: 10 }}>
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: 'rgba(255,255,255,0.9)', ...tabularNums }}>
            총자산 {fmt(totalAssets)}원
          </Text>
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: 'rgba(255,255,255,0.9)', ...tabularNums }}>
            총부채 {fmt(totalDebt)}원
          </Text>
        </View>
      </LinearGradient>

      {assets.length === 0 ? (
        <EmptyState
          icon={canCreate ? undefined : 'won'}
          onPress={canCreate ? openAdd : undefined}
          cta={canCreate ? '자산 추가하기' : undefined}
          title="등록된 자산이 없어요"
          sub={
            canCreate
              ? '현금, 통장, 예적금, 투자자산을 등록해 보세요.'
              : '우리집 가계부에 등록된 자산이 없어요'
          }
        />
      ) : (
        assets.map((a) => {
          const row = (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: radii.lg,
                  backgroundColor: colors.primaryLight,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <AppIcon name={assetTypeIcon(a.type)} size={18} color={colors.primaryStrong} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text
                  numberOfLines={1}
                  style={{ fontFamily: fontFamily.bold, fontSize: 14, lineHeight: 17, color: colors.text, ...noPad }}
                >
                  {a.name}
                </Text>
                <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 14, color: colors.textMuted, ...noPad }}>
                  {describeAssetType(a.type)}
                </Text>
              </View>
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, ...tabularNums }}>
                {fmt(a.balance)}원
              </Text>
              {canEdit && <AppIcon name="chev-right" size={16} color={colors.textFaint} />}
            </View>
          );
          return (
            <View
              key={a.id}
              style={{
                marginHorizontal: spacing.lg,
                marginBottom: spacing.sm,
                padding: spacing.lg,
                backgroundColor: colors.white,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radii.xxl,
              }}
            >
              {canEdit ? (
                <Pressable onPress={() => openEdit(a.id)} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
                  {row}
                </Pressable>
              ) : (
                row
              )}
            </View>
          );
        })
      )}

      {/* 대출/부채 — 기존 loans 데이터를 읽기 전용으로 합산 표시만. 새로운
          부채 데이터는 만들지 않고, 자산 목록에도 loan을 섞지 않는다. */}
      <Pressable onPress={() => router.push('/loans')} style={{ marginTop: spacing.sm }}>
        <View
          style={{
            marginHorizontal: spacing.lg,
            padding: spacing.lg,
            backgroundColor: colors.white,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radii.xxl,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text }}>대출 / 부채</Text>
              <AppIcon name="chev-right" size={14} color={colors.textFaint} />
            </View>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, ...tabularNums }}>
              {fmt(totalDebt)}원
            </Text>
          </View>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textMuted, marginTop: 6 }}>
            {loans.length > 0 ? `대출 ${loans.length}건 · ` : ''}대출 관리 →
          </Text>
        </View>
      </Pressable>
    </ModalScreen>
  );
}
