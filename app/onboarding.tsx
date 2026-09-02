import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient as SvgGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';

import { GradientButton } from '@/components/ui/GradientButton';
import { useStore } from '@/store/store';
import { colors, radii } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function Onboarding() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { setSeenOnboarding } = useStore();

  const done = () => {
    setSeenOnboarding(true);
    router.replace('/');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Pressable
        onPress={done}
        style={{ position: 'absolute', top: insets.top + 8, right: 20, padding: 8, zIndex: 2 }}
      >
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 13, color: colors.textSub }}>
          건너뛰기
        </Text>
      </Pressable>

      {/* Hero */}
      <View style={{ height: '45%', minHeight: 320, alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            position: 'absolute',
            top: 30,
            left: 40,
            width: 120,
            height: 120,
            borderRadius: radii.pill,
            backgroundColor: '#FEE4E6',
            opacity: 0.6,
          }}
        />
        <View
          style={{
            position: 'absolute',
            bottom: 30,
            right: 30,
            width: 90,
            height: 90,
            borderRadius: radii.pill,
            backgroundColor: '#D1FAE5',
            opacity: 0.7,
          }}
        />
        <Svg width={220} height={220} viewBox="0 0 220 220">
          <Defs>
            <SvgGradient id="ob" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#C4B5FD" />
              <Stop offset="1" stopColor="#A78BFA" />
            </SvgGradient>
          </Defs>
          <Rect
            x={30}
            y={20}
            width={160}
            height={100}
            rx={20}
            fill="#FFFFFF"
            stroke="#F0E9DA"
            transform="rotate(-8 110 70)"
          />
          <Rect x={20} y={60} width={180} height={112} rx={22} fill="url(#ob)" transform="rotate(5 110 116)" />
          <SvgText x={50} y={98} fontSize={11} fill="#FFFFFF" opacity={0.85}>
            이번 주 지출
          </SvgText>
          <SvgText x={50} y={126} fontSize={28} fontWeight="800" fill="#FFFFFF">
            254,600원
          </SvgText>
        </Svg>
      </View>

      {/* Copy */}
      <View style={{ paddingHorizontal: 32, paddingTop: 32, alignItems: 'center' }}>
        <Text
          style={{
            fontFamily: fontFamily.extrabold,
            fontSize: 28,
            letterSpacing: -0.8,
            lineHeight: 35,
            color: colors.text,
            textAlign: 'center',
          }}
        >
          가계부,{'\n'}
          <Text style={{ color: colors.primaryStrong }}>가볍고 예쁘게.</Text>
        </Text>
        <Text
          style={{
            fontFamily: fontFamily.regular,
            fontSize: 14,
            color: colors.textSub,
            marginTop: 16,
            lineHeight: 22,
            textAlign: 'center',
          }}
        >
          광고 없이, 부담 없이.{'\n'}3초 안에 지출을 기록하고{'\n'}한 달을 한눈에 볼 수 있어요.
        </Text>
      </View>

      <View
        style={{
          position: 'absolute',
          left: 20,
          right: 20,
          bottom: Math.max(insets.bottom, 20) + 20,
        }}
      >
        <GradientButton label="시작하기" onPress={done} />
      </View>
    </View>
  );
}
