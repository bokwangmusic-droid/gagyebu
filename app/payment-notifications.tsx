/**
 * "결제 알림 자동입력 (준비 중)" — STEP 1–2 dev / QA screen for the Android
 * notification-listener skeleton.
 *
 * What it does: shows the notification-access state, sends the user to the
 * system setting (after an in-app notice), edits the package allowlist and
 * lists what the listener captured on THIS device — each item with a test
 * preview of the parsed payment candidate (src/lib/paymentNotification/).
 *
 * What it deliberately does not do yet: create or save a transaction, link a
 * card, pick a category, or send anything to the server.
 * This file is wiring only — the native calls live in
 * src/services/paymentNotificationListener.ts.
 */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AppState, Pressable, Text, View } from 'react-native';

import { Field, TextField } from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { DEFAULT_PAYMENT_NOTIFICATION_PACKAGES } from '@/data/paymentNotificationPackages';
import { fmt } from '@/lib/format';
import type { ParsedPaymentCandidate } from '@/lib/paymentNotification/parserTypes';
import { parsePaymentNotification } from '@/lib/paymentNotification/registry';
import { withPaymentRelations } from '@/lib/paymentNotification/relation';
import {
  CAPTURED_MAX_ENTRIES,
  normalizeAllowedPackages,
  type CapturedNotification,
} from '@/lib/paymentNotificationBuffer';
import {
  clearCapturedNotifications,
  getAllowedPackages,
  getCapturedNotifications,
  isNotificationAccessGranted,
  isPaymentNotificationSupported,
  openNotificationAccessSettings,
  setAllowedPackages,
} from '@/services/paymentNotificationListener';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

const DISCLOSURE =
  '돈돈은 사용자가 허용한 금융 앱의 결제 알림을 읽어 가계부 입력을 돕기 위해 사용합니다.\n\n' +
  '현재 테스트 단계에서는 알림 내용이 서버로 전송되지 않고 이 기기에만 임시 저장됩니다.';

