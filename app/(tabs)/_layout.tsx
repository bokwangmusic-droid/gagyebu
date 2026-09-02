import { Tabs } from 'expo-router';
import { View } from 'react-native';

import { BottomTabBar } from '@/components/BottomTabBar';
import { colors } from '@/theme/tokens';

export default function TabsLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
        tabBar={(props) => <BottomTabBar {...props} />}
      >
        <Tabs.Screen name="index" options={{ title: '홈' }} />
        <Tabs.Screen name="stats" options={{ title: '통계' }} />
        {/* 예산 is not a bottom tab — reached from Home and 내정보 */}
        <Tabs.Screen name="budget" options={{ title: '예산' }} />
        <Tabs.Screen name="planned" options={{ title: '예정' }} />
        <Tabs.Screen name="profile" options={{ title: '내정보' }} />
      </Tabs>
    </View>
  );
}
