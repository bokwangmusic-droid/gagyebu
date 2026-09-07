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
import { REMOTE_FINANCE_READ_ONLY } from '@/lib/financeMode';
import { fmt } from '@/lib/format';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

export default function ProfileScreen() {
  const router = useRouter();
  const toast = useToast();
  // Account identity (name / email) comes ONLY from the live Supabase
  // session + its public.profiles row — NEVER settings.profileName /
  // settings.profileEmail, which are a single device-global gagyebu.*
  // value shared by every account that signs in on this device
  // (URGENT PROFILE FIX). `Settings.profileName` is left in place as a
  // now-unused legacy field so backups/storage don't break.
  const { session, profile, profileLoading, profileError, updateDisplayName, signOut } = useAuth();
  // LOCAL device data — used ONLY by the "데이터 백업 · 복원" / "모든 데이터
  // 초기화" section below, which reads/writes this device's own gagyebu.*
  // storage and never touches the household's remote data (STEP 16-G1B
  // §6/§14). Named with a `local` prefix here specifically so it's never
  // confused with the `remote` values right below, which is what actually
  // drives the "데이터" section's counts.
  const {
    settings,
    setSettings,
    setSeenOnboarding,
    recurring: localRecurring,
    goals: localGoals,
    loans: localLoans,
    cards: localCards,
    customCats: localCustomCats,
    catOrder: localCatOrder,
    transactions: localTransactions,
    budgets: localBudgets,
    planned: localPlanned,
    notes: localNotes,
    resetAll,
  } = useStore();

  // REMOTE household data — drives every count shown in the "데이터"
  // section, matching what app/(tabs)/index.tsx and the other finance
  // screens actually display (STEP 16-G1B §20: finance figures always come
  // from remote, never local).
  const remote = useFinanceRead();
  const cardBillTotal = cardBillingForMonth(remote.transactions, remote.cards).total;
  const customCount = remote.customCats.expense.length + remote.customCats.income.length;

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Priority: authoritative profiles.display_name -> email local-part ->
  // '사용자'. NEVER settings.profileName — a stale name from another
  // account must not flash here even for a frame.
  const emailLocalPart = (session?.user?.email ?? '').split('@')[0];
  const accountName = profile?.displayName?.trim() || emailLocalPart || '사용자';
  const initial = accountName.charAt(0) || '나';
  const nameHint = profileError
    ? '계정 이름을 불러오지 못했어요'
    : profileLoading && !profile
      ? '계정 이름을 불러오는 중…'
      : null;

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

  // STEP 16-G1B PROFILE FINAL FIX: with household finance now living in
  // Supabase (STEP 16-G1A/G1B), the old copy here ("모든 가계부 데이터는 이
  // 기기 안에만 저장돼요" / "클라우드 동기화는 아직 없어요") is no longer
  // true and would wrongly imply the household's remote data lives only on
  // this device. Rewritten to distinguish "우리집 가계부 데이터" (remote,
  // Supabase) from "개인 설정" (local, this device only) explicitly.
  const showPrivacyInfo = () =>
    Alert.alert(
      '개인정보 · 데이터 보관',
      '• 우리집 가계부 데이터(거래·예산·목표 등)는 Supabase에 안전하게 저장돼요.\n' +
        '• 프로필 이름 같은 개인 설정은 이 기기에만 저장돼요.\n' +
        '• 지금은 우리집 가계부 데이터를 조회만 할 수 있어요.\n' +
        '• 이 기기의 로컬 백업 파일은 직접 저장·공유할 때만 기기 밖으로 나가요.',
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
                transactions: localTransactions,
                budgets: localBudgets,
                goals: localGoals,
                recurring: localRecurring,
                planned: localPlanned,
                loans: localLoans,
                cards: localCards,
                notes: localNotes,
                customCats: localCustomCats,
                catOrder: localCatOrder,
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
            {accountName}
          </Text>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 13, color: colors.textMuted, ...noPad }}>
            {nameHint ?? (session?.user?.email ?? '이메일 미설정')}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            setDraftName(profile?.displayName ?? '');
            setEditingName(true);
          }}
          style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: radii.pill, backgroundColor: colors.primaryLight }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 11, color: colors.primaryStrong }}>편집</Text>
        </Pressable>
      </View>

      <SectionLabel>데이터 · 우리집 가계부</SectionLabel>
      <SettingsCard>
        <Row
          icon="nav-budget"
          iconBg={colors.incomeLight}
          iconColor={colors.incomeText}
          title="예산 관리"
          sub={
            Object.keys(remote.budgets).length > 0
              ? `카테고리별 예산 ${Object.keys(remote.budgets).length}개`
              : '카테고리별 한 달 한도 정하기'
          }
          onPress={() => router.push('/(tabs)/budget')}
        />
        <Row
          icon="refresh"
          iconBg={colors.primaryLight}
          iconColor={colors.primaryStrong}
          title="반복 지출·수입"
          sub={`${remote.recurring.filter((r) => r.active).length}개 활성 · ${
            remote.recurring.length - remote.recurring.filter((r) => r.active).length
          }개 정지`}
          onPress={() => router.push('/recurring')}
        />
        <Row
          icon="target"
          iconBg="#FEE4E6"
          iconColor="#BE185D"
          title="저축 목표"
          sub={`${remote.goals.length}개 진행 중`}
          onPress={() => router.push('/goals')}
        />
        <Row
          icon="landmark"
          iconBg={colors.infoLight}
          iconColor={colors.infoText}
          title="대출 관리"
          sub={
            remote.loans.length > 0
              ? `${remote.loans.length}건 · 남은 원금 ${fmt(
                  remote.loans.reduce((s, l) => s + Math.max(0, l.principal - l.paid), 0),
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
            remote.cards.length > 0
              ? `${remote.cards.length}장 · 사용월 기준 예상 ${fmt(cardBillTotal)}원`
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
        {/* STEP 16-G1B PROFILE FINAL FIX: transaction input itself is
            blocked behind <ReadOnlyRouteNotice/> (app/input.tsx) while
            REMOTE_FINANCE_READ_ONLY is true, so a setting that only
            affects that screen's behaviour must not be changeable either
            — disabled at both the Toggle level (visual + tap no-ops) and
            the onChange callback (setSettings never called), so a future
            change to Toggle's own disabled-handling can't silently reopen
            this. Existing quickPaste logic itself is untouched — STEP
            16-G2 can simply stop passing `disabled` here once transaction
            write is connected. */}
        <Row
          icon="clipboard"
          iconBg={colors.primaryLight}
          iconColor={colors.primaryStrong}
          title="빠른 지출 입력 모드"
          sub={
            REMOTE_FINANCE_READ_ONLY
              ? '거래 입력 연결 후 사용할 수 있어요'
              : '앱 열자마자 붙여넣기 화면이 바로 떠요'
          }
          right={
            <Toggle
              value={settings.quickPaste}
              onChange={(v) => {
                if (REMOTE_FINANCE_READ_ONLY) return;
                setSettings({ quickPaste: v });
              }}
              activeColor={colors.primaryStrong}
              disabled={REMOTE_FINANCE_READ_ONLY}
            />
          }
          last
        />
      </SettingsCard>

      <SectionLabel>우리집</SectionLabel>
      <SettingsCard>
        <Row
          icon="home"
          iconBg={colors.primaryLight}
          iconColor={colors.primaryStrong}
          title="우리집 가계부로 돌아가기"
          sub="연결 상태 · 구성원 · 초대"
          onPress={() => router.push('/household-ready')}
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
          sub={`이 기기의 로컬 데이터만 대상 · ${localTransactions.length}건`}
          onPress={() => router.push('/backup')}
        />
        <Row
          icon="shield"
          iconBg={colors.infoLight}
          iconColor={colors.infoText}
          title="개인정보 · 데이터 보관"
          sub="개인 설정은 이 기기에 저장돼요"
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
          paddingBottom: spacing.xl,
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
          초기화하면 이 기기의 로컬 가계부 데이터만 지워져요. 우리집 가계부 데이터에는 영향을 주지 않아요.{'\n'}
          먼저 「데이터 백업 · 복원」에서 백업해 두는 것을 권장해요.
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

      {/* PROFILE UX FIX: signing out previously lived only on
          household-ready (내정보 → 우리집 가계부로 돌아가기 → 로그아웃). This
          is a plain red text link at the very bottom of 내정보 —
          deliberately NOT the pill + border + warn-icon treatment the
          destructive "모든 데이터 초기화" above uses — so it reads as "end
          session", never "delete data". A hairline separator and its own
          footer block keep the two visually distinct. Reuses
          useAuth().signOut(); AuthGate (app/_layout.tsx) redirects to
          sign-in once the session clears. household-ready's own 로그아웃 is
          left untouched. */}
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: colors.border,
          marginHorizontal: spacing.lg,
          paddingTop: spacing.lg,
          paddingBottom: 40,
          alignItems: 'center',
        }}
      >
        <Pressable
          onPress={() => void signOut()}
          hitSlop={8}
          accessibilityRole="button"
          style={{ paddingVertical: 8, paddingHorizontal: 16 }}
        >
          <Text
            style={{
              fontFamily: fontFamily.semibold,
              fontSize: 13,
              color: colors.expenseText,
              ...noPad,
            }}
          >
            로그아웃
          </Text>
        </Pressable>
      </View>

      {editingName && (
        <BottomSheet
          visible
          onClose={() => {
            if (!savingName) setEditingName(false);
          }}
          title="이름 변경"
        >
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
            label={savingName ? '저장 중…' : '저장'}
            disabled={savingName || draftName.trim().length === 0}
            onPress={() => {
              const n = draftName.trim();
              if (!n || savingName) return;
              setSavingName(true);
              void (async () => {
                // Writes public.profiles.display_name for the LIVE account
                // only; identity re-checked inside updateDisplayName. No
                // local settings write, no optimistic UI.
                const res = await updateDisplayName(n);
                setSavingName(false);
                if (res.ok) {
                  setEditingName(false);
                  toast.show('이름을 변경했어요');
                } else {
                  toast.show(res.message); // keep the sheet open, remote name unchanged
                }
              })();
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