const pad2 = (n: number) => String(n).padStart(2, '0');
const formatPostedAt = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export default function PaymentNotifications() {
  const router = useRouter();
  const toast = useToast();
  const supported = isPaymentNotificationSupported();

  const [granted, setGranted] = useState(false);
  const [packages, setPackages] = useState<string[]>([]);
  const [captured, setCaptured] = useState<CapturedNotification[]>([]);
  const [packageDraft, setPackageDraft] = useState('');
  const [listOpen, setListOpen] = useState(false);

  // Aligned with `captured`. Display only — nothing is saved or merged.
  const candidates = useMemo(() => withPaymentRelations(captured.map(parsePaymentNotification)), [captured]);

  const reload = useCallback(async () => {
    if (!supported) return;
    const [access, list] = await Promise.all([isNotificationAccessGranted(), getCapturedNotifications()]);
    setGranted(access);
    setCaptured(list);
  }, [supported]);

  // The allowlist lives on the native side (the service reads it while the
  // app is closed). Built-in defaults are merged in once per visit.
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void (async () => {
      const stored = await getAllowedPackages();
      const merged = normalizeAllowedPackages([...DEFAULT_PAYMENT_NOTIFICATION_PACKAGES, ...stored]);
      const next = merged.length === stored.length ? stored : await setAllowedPackages(merged);
      if (alive) setPackages(next);
    })();
    return () => {
      alive = false;
    };
  }, [supported]);

  // Coming back from the system settings screen re-reads the access state.
  useEffect(() => {
    void reload();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void reload();
    });
    return () => sub.remove();
  }, [reload]);

  const requestAccess = () => {
    Alert.alert('알림 접근 안내', DISCLOSURE, [
      { text: '취소', style: 'cancel' },
      {
        text: '확인',
        onPress: () => {
          void openNotificationAccessSettings().then((opened) => {
            if (!opened) toast.show('알림 접근 설정을 열지 못했어요');
          });
        },
      },
    ]);
  };

  const addPackage = async () => {
    const name = packageDraft.trim();
    if (!name) return;
    setPackages(await setAllowedPackages([...packages, name]));
    setPackageDraft('');
  };

  const removePackage = async (name: string) => {
    setPackages(await setAllowedPackages(packages.filter((p) => p !== name)));
  };

  const clearCaptured = () => {
    Alert.alert('캡처된 알림을 모두 지울까요?', '이 기기에 임시 저장된 알림만 지워져요.', [
      { text: '취소', style: 'cancel' },
      {
        text: '지우기',
        style: 'destructive',
        onPress: () => {
          void clearCapturedNotifications().then(() => reload());
        },
      },
    ]);
  };

  return (
    <ModalScreen title="결제 알림 자동입력 (준비 중)" onClose={() => router.back()}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl, gap: spacing.md }}>
        <Panel>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text, ...noPad }}>
            아직 준비 중인 기능이에요
          </Text>
          <Text style={bodyStyle}>
            카드·은행 앱의 결제 알림을 읽어 가계부 입력을 돕는 기능을 만들고 있어요. 지금은 알림이 이 기기에
            제대로 수신되는지만 확인하는 테스트 단계라서, 거래가 자동으로 만들어지지 않아요.
          </Text>
          <Text style={bodyStyle}>{DISCLOSURE}</Text>
        </Panel>

        {!supported ? (
          <Panel>
            <Text style={bodyStyle}>
              이 기기에서는 사용할 수 없어요. Android 전용 기능이고, 이 기능이 포함된 앱 버전이 필요해요.
            </Text>
          </Panel>
        ) : (
          <>
            <Panel>
              <StatusRow label="알림 접근 권한" value={granted ? '허용됨' : '꺼져 있음'} ok={granted} />
              <ActionButton label={granted ? '알림 접근 설정 열기' : '알림 접근 허용하기'} onPress={requestAccess} />
            </Panel>

            <Panel>
              <StatusRow label="알림을 읽을 앱" value={`${packages.length}개`} ok={packages.length > 0} />
              <Text style={bodyStyle}>
                여기에 추가한 앱(패키지명)의 알림만 저장돼요. 목록이 비어 있으면 아무 알림도 저장하지 않아요.
              </Text>
              {packages.map((name) => (
                <View key={name} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ flex: 1, fontFamily: fontFamily.medium, fontSize: 13, color: colors.text }}>
                    {name}
                  </Text>
                  <Pressable onPress={() => void removePackage(name)} hitSlop={8}>
                    <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.expenseText }}>삭제</Text>
                  </Pressable>
                </View>
              ))}
              <Field label="패키지명 추가 (테스트용)">
                <TextField
                  value={packageDraft}
                  onChangeText={setPackageDraft}
                  placeholder="예: com.example.app"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={() => void addPackage()}
                />
              </Field>
              <ActionButton label="추가" onPress={() => void addPackage()} disabled={!packageDraft.trim()} />
            </Panel>

            <Panel>
              <StatusRow
                label="캡처된 금융 알림"
                value={`${captured.length}건 / 최대 ${CAPTURED_MAX_ENTRIES}건`}
                ok={captured.length > 0}
              />
              <Text style={bodyStyle}>이 기기에만 최대 7일 동안 임시 저장돼요.</Text>
              <ActionButton
                label={listOpen ? '테스트 알림 목록 접기' : '테스트 알림 목록 보기'}
                onPress={() => {
                  setListOpen((open) => !open);
                  void reload();
                }}
              />
              {listOpen && captured.length === 0 && <Text style={bodyStyle}>아직 캡처된 알림이 없어요.</Text>}
              {listOpen &&
                captured.map((item, index) => (
                  <View
                    key={`${item.notificationKey}|${item.postedAt}|${item.text}`}
                    style={{
                      padding: 12,
                      borderRadius: radii.md,
                      backgroundColor: colors.bg,
                      borderWidth: 1,
                      borderColor: colors.border,
                      gap: 4,
                    }}
                  >
                    <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: colors.textMuted }}>
                      {formatPostedAt(item.postedAt)} · {item.packageName}
                    </Text>
                    {!!item.title && (
                      <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>{item.title}</Text>
                    )}
                    {!!item.text && <Text style={bodyStyle}>{item.text}</Text>}
                    <CandidatePreview candidate={candidates[index] ?? null} />
                  </View>
                ))}
              {captured.length > 0 && <ActionButton label="캡처된 알림 모두 지우기" onPress={clearCaptured} danger />}
            </Panel>
          </>
        )}
      </View>
    </ModalScreen>
  );
}

