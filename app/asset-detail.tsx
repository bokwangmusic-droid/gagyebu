import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { HeaderTextButton } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { getCat } from '@/data/categories';
import { assetInstitutionMode, describeAssetInstitution, describeAssetType } from '@/lib/asset';
import { signedBalance } from '@/lib/assetBalance';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt } from '@/lib/format';
import { accountEntryLabel, accountTransactions } from '@/lib/paymentLink';
import { pendingTransactionRowLabel } from '@/lib/pendingTransactionLabel';
import { useFinanceRead } from '@/store/financeRead';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

/**
 * 계좌 상세 / 입출금 내역 — /asset-detail?id=<asset id>.
 *
 * Opened from 자산관리 for a 은행계좌. Read-only: the header shows the
 * account and its 현재 잔액 — the server `balance`, which the DB trigger
 * (20261004001900) moves on every linked transaction write, plus the
 * display-only offline overlay; nothing here writes it. The 「수정」 header button opens the existing
 * /asset-add?id= edit form unchanged, and the list below is DERIVED from
 * `useFinanceRead().transactions` on every render (`accountTransactions`:
 * 지출 source_asset_id / 수입 destination_asset_id), so editing a
 * transaction's account or deleting it shows up here as soon as the shared
 * finance data refreshes — there is no separate 통장 ledger.
 *
 * Rows reuse app/all-transactions.tsx's row layout and its edit entry
 * (/input?id=, disabled while that transaction has a pending offline op).
 */
export default function AssetDetail() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const {
    status,
    error,
    assets,
    assetBalanceOverlay,
    transactions,
    cards,
    customCats,
    pendingTransactionOps,
    refresh,
  } = useFinanceRead();
  const financeRefresh = useRemoteFinanceRefreshControl();

  const asset = id ? assets.find((a) => a.id === id) : undefined;
  const entries = useMemo(() => (id ? accountTransactions(transactions, id) : []), [transactions, id]);

  if (status !== 'ready') {
    return (
      <ModalScreen title="계좌 상세" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  if (!asset) {
    // Deleted (here or by another member) or a bad link — never a blank screen.
    return (
      <ModalScreen title="계좌 상세" onClose={() => router.back()}>
        <EmptyState icon="won" title="계좌를 찾을 수 없어요" sub="이미 삭제됐거나 다른 우리집의 계좌일 수 있어요." />
      </ModalScreen>
    );
  }

  // Server balance (moved by the DB trigger) + a display-only delta for
  // transaction writes still queued offline (never written back).
  const balance = asset.balance + (assetBalanceOverlay.get(asset.id) ?? 0);

  const institution =
    asset.institution && !(assetInstitutionMode(asset.type) === 'select' && asset.institution === 'other')
      ? describeAssetInstitution(asset.institution)
      : describeAssetType(asset.type);

  const editBtn = REMOTE_FINANCE_WRITE.assetEdit ? (
    <HeaderTextButton
      label="수정"
      onPress={() => router.push({ pathname: '/asset-add', params: { id: asset.id } })}
    />
  ) : undefined;

  return (
    <ModalScreen title="계좌 상세" onClose={() => router.back()} right={editBtn} refreshControl={financeRefresh}>
      {/* Account header */}
      <View
        style={{
          marginHorizontal: spacing.lg,
          marginTop: spacing.sm,
          marginBottom: spacing.lg,
          padding: spacing.lg,
          backgroundColor: colors.white,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radii.xxl,
        }}
      >
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.textSub }}>{institution}</Text>
        <Text
          numberOfLines={1}
          style={{ fontFamily: fontFamily.bold, fontSize: 16, color: colors.text, marginTop: 2 }}
        >
          {asset.name}
        </Text>
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textMuted, marginTop: spacing.md }}>
          현재 잔액
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3, marginTop: 2 }}>
          <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 24, color: colors.text, ...tabularNums }}>
            {signedBalance(balance, fmt)}
          </Text>
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 13, color: colors.textSub }}>원</Text>
        </View>
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, color: colors.textFaint, marginTop: 4 }}>
          거래 내역이 반영된 잔액이에요
        </Text>
      </View>

      {/* 입출금 내역 */}
      <Text
        style={{
          fontFamily: fontFamily.bold,
          fontSize: 13,
          color: colors.text,
          marginHorizontal: spacing.lg + 4,
          marginBottom: spacing.sm,
        }}
      >
        최근 입출금
      </Text>

      {entries.length === 0 ? (
        <EmptyState
          icon="won"
          title="아직 이 계좌와 연결된 거래가 없어요"
          sub="체크카드·이체 지출과 이 계좌로 받은 수입이 여기에 보여요"
        />
      ) : (
        <View
          style={{
            marginHorizontal: spacing.lg,
            marginBottom: spacing.xl,
            backgroundColor: colors.white,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radii.xxl,
            paddingHorizontal: spacing.lg,
          }}
        >
          {entries.map((entry, idx) => {
            const t = entry.transaction;
            const cat = getCat(t.category, t.type, customCats);
            const d = new Date(t.date);
            const opState = pendingTransactionOps.get(t.id);
            const isIn = entry.direction === 'in';
            return (
              <Pressable
                key={t.id}
                onPress={opState ? undefined : () => router.push({ pathname: '/input', params: { id: t.id } })}
                disabled={!!opState || !REMOTE_FINANCE_WRITE.transactionEdit}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingVertical: 10,
                  borderTopWidth: idx === 0 ? 0 : 1,
                  borderTopColor: colors.track,
                  opacity: opState ? 0.6 : 1,
                }}
              >
                <View
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 11,
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
                    {t.memo || cat.name}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ fontFamily: fontFamily.regular, fontSize: 10, lineHeight: 12, color: colors.textMuted, ...noPad }}
                  >
                    {opState
                      ? pendingTransactionRowLabel(opState)
                      : `${d.getMonth() + 1}월 ${d.getDate()}일 · ${accountEntryLabel(entry, cards)}`}
                  </Text>
                </View>
                <Text
                  style={{
                    fontFamily: fontFamily.bold,
                    fontSize: 13,
                    color: isIn ? colors.incomeStrong : colors.text,
                    ...tabularNums,
                  }}
                >
                  {isIn ? '+' : '−'}
                  {fmt(t.amount)}원
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </ModalScreen>
  );
}
