import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Field, Toggle, TextField } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { Screen } from '@/components/ui/Screen';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { useToast } from '@/components/ui/Toast';
import { EXPENSE_CATS, INCOME_CATS } from '@/data/categories';
import { createBackup } from '@/lib/backup';
import { cardBillingForMonth } from '@/lib/card';
import { fmt } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

export default function ProfileScreen() {
  const router = useRouter();
  const toast = useToast();
  const {
    settings,
    setSettings,
    setSeenOnboarding,
    recurring,
    goals,
    loans,
    cards,
    customCats,
    catOrder,
    transactions,
    budgets,
    planned,
    notes,
    resetAll,
  } = useStore();
  const cardBillTotal = cardBillingForMonth(transactions, cards).total;
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');

  const initial = (settings.profileName || '나').charAt(0);
  const customCount = customCats.expense.length + customCats.income.length;

  // App metadata straight from the Expo config (app.json) — never hard-coded,
  // so it can't drift from the real release. `nativeBuildVersion` is only set
  // in a real native build; it's absent in Expo Go.
  const appName = Constants.expoConfig?.name ?? '가계부';
  const appVersion = Constants.expoConfig?.version ?? '1.0.0';
  const buildVersion =
    typeof Constants.nativeBuildVersion === 'string' && Constants.nativeBuildVersion
      ? Constants.nativeBuildVersion
      : null;
  const appInfoSub = `버전 ${appVersion}${buildVersion ? ` (빌드 ${buildVersion})` : ''}`;

  const showAppInfo = () =>
    Alert.alert(
      appName,
      `버전 ${appVersion}${buildVersion ? `\n빌드 ${buildVersion}` : ''}\n\n` +
        '뱅크샐러드의 시각화 + 편한가계부의 3초 입력을 합쳤어요.\n' +
        '광고 없고, 데이터는 이 기기에만 저장돼요.',
    );

  const showPrivacyInfo = () =>
    Alert.alert(
      '개인정보 · 데이터 보관',
      '• 모든 가계부 데이터는 이 기기 안에만 저장돼요.\n' +
        '• 서버 전송이나 클라우드 동기화는 아직 없어요.\n' +
        '• 앱을 삭제하거나 기기를 바꾸면 데이터가 사라져요.\n' +
        '• 「데이터 백업 · 복원」에서 백업 파일을 저장해 두면 다른 기기에서 복원할 수 있어요.\n' +
        '• 백업 파일은 직접 저장·공유할 때만 기기 밖으로 나가요.',
    );

  const reviewOnboarding = () => {
    // Re-arm the onboarding gate, then jump to it. Finishing / skipping there
    // flips `seenOnboarding` back on and returns home (app/onboarding.tsx).
    setSeenOnboarding(false);
    router.replace('/onboarding');
  };

  const confirmReset = () =>
    Alert.alert(
      '모든 데이터를 삭제할까요?',
      '지출·수입·예산·목표·반복·대출·카드·메모·커스텀 카테고리·설정이 모두 지워져요.\n\n' +
        '초기화 직전에 자동 백업이 만들어지지만, 안전을 위해 먼저 「데이터 백업 · 복원」에서 백업해 두세요.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '전부 삭제',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              // Snapshot the whole dataset first; only wipe if it was durably
              // saved. Reuses src/lib/backup.ts (createBackup returns null when
              // the body write / read-back verify fails).
              const safety = await createBackup('before_reset', {
                transactions,
                budgets,
                goals,
                recurring,
                planned,
                loans,
                cards,
                notes,
                customCats,
                catOrder,
                settings,
              });
              if (!safety) {
                toast.show('안전 백업을 만들지 못해 초기화를 취소했어요');
                return;
              }
              resetAll();
              toast.show('모든 데이터를 초기화했어요');
            })();
          },
        },
      ],
    );

  return (
    <Screen>
      <ScreenHeader title="내정보" />

      {/* Profile card */}
      <View
        style={{
          marginHorizontal: spacing.lg,
          marginTop: spacing.sm,
          marginBottom: spacing.md,
          padding: 14,
          backgroundColor: colors.white,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radii.xxl,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: radii.pill,
            backgroundColor: colors.primary,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 18, color: colors.white, ...noPad }}>{initial}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 18, color: colors.text, ...noPad }}>
            {settings.profileName || '나'}
          </Text>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 13, color: colors.textMuted, ...noPad }}>
            {settings.profileEmail || '이메일 미설정'}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            setDraftName(settings.profileName || '');
            setEditingName(true);
          }}
          style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: radii.pill, backgroundColor: colors.primaryLight }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 11, color: colors.primaryStrong }}>편집</Text>
        </Pressable>
      </View>

      <SectionLabel>데이터</SectionLabel>
      <SettingsCard>
        <Row
          icon="nav-budget"
          iconBg={colors.incomeLight}
          iconColor={colors.incomeText}
          title="예산 관리"
          sub={
            Object.keys(budgets).length > 0
              ? `카테고리별 예산 ${Object.keys(budgets).length}개`
              : '카테고리별 한 달 한도 정하기'
          }
          onPress={() => router.push('/(tabs)/budget')}
        />
        <Row
          icon="refresh"
          iconBg={colors.primaryLight}
          iconColor={colors.primaryStrong}
          title="반복 지출·수입"
          sub={`${recurring.filter((r) => r.active).length}개 활성 · ${
            recurring.length - recurring.filter((r) => r.active).length
          }개 정지`}
          onPress={() => router.push('/recurring')}
        />
        <Row
          icon="target"
          iconBg="#FEE4E6"
          iconColor="#BE185D"
          title="저축 목표"
          sub={`${goals.length}개 진행 중`}
          onPress={() => router.push('/goals')}
        />
        <Row
          icon="landmark"
          iconBg={colors.infoLight}
          iconColor={colors.infoText}
          title="대출 관리"
          sub={
            loans.length > 0
              ? `${loans.length}건 · 남은 원금 ${fmt(
                  loans.reduce((s, l) => s + Math.max(0, l.principal - l.paid), 0),
                )}원`
              : '원금·이자·상환일 한눈에 관리'
          }
          onPress={() => router.push('/loans')}
        />
        <Row
          icon="card"
          iconBg={colors.primaryLight}
          iconColor={colors.primaryStrong}
          title="카드 관리"
          sub={
            cards.length > 0
              ? `${cards.length}장 · 사용월 기준 예상 ${fmt(cardBillTotal)}원`
              : '카드 등록 · 일시불/할부 · 예상 카드값'
          }
          onPress={() => router.push('/cards')}
        />
        <Row
          icon="sparkle"
          iconBg={colors.warningLight}
          iconColor={colors.warningText}
          title="카테고리 관리"
          sub={`기본 ${EXPENSE_CATS.length + INCOME_CATS.length}개${customCount > 0 ? ` · 사용자 추가 ${customCount}개` : ''}`}
          onPress={() => router.push('/categories')}
          last
        />
      </SettingsCard>

      <SectionLabel>빠른 입력</SectionLabel>
      <SettingsCard>
        <Row
          icon="clipboard"
          iconBg={colors.primaryLight}
          iconColor={colors.primaryStrong}
          title="빠른 지출 입력 모드"
          sub="앱 열자마자 붙여넣기 화면이 바로 떠요"
          right={
            <Toggle
              value={settings.quickPaste}
              onChange={(v) => setSettings({ quickPaste: v })}
              activeColor={colors.primaryStrong}
            />
          }
          last
        />
      </SettingsCard>

      <SectionLabel>개인정보 &amp; 앱</SectionLabel>
      <SettingsCard>
        <Row
          icon="download"
          iconBg={colors.incomeLight}
          iconColor={colors.incomeText}
          title="데이터 백업 · 복원"
          sub={`전체 데이터 텍스트로 복사 · ${transactions.length}건`}
          onPress={() => router.push('/backup')}
        />
        <Row
          icon="shield"
          iconBg={colors.infoLight}
          iconColor={colors.infoText}
          title="개인정보 · 데이터 보관"
          sub="데이터는 이 기기에만 저장돼요"
          onPress={showPrivacyInfo}
        />
        <Row
          icon="help"
          iconBg={colors.primaryLight}
          iconColor={colors.primaryStrong}
          title="사용법 다시 보기"
          sub="시작 화면 안내를 다시 봐요"
          onPress={reviewOnboarding}
        />
        <Row
          icon="info"
          iconBg={colors.neutralLight}
          iconColor={colors.neutralText}
          title="앱 정보"
          sub={appInfoSub}
          onPress={showAppInfo}
          last
        />
      </SettingsCard>

      <View
        style={{
          paddingTop: spacing.lg,
          paddingHorizontal: spacing.xl,
          paddingBottom: 40,
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Text
          style={{
            fontFamily: fontFamily.regular,
            fontSize: 11,
            lineHeight: 16,
            color: colors.textMuted,
            textAlign: 'center',
            ...noPad,
          }}
        >
          초기화하면 이 기기의 모든 가계부 데이터가 지워져요.{'\n'}먼저 「데이터 백업 · 복원」에서 백업해 두는 것을 권장해요.
        </Text>
        <Pressable
          onPress={confirmReset}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 9,
            paddingHorizontal: 18,
            borderRadius: radii.pill,
            backgroundColor: colors.expenseLight,
            borderWidth: 1,
            borderColor: colors.expense,
          }}
        >
          <AppIcon name="warn" size={14} color={colors.expenseText} />
          <Text style={{ fontFamily: fontFamily.semibold, fontSize: 13, color: colors.expenseText }}>
            모든 데이터 초기화
          </Text>
        </Pressable>
      </View>

      {editingName && (
        <BottomSheet visible onClose={() => setEditingName(false)} title="이름 변경">
          <Field label="이름">
            <TextField
              value={draftName}
              onChangeText={setDraftName}
              placeholder="예: 에드가"
              maxLength={20}
              autoFocus
            />
          </Field>
          <GradientButton
            label="저장"
            onPress={() => {
              const n = draftName.trim();
              if (n) setSettings({ profileName: n });
              setEditingName(false);
            }}
          />
        </BottomSheet>
      )}
    </Screen>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        fontFamily: fontFamily.bold,
        fontSize: 11,
        letterSpacing: 0.2,
        color: colors.textMuted,
        marginHorizontal: spacing.xl,
        marginTop: spacing.xs,
        marginBottom: 6,
        ...noPad,
      }}
    >
      {children}
    </Text>
  );
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        marginHorizontal: spacing.lg,
        marginBottom: spacing.md,
        paddingHorizontal: spacing.lg,
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.xxl,
      }}
    >
      {children}
    </View>
  );
}

function Row({
  icon,
  iconBg,
  iconColor,
  title,
  sub,
  onPress,
  right,
  last,
}: {
  icon: string;
  iconBg: string;
  iconColor: string;
  title: string;
  sub: string;
  onPress?: () => void;
  right?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        paddingVertical: 10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.track,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 9,
          backgroundColor: iconBg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <AppIcon name={icon} size={16} color={iconColor} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 14, lineHeight: 17, color: colors.text, ...noPad }}>
          {title}
        </Text>
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 13, color: colors.textMuted, ...noPad }}>
          {sub}
        </Text>
      </View>
      {right ?? (onPress ? <AppIcon name="chev-right" size={18} color={colors.textFaint} /> : null)}
    </Pressable>
  );
}