const bodyStyle = {
  fontFamily: fontFamily.regular,
  fontSize: 13,
  lineHeight: 20,
  color: colors.textSub,
} as const;

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        padding: spacing.lg,
        borderRadius: radii.xxl,
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 10,
      }}
    >
      {children}
    </View>
  );
}

const DIRECTION_LABEL: Record<ParsedPaymentCandidate['direction'], string> = {
  outflow: '출금',
  inflow: '입금',
  unknown: '방향 확인 필요',
};
const CONFIDENCE_LABEL: Record<ParsedPaymentCandidate['confidence'], string> = {
  high: '신뢰도 높음',
  medium: '신뢰도 보통 · 일부 확인 필요',
  low: '신뢰도 낮음 · 확인 필요',
};

/** STEP 2 test preview of the parser's reading. No save action on purpose. */
function CandidatePreview({ candidate }: { candidate: ParsedPaymentCandidate | null }) {
  const boxStyle = {
    marginTop: 4,
    padding: 8,
    borderRadius: radii.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  } as const;
  const line = { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub } as const;
  const muted = { fontFamily: fontFamily.medium, fontSize: 11, color: colors.textMuted } as const;
  if (!candidate || candidate.direction === 'unknown' || candidate.amount == null) {
    return (
      <View style={boxStyle}>
        <Text style={muted}>해석 결과</Text>
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.warningText }}>
          해석 불가 / 확인 필요{!candidate ? ' · 지원하지 않는 알림' : ''}
        </Text>
        {!!candidate && candidate.reasons.length > 0 && <Text style={muted}>{candidate.reasons.join(' · ')}</Text>}
      </View>
    );
  }
  return (
    <View style={boxStyle}>
      <Text style={muted}>해석 결과 (테스트 · 저장되지 않음)</Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>
        {DIRECTION_LABEL[candidate.direction]} · {fmt(candidate.amount)}원
      </Text>
      <Text style={line}>
        계좌:{' '}
        {candidate.accountName
          ? `${candidate.accountName}${candidate.accountLast4 ? ` ****${candidate.accountLast4}` : ''}`
          : '확인 필요'}
      </Text>
      <Text style={line}>상대: {candidate.counterparty ?? '확인 필요'}</Text>
      {!!candidate.merchantCandidate && <Text style={line}>메모/가맹점 후보: {candidate.merchantCandidate}</Text>}
      {!!candidate.relationKey && (
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.primaryStrong }}>
          관련 알림 가능성 있음 · 같은 금액의 반대 방향 알림이 10초 안에 있어요
        </Text>
      )}
      <Text style={{ ...muted, color: candidate.confidence === 'high' ? colors.textMuted : colors.warningText }}>
        {CONFIDENCE_LABEL[candidate.confidence]}
      </Text>
    </View>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ flex: 1, fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, ...noPad }}>{label}</Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: ok ? colors.primaryStrong : colors.textMuted }}>
        {value}
      </Text>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  disabled,
  danger,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: radii.xl,
        borderWidth: 1,
        borderColor: danger ? colors.expense : colors.border,
        backgroundColor: danger ? colors.expenseLight : colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: danger ? colors.expenseText : colors.text }}>
        {label}
      </Text>
    </Pressable>
  );
}
