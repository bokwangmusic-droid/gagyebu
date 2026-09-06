import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { SegmentedTabs } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import {
  backupFileName,
  buildBackupFile,
  createBackup,
  listBackups,
  parseBackupFile,
  parseTextImport,
  performDataRestore,
  performRestore,
  type BackupData,
  type BackupMeta,
  type BackupReason,
} from '@/lib/backup';
import { formatRelativeDateTime } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

type Mode = 'snapshots' | 'export' | 'import';

const REASON_LABEL: Record<BackupReason, string> = {
  auto: '자동 백업',
  manual: '수동 백업',
  before_restore: '복원 전 백업',
  before_reset: '초기화 전 백업',
  before_import: '가져오기 전 백업',
};

/** Best-effort sweep of any temp export files left in the cache dir. */
async function cleanupExportFiles() {
  try {
    const dir = FileSystem.cacheDirectory;
    if (!dir) return;
    const names = await FileSystem.readDirectoryAsync(dir);
    await Promise.all(
      names
        .filter((n) => n.startsWith('gagyebu-backup-') && n.endsWith('.json'))
        .map((n) => FileSystem.deleteAsync(dir + n, { idempotent: true }).catch(() => {})),
    );
  } catch {
    /* noop */
  }
}

export default function Backup() {
  const router = useRouter();
  const toast = useToast();
  const {
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
    importData,
  } = useStore();

  const [mode, setMode] = useState<Mode>('snapshots');
  const [importText, setImportText] = useState('');
  const [copied, setCopied] = useState(false);
  const [pickedFileName, setPickedFileName] = useState<string | null>(null);

  const [snapshots, setSnapshots] = useState<BackupMeta[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshSnapshots = useCallback(async () => {
    setSnapshots(await listBackups());
  }, []);
  useEffect(() => {
    void refreshSnapshots();
  }, [refreshSnapshots]);

  const currentData = useMemo<BackupData>(
    () => ({
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
    }),
    [transactions, budgets, goals, recurring, planned, loans, cards, notes, customCats, catOrder, settings],
  );

  // The text box and the exported file share one format (§9 — text export is
  // now a complete 11-slice backup too).
  const payload = useMemo(
    () => JSON.stringify(buildBackupFile(currentData), null, 2),
    [currentData],
  );

  const copy = async () => {
    await Clipboard.setStringAsync(payload);
    setCopied(true);
    toast.show('클립보드에 복사했어요');
    setTimeout(() => setCopied(false), 2000);
  };

  /** Apply an already-validated dataset through STEP 8-A's safe restore path. */
  const runDataRestore = (
    data: BackupData,
    schemaVersion: number,
    successMsg: string,
  ) => {
    setBusy(true);
    void performDataRestore(data, schemaVersion, currentData, importData)
      .then(async (res) => {
        await refreshSnapshots(); // a before_restore snapshot was made either way
        if (res.ok) {
          toast.show(successMsg);
          router.back();
        } else {
          toast.show(res.reason);
        }
      })
      .finally(() => setBusy(false));
  };

  const doImport = () => {
    if (busy) return;
    if (!importText.trim()) {
      toast.show('붙여넣은 내용이 없어요');
      return;
    }
    const check = parseTextImport(importText, currentData);
    if (!check.ok) {
      toast.show(check.reason);
      return;
    }
    runDataRestore(check.data, check.schemaVersion, '데이터를 불러왔어요');
  };

  const doExportFile = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        toast.show('이 기기에서는 파일 공유를 지원하지 않아요');
        return;
      }
      const dir = FileSystem.cacheDirectory;
      if (!dir) {
        toast.show('임시 저장 공간을 열 수 없어요');
        return;
      }
      await cleanupExportFiles();
      const uri = dir + backupFileName();
      await FileSystem.writeAsStringAsync(uri, JSON.stringify(buildBackupFile(currentData)));
      await Sharing.shareAsync(uri, {
        mimeType: 'application/json',
        UTI: 'public.json',
        dialogTitle: '가계부 백업 파일 저장',
      });
      // The temp file is left for the OS / the next export's sweep to clear —
      // deleting it now can race the receiving app on Android.
    } catch {
      toast.show('백업 파일을 만들지 못했어요');
    } finally {
      setBusy(false);
    }
  };

  const doPickFile = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        // Galaxy file providers tag .json inconsistently; accept the common
        // reports and let parseBackupFile() reject anything that isn't ours.
        type: ['application/json', 'application/octet-stream', 'text/plain'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled) return;
      const asset = res.assets[0];
      setPickedFileName(asset.name);

      const text = await FileSystem.readAsStringAsync(asset.uri);
      const check = parseBackupFile(text);
      if (!check.ok) {
        toast.show(check.reason);
        return;
      }
      const when = check.file.exportedAt
        ? formatRelativeDateTime(check.file.exportedAt)
        : asset.name;
      Alert.alert(
        '이 백업 파일로 복원할까요?',
        `${when} · 거래 ${check.file.data.transactions.length}건\n\n지금 데이터는 복원 전에 자동으로 백업돼요.`,
        [
          { text: '취소', style: 'cancel' },
          {
            text: '복원',
            style: 'destructive',
            onPress: () =>
              runDataRestore(check.file.data, check.file.schemaVersion, '백업 파일을 복원했어요'),
          },
        ],
      );
    } catch {
      toast.show('백업 파일을 읽지 못했어요');
    } finally {
      setBusy(false);
    }
  };

  const doManualBackup = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const meta = await createBackup('manual', currentData);
      if (meta) {
        toast.show('이 기기에 백업했어요');
        await refreshSnapshots();
      } else {
        toast.show('백업에 실패했어요 (저장 공간을 확인해 주세요)');
      }
    } finally {
      setBusy(false);
    }
  };

  const doRestore = (m: BackupMeta) => {
    Alert.alert(
      '이 백업으로 되돌릴까요?',
      `${formatRelativeDateTime(m.createdAt)} · ${REASON_LABEL[m.reason]} · 거래 ${m.txnCount}건\n\n지금 데이터는 되돌리기 전에 자동으로 백업돼요.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '되돌리기',
          style: 'destructive',
          onPress: () => {
            if (busy) return;
            setBusy(true);
            void performRestore(m.id, currentData, importData)
              .then(async (res) => {
                // A `before_restore` snapshot was created either way — keep the
                // list current so it stays visible after a failed restore too.
                await refreshSnapshots();
                if (res.ok) {
                  toast.show('백업을 복원했어요');
                  router.back();
                } else {
                  toast.show(res.reason);
                }
              })
              .finally(() => setBusy(false));
          },
        },
      ],
    );
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
            { value: 'snapshots', label: '백업' },
            { value: 'export', label: '내보내기' },
            { value: 'import', label: '불러오기' },
          ]}
          style={{ marginBottom: spacing.lg }}
        />

        {mode === 'snapshots' ? (
          <View style={{ flex: 1 }}>
            <Text style={styles.hint}>
              앱을 쓰는 동안 하루에 한 번 자동으로, 그리고 아래 버튼으로 직접 이 기기에 백업돼요. 최근 백업만 보관돼요.
            </Text>
            <GradientButton
              label={busy ? '처리 중…' : '지금 백업하기'}
              onPress={doManualBackup}
              disabled={busy}
              style={{ marginBottom: spacing.lg }}
            />
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: spacing.xxl }}
              showsVerticalScrollIndicator={false}
            >
              {snapshots.length === 0 ? (
                <Text style={styles.empty}>
                  아직 백업이 없어요.{'\n'}「지금 백업하기」를 눌러 첫 백업을 만들어 보세요.
                </Text>
              ) : (
                snapshots.map((m) => (
                  <Pressable key={m.id} onPress={() => doRestore(m)} style={styles.row}>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text style={styles.rowTitle}>{formatRelativeDateTime(m.createdAt)}</Text>
                      <Text style={styles.rowSub}>
                        {REASON_LABEL[m.reason]} · 거래 {m.txnCount}건
                      </Text>
                    </View>
                    <AppIcon name="chev-right" size={18} color={colors.textFaint} />
                  </Pressable>
                ))
              )}
            </ScrollView>
          </View>
        ) : mode === 'export' ? (
          <>
            <Text style={styles.hint}>
              백업 파일(.json)로 저장하면 파일 앱·드라이브·메신저 등으로 보내 다른 기기나 재설치 후 「불러오기」로 복원할 수 있어요. 아래 텍스트를 그대로 복사해 두어도 돼요.
            </Text>
            <GradientButton
              label={busy ? '처리 중…' : '백업 파일로 저장하기'}
              onPress={doExportFile}
              disabled={busy}
              style={{ marginBottom: spacing.md }}
            />
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
              disabled={busy}
              style={{ marginBottom: spacing.xxl }}
            />
          </>
        ) : (
          <>
            <Text style={styles.hint}>
              백업 파일을 선택하거나, 이전에 복사해둔 백업 데이터(JSON)를 붙여넣고 불러오면 현재 데이터를 모두 덮어써요. 덮어쓰기 전에 지금 데이터가 자동으로 백업돼요.
            </Text>
            <GradientButton
              label={busy ? '처리 중…' : '백업 파일 선택하기'}
              onPress={doPickFile}
              disabled={busy}
              style={{ marginBottom: pickedFileName ? spacing.sm : spacing.md }}
            />
            {pickedFileName ? (
              <Text style={styles.fileName} numberOfLines={1}>
                선택한 파일: {pickedFileName}
              </Text>
            ) : null}
            <TextInput
              value={importText}
              onChangeText={setImportText}
              multiline
              placeholder={'{"app":"gagyebu","exportVersion":1, ...}'}
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
              <GradientButton
                label="붙여넣기 불러오기"
                onPress={doImport}
                disabled={!importText.trim() || busy}
                style={{ flex: 2 }}
              />
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </ModalScreen>
  );
}

const styles = {
  hint: {
    fontFamily: fontFamily.regular,
    fontSize: 12,
    color: colors.textSub,
    lineHeight: 19,
    marginBottom: spacing.md,
  },
  empty: {
    fontFamily: fontFamily.regular,
    fontSize: 12,
    lineHeight: 19,
    color: colors.textMuted,
    textAlign: 'center' as const,
    marginTop: spacing.xl,
  },
  fileName: {
    fontFamily: fontFamily.regular,
    fontSize: 11,
    color: colors.textSub,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: spacing.sm,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
  },
  rowTitle: {
    fontFamily: fontFamily.semibold,
    fontSize: 14,
    color: colors.text,
  },
  rowSub: {
    fontFamily: fontFamily.regular,
    fontSize: 11,
    color: colors.textMuted,
  },
};
