import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { FinanceReadOnlyBanner } from '@/components/FinanceReadOnlyBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { fmt, formatShortDate } from '@/lib/format';
import { describeRepayType, formatYearMonth, viewLoan } from '@/lib/loan';
import { useFinanceRead } from '@/store/financeRead';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

export default function LoansList() {
  const router = useRouter();
  const { status, error, loans, refresh } = useFinanceRead();
  const [expanded, setExpanded] = useState<string | null>(null);

  const totalRemaining = loans.reduce(
    (s, ln) => s + Math.max(0, ln.principal - ln.paid),
    0,
  );

  if (status !== 'ready') {
    return (
      <ModalScreen title="대출 관리" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <ModalScreen title="대출 관리" onClose={() => router.back()}>
      <FinanceReadOnlyBanner />
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
          갚아야 할 남은 원금
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
          <Text
            style={{ fontFamily: fontFamily.extrabold, fontSize: 30, letterSpacing: -1, color: colors.white, ...tabularNums }}
          >
            {fmt(totalRemaining)}
          </Text>
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 15, color: 'rgba(255,255,255,0.9)' }}>원</Text>
        </View>
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: 'rgba(255,255,255,0.9)', marginTop: 8 }}>
          대출 {loans.length}건
        </Text>
      </LinearGradient>

      {loans.length === 0 ? (
        <EmptyState
          icon="landmark"
          title="등록된 대출이 없어요"
          sub={'우리집 가계부에 등록된 대출이 없어요'}
        />
      ) : (
        loans.map((ln) => {
          const v = viewLoan(ln);
          const pct = Math.round(v.progress * 100);
          const isOpen = expanded === ln.id;
          return (
            <View
              key={ln.id}
              style={{
                marginHorizontal: spacing.lg,
                marginBottom: spacing.md,
                padding: spacing.lg,
                backgroundColor: colors.white,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radii.xxl,
              }}
            >
              <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: radii.lg,
                    backgroundColor: colors.primaryLight,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <AppIcon name="landmark" size={20} color={colors.primaryStrong} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Text
                      numberOfLines={1}
                      style={{ flex: 1, fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 18, color: colors.text, ...noPad }}
                    >
                      {ln.name}
                    </Text>
                    <Text
                      style={{
                        fontFamily: fontFamily.bold,
                        fontSize: 12,
                        color: v.done ? colors.incomeText : colors.primaryStrong,
                        ...tabularNums,
                      }}
                    >
                      {v.done ? '상환완료' : `${pct}%`}
                    </Text>
                  </View>
                  <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 14, color: colors.textMuted, ...noPad }}>
                    {ln.lender ? `${ln.lender} · ` : ''}
                    {describeRepayType(ln.repayType)}
                    {ln.annualRate > 0 ? ` · 연 ${ln.annualRate}%` : ''}
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: spacing.md }}>
                <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>남은 원금</Text>
                <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 18, color: colors.text, ...tabularNums }}>
                  {fmt(v.remaining)}
                </Text>
                <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textFaint, ...tabularNums }}>
                  / {fmt(ln.principal)}원
                </Text>
              </View>

              <ProgressBar percent={pct} size="md" style={{ marginTop: spacing.sm }} />

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.md }}>
                <Chip label="월 상환" value={`${fmt(v.scheduled)}원`} />
                <Chip label="만기" value={formatYearMonth(v.payoff)} />
                <Chip label="매월" value={`${ln.paymentDay}일`} />
                {v.interestPaid > 0 && <Chip label="낸 이자" value={`${fmt(v.interestPaid)}원`} />}
              </View>

              {ln.payments.length > 0 && (
                <View style={{ flexDirection: 'row', gap: 6, marginTop: spacing.md, justifyContent: 'flex-end' }}>
                  <Pressable
                    onPress={() => setExpanded(isOpen ? null : ln.id)}
                    style={{
                      paddingVertical: 10,
                      paddingHorizontal: 14,
                      borderRadius: radii.md,
                      backgroundColor: colors.white,
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  >
                    <Text style={{ fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textSub }}>
                      내역 {ln.payments.length}건 {isOpen ? '▲' : '▼'}
                    </Text>
                  </Pressable>
                </View>
              )}

              {isOpen && (
                <View style={{ marginTop: spacing.md, gap: 6 }}>
                  {ln.payments.map((p) => (
                    <View
                      key={p.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        paddingVertical: 8,
                        paddingHorizontal: 10,
                        backgroundColor: colors.track,
                        borderRadius: radii.sm,
                      }}
                    >
                      <Text style={{ fontFamily: fontFamily.semibold, fontSize: 11, color: colors.textSub, width: 42, ...tabularNums }}>
                        {formatShortDate(p.date)}
                      </Text>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.text, ...tabularNums }}>
                          {fmt(p.amount)}원
                        </Text>
                        <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, color: colors.textMuted, ...tabularNums }}>
                          원금 {fmt(p.principalPart)} · 이자 {fmt(p.interestPart)}
                          {p.memo ? ` · ${p.memo}` : ''}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        })
      )}
    </ModalScreen>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 5,
        paddingHorizontal: 9,
        backgroundColor: colors.track,
        borderRadius: radii.sm,
      }}
    >
      <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, color: colors.textMuted }}>{label}</Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 11, color: colors.text, ...tabularNums }}>{value}</Text>
    </View>
  );
}
