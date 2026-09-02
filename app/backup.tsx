import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import { SegmentedTabs } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { SCHEMA_VERSION } from '@/lib/migrations';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function Backup() {
  const router = useRouter();
  const toast = useToast();
  const { transactions, budgets, goals, recurring, planned, loans, cards, notes, settings, importData } =
    useStore();

  const [mode, setMode] = useState<'export' | 'import'>('export');
  const [importText, setImportText] = useState('');
  const [copied, setCopied] = useState(false);

  const payload = useMemo(
    () =>
      JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          transactions,
          budgets,
          goals,
          recurring,
          planned,
          loans,
          cards,
          notes,
          settings,
          exportedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    [transactions, budgets, goals, recurring, planned, loans, cards, notes, settings],
  );

  const copy = async () => {
    await Clipboard.setStringAsync(payload);
    setCopied(true);
    toast.show('클립보드에 복사했어요');
    setTimeout(() => setCopied(false), 2000);
  };

  const doImport = () => {
    if (!importText.trim()) {
      toast.show('붙여넣은 내용이 없어요');
      return;
    }
    const ok = importData(importText);
    toast.show(ok ? '데이터를 불러왔어요' : '올바른 백업 데이터가 아니에요');
    if (ok) router.back();
  };

  return (
    <ModalScreen title="데이터 백업 · 복원" closeIcon="x" onClose={() => router.back()} scroll={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, paddingHorizontal: spacing.xl }}
      >
        <SegmentedTabs
          value={mode}
          onChange={setMode}
          options={[
            { value: 'export', label: '내보내기' },
            { value: 'import', label: '불러오기' },
          ]}
          style={{ marginBottom: spacing.lg }}
        />

        {mode === 'export' ? (
          <>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub, lineHeight: 19, marginBottom: spacing.md }}>
              아래 데이터를 메모장·카톡·이메일 등에 저장해두시면 폰 바꿀 때나 문제 생겼을 때 「불러오기」로 복원할 수 있어요.
            </Text>
            <View
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radii.md,
                backgroundColor: colors.white,
                padding: 12,
                marginBottom: spacing.md,
              }}
            >
              <TextInput
                value={payload}
                editable={false}
                multiline
                scrollEnabled
                style={{
                  flex: 1,
                  fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  fontSize: 11,
                  color: colors.text,
                  textAlignVertical: 'top',
                }}
              />
            </View>
            <GradientButton
              label={copied ? '✓ 복사됨' : '전체 복사'}
              onPress={copy}
              style={{ marginBottom: spacing.xxl }}
            />
          </>
        ) : (
          <>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub, lineHeight: 19, marginBottom: spacing.md }}>
              이전에 저장해둔 백업 데이터(JSON)를 붙여넣고 「불러오기」를 누르면 현재 데이터를 모두 덮어써요.
            </Text>
            <TextInput
              value={importText}
              onChangeText={setImportText}
              multiline
              placeholder={'{"transactions":[...],"budgets":{...}, ...}'}
              placeholderTextColor={colors.textMuted}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radii.md,
                backgroundColor: colors.white,
                padding: 12,
                fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                fontSize: 11,
                color: colors.text,
                textAlignVertical: 'top',
                marginBottom: spacing.md,
              }}
            />
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.xxl }}>
              <Pressable
                onPress={() => router.back()}
                style={{
                  flex: 1,
                  height: 48,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: colors.white,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: radii.lg,
                }}
              >
                <Text style={{ fontFamily: fontFamily.semibold, fontSize: 14, color: colors.textSub }}>취소</Text>
              </Pressable>
              <GradientButton label="불러오기" onPress={doImport} disabled={!importText.trim()} style={{ flex: 2 }} />
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </ModalScreen>
  );
}
