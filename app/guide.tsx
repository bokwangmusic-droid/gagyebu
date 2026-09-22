import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

/**
 * "사용법 다시 보기" 전용 화면 — app/(tabs)/profile.tsx의 reviewOnboarding()이
 * 실제로는 app/onboarding.tsx(첫 실행 마케팅 스플래시)로 보내고 있었는데, 그
 * 화면의 두 버튼(건너뛰기/시작하기)이 모두 setSeenOnboarding(true) 후
 * router.replace('/')를 호출해 즉시 홈으로 튕겨 나가는 게 원래 의도된 동작
 * (앱 첫 실행 게이트)이다. seenOnboarding은 app/_layout.tsx AuthGate의
 * 라우팅 게이트 상태라 재사용하면 안 되므로, 상태를 전혀 건드리지 않는 이
 * 화면을 새로 둔다. 내용은 현재 실제로 구현된 기능만 요약 — 실기기 화면
 * 목록(app/(tabs)/*.tsx, app/(tabs)/profile.tsx의 Row 목록)을 그대로 따른다.
 */
const SECTIONS: { icon: string; title: string; desc: string }[] = [
  {
    icon: 'plus-circle',
    title: '거래 입력',
    desc: '하단 가운데 + 버튼을 눌러 지출/수입을 선택하고, 금액·카테고리·결제수단을 입력한 뒤 저장해요.',
  },
  {
    icon: 'nav-home',
    title: '홈',
    desc: '이번 달 지출, 최근 거래, 인사이트, 카테고리별 지출을 한 화면에서 볼 수 있어요.',
  },
  {
    icon: 'nav-chart',
    title: '통계',
    desc: '주간·월간·연간 단위로 카테고리별 비율과 지출 추이를 확인할 수 있어요.',
  },
  {
    icon: 'nav-calendar',
    title: '예정 · 반복',
    desc: '예정된 지출과 메모는 하단 "예정" 탭에서, 반복 지출·수입은 내정보에서 관리해요.',
  },
  {
    icon: 'cloud',
    title: '우리집 가계부',
    desc: '함께 쓰는 사람을 초대하면 같은 가계부를 함께 기록하고 확인할 수 있어요.',
  },
  {
    icon: 'nav-user',
    title: '내정보',
    desc: '예산, 저축 목표, 자산, 대출, 카드, 카테고리 등을 여기서 관리해요.',
  },
];

export default function Guide() {
  const router = useRouter();

  return (
    <ModalScreen title="돈돈 사용법" onClose={() => router.back()}>
      <Text
        style={{
          fontFamily: fontFamily.regular,
          fontSize: 13,
          lineHeight: 19,
          color: colors.textSub,
          marginHorizontal: spacing.lg,
          marginBottom: spacing.lg,
        }}
      >
        {'처음 사용하셔도 어렵지 않아요.\n자주 쓰는 기능만 빠르게 알려드릴게요.'}
      </Text>

      <View
        style={{
          backgroundColor: colors.white,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radii.xxl,
          paddingHorizontal: spacing.lg,
        }}
      >
        {SECTIONS.map((s, i) => (
          <View
            key={s.title}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 11,
              paddingVertical: 12,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: colors.track,
            }}
          >
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                backgroundColor: colors.primaryLight,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <AppIcon name={s.icon} size={16} color={colors.primaryStrong} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text
                style={{
                  fontFamily: fontFamily.bold,
                  fontSize: 14,
                  lineHeight: 17,
                  color: colors.text,
                  ...noPad,
                }}
              >
                {s.title}
              </Text>
              <Text
                style={{
                  fontFamily: fontFamily.regular,
                  fontSize: 12,
                  lineHeight: 17,
                  color: colors.textSub,
                  ...noPad,
                }}
              >
                {s.desc}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </ModalScreen>
  );
}
