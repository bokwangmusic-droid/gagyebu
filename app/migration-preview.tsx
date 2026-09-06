/**
 * "기존 데이터 연결 준비" — STEP 16-F1, wired to the real import in STEP 16-F2.
 *
 * Builds an in-memory snapshot of the device's local financial data
 * (src/lib/householdMigration.ts) and reports whether it could be migrated
 * to the connected household. Owner-only: household_id/user ownership of
 * this device's AsyncStorage data can't be verified any other way (see
 * completion report §5) — a member never even builds a snapshot here.
 *
 * STEP 16-F2 adds the actual one-time upload, but ONLY via
 * public.import_household_snapshot (supabase/migrations/
 * 20260906000800_household_import.sql), the single write path — this
 * screen never inserts/updates/deletes any financial table directly. Local
 * data is never deleted, migrated away from, or namespaced differently —
 * see the completion report for the full read/write boundary.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { useToast } from '@/components/ui/Toast';
import { Toggle } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { createBackup, type BackupData } from '@/lib/backup';
import { fmt } from '@/lib/format';
import {
  buildHouseholdImportPayload,
  buildLocalMigrationSnapshot,
  checkMigrationReadiness,
  totalMigratableCount,
  type MigrationCounts,
} from '@/lib/householdMigration';
import {
  generateImportId,
  getHouseholdImportStatus,
  importHouseholdSnapshot,
} from '@/services/householdImport';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

const COUNT_ROWS: { key: keyof MigrationCounts; label: string }[] = [
  { key: 'transactions', label: '거래' },
  { key: 'cards', label: '카드' },
  { key: 'budgets', label: '예산' },
  { key: 'recurring', label: '반복 내역' },
  { key: 'planned', label: '예정 지출' },
  { key: 'goals', label: '저축 목표' },
  { key: 'loans', label: '대출' },
];

/** Labels for the RPC's returned counts object (snake_case keys). */
const RESULT_COUNT_ROWS: { key: string; label: string }[] = [
  { key: 'transactions', label: '거래' },
  { key: 'cards', label: '카드' },
  { key: 'budgets', label: '예산' },
  { key: 'recurring_rules', label: '반복 내역' },
  { key: 'planned_expenses', label: '예정 지출' },
  { key: 'goals', label: '저축 목표' },
  { key: 'loans', label: '대출' },
  { key: 'loan_payments', label: '대출 상환 기록' },
  { key: 'custom_categories', label: '커스텀 카테고리' },
];

/** Whether this household already has a completed import — tri-state so the
 *  UI can tell "confirmed not yet imported" apart from "don't know yet"
 *  (still loading, or the check itself failed) and fail SAFE (block the
 *  import action) in the latter two cases rather than assuming false. */
type ImportStatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; imported: boolean; counts: Record<string, number> | null }
  | { kind: 'error'; message: string };

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        width: '100%',
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.card,
        overflow: 'hidden',
        marginTop: spacing.md,
      }}
    >
      {children}
    </View>
  );
}

function CountRow({ label, value, isLast }: { label: string; value: number; isLast: boolean }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.border,
      }}
    >
      <Text style={{ fontFamily: fontFamily.medium, fontSize: 14, color: colors.text }}>{label}</Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text }}>
        {value > 0 ? `${fmt(value)}건` : '없음'}
      </Text>
    </View>
  );
}

function CheckRow({ ok, label, isLast }: { ok: boolean; label: string; isLast: boolean }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 12,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.border,
      }}
    >
      <AppIcon name={ok ? 'target' : 'warn'} size={16} color={ok ? colors.incomeStrong : colors.warningText} />
      <Text style={{ fontFamily: fontFamily.medium, fontSize: 13, color: colors.text, flex: 1 }}>{label}</Text>
    </View>
  );
}

function NoteCard({
  tone,
  title,
  items,
}: {
  tone: 'blocker' | 'warning';
  title: string;
  items: string[];
}) {
  const bg = tone === 'blocker' ? colors.expenseLight : colors.warningLight;
  const fg = tone === 'blocker' ? colors.expenseText : colors.warningText;
  return (
    <View
      style={{
        width: '100%',
        backgroundColor: bg,
        borderRadius: radii.lg,
        padding: spacing.lg,
        marginTop: spacing.md,
      }}
    >
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: fg, marginBottom: 6 }}>{title}</Text>
      {items.map((item, i) => (
        <Text
          key={i}
          style={{ fontFamily: fontFamily.regular, fontSize: 12, color: fg, lineHeight: 18 }}
        >
          · {item}
        </Text>
      ))}
    </View>
  );
}

export default function MigrationPreview() {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
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
  } = useStore();

  const isOwner = activeHousehold?.role === 'owner';
  // Purely cosmetic re-trigger for "검사 다시 하기" — the snapshot/readiness
  // below are already derived live from useStore()/useHousehold() on every
  // render, so there is nothing stale to actually recompute; the button
  // exists so the user can explicitly ask "check again" and get a visible
  // confirmation. It also re-triggers the household_imports status fetch
  // below.
  const [recheckCount, setRecheckCount] = useState(0);

  const [statusState, setStatusState] = useState<ImportStatusState>({ kind: 'loading' });
  const [confirmedOwnData, setConfirmedOwnData] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState<{
    counts: Record<string, number> | null;
    recovered: boolean;
  } | null>(null);
  // Belt-and-braces double-tap guard alongside `importing` state — a ref so
  // a second press that lands before React re-renders with the disabled
  // button (e.g. two fast taps in the same frame) is still caught
  // synchronously (STEP 16-F2 §8).
  const importingRef = useRef(false);

  const householdId = activeHousehold?.id ?? null;

  // STEP 16-F2 §4: public.household_imports is the authoritative "already
  // imported" signal — a plain member-readable SELECT (RLS: private.
  // is_household_member), refetched whenever the household changes or the
  // user taps "검사 다시 하기". Unknown/loading/error states are treated as
  // "imported" by the readiness check below (fail-safe), never as "not yet
  // imported".
  useEffect(() => {
    if (!isOwner || !householdId) {
      setStatusState({ kind: 'loading' });
      return;
    }
    let cancelled = false;
    setStatusState({ kind: 'loading' });
    void getHouseholdImportStatus(householdId).then((result) => {
      if (cancelled) return;
      if (!result.ok) setStatusState({ kind: 'error', message: result.message });
      else
        setStatusState({
          kind: 'ready',
          imported: result.status.imported,
          counts: result.status.counts,
        });
    });
    return () => {
      cancelled = true;
    };
  }, [isOwner, householdId, recheckCount]);

  const snapshot = useMemo(() => {
    if (!isOwner) return null;
    return buildLocalMigrationSnapshot({
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOwner,
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
    recheckCount,
  ]);

  // For DISPLAY only (which blockers/warnings render) — while the status
  // check is loading or failed, showing "이미 가져왔어요" as a blocker would
  // be a confusing false alarm, so this defaults to `false` here. This is
  // safe because the actual import action button is independently gated on
  // `statusState.kind === 'ready' && !statusState.imported` below, AND
  // `runImport()` re-checks the real marker fresh (never trusting this
  // value) before ever calling the RPC — this flag never gates anything
  // that actually writes data.
  const alreadyImported = statusState.kind === 'ready' && statusState.imported;
  const readiness = useMemo(() => {
    if (!snapshot) return null;
    return checkMigrationReadiness(snapshot, {
      hasActiveHousehold: !!activeHousehold,
      isOwner,
      alreadyImported,
    });
  }, [snapshot, activeHousehold, isOwner, alreadyImported]);

  const total = snapshot ? totalMigratableCount(snapshot.counts) : 0;

  /**
   * STEP 16-F2 §5/§6/§12: the full pipeline for one real import attempt —
   * final precondition re-check -> safety backup -> fresh snapshot -> fresh
   * readiness re-check -> payload -> RPC. Never trusts anything computed
   * while this screen merely sat open (`snapshot`/`readiness` above are for
   * DISPLAY only; this rebuilds its own).
   */
  const runImport = async () => {
    if (importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    setImportError(null);
    try {
      if (!session) {
        setImportError('다시 로그인해 주세요.');
        return;
      }
      if (!activeHousehold) {
        setImportError('연결된 우리집 가계부가 없어요.');
        return;
      }
      if (activeHousehold.role !== 'owner') {
        setImportError('기존 데이터 가져오기는 방장만 할 수 있어요.');
        return;
      }

      const currentData: BackupData = {
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
      };

      // §5: safety backup FIRST, via the existing STEP 8 backup API — no
      // new backup system. No RPC call happens unless this succeeds.
      const safety = await createBackup('before_import', currentData);
      if (!safety) {
        setImportError('안전 백업을 만들지 못해 가져오기를 시작하지 않았어요.');
        return;
      }

      // §12/§13: re-check the completion marker fresh (never the copy this
      // screen loaded when it first opened). Emptiness itself stays the
      // server's call (§13) — the 008 RPC's own REMOTE_DATA_NOT_EMPTY check.
      const freshStatus = await getHouseholdImportStatus(activeHousehold.id);
      if (!freshStatus.ok) {
        setImportError(freshStatus.message);
        return;
      }
      if (freshStatus.status.imported) {
        setStatusState({ kind: 'ready', imported: true, counts: freshStatus.status.counts });
        setImportError('이미 기존 데이터 가져오기가 완료됐어요.');
        return;
      }

      // Rebuild the snapshot fresh right before sending, never the one this
      // screen computed on an earlier render.
      const freshSnapshot = buildLocalMigrationSnapshot(currentData);
      const freshReadiness = checkMigrationReadiness(freshSnapshot, {
        hasActiveHousehold: true,
        isOwner: true,
        alreadyImported: false,
      });
      if (!freshReadiness.ready) {
        setImportError('데이터 상태가 바뀌어서 다시 확인이 필요해요. 화면을 새로고침해 주세요.');
        setRecheckCount((n) => n + 1);
        return;
      }

      const payload = buildHouseholdImportPayload(freshSnapshot);
      const outcome = await importHouseholdSnapshot({
        householdId: activeHousehold.id,
        importId: generateImportId(),
        schemaVersion: freshSnapshot.schemaVersion,
        payload,
      });

      if (outcome.ok) {
        setStatusState({ kind: 'ready', imported: true, counts: outcome.counts });
        setSucceeded({ counts: outcome.counts, recovered: outcome.recovered });
      } else {
        setImportError(outcome.message);
        // ALREADY_IMPORTED / REMOTE_DATA_NOT_EMPTY mean retrying with the
        // same payload can never succeed — refresh the authoritative
        // status so the UI reflects that instead of inviting another tap.
        if (outcome.code === 'ALREADY_IMPORTED' || outcome.code === 'REMOTE_DATA_NOT_EMPTY') {
          setRecheckCount((n) => n + 1);
        }
      }
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  const handleImportPress = () => {
    if (!confirmedOwnData || importingRef.current) return;
    Alert.alert(
      '가져오기를 시작할까요?',
      '기존 로컬 데이터는 삭제되지 않아요.\n가져오는 동안 앱을 종료하지 않는 것을 권장해요.',
      [
        { text: '취소', style: 'cancel' },
        { text: '가져오기', onPress: () => void runImport() },
      ],
    );
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 24,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: spacing.xl,
        alignItems: 'center',
      }}
    >
      <View style={{ width: '100%', maxWidth: 430 }}>
        <Pressable
          onPress={() => !importing && router.back()}
          disabled={importing}
          hitSlop={8}
          style={{ marginBottom: spacing.lg, opacity: importing ? 0.4 : 1 }}
        >
          <AppIcon name="chev-left" size={22} color={colors.text} />
        </Pressable>

        <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 20, color: colors.text }}>
          기존 가계부 데이터
        </Text>

        {succeeded ? (
          <>
            <Card>
              <View style={{ padding: spacing.lg }}>
                <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 16, color: colors.text }}>
                  기존 데이터 가져오기 완료 🎉
                </Text>
                {succeeded.recovered && (
                  <Text
                    style={{
                      fontFamily: fontFamily.regular,
                      fontSize: 12,
                      color: colors.textMuted,
                      marginTop: 6,
                      lineHeight: 18,
                    }}
                  >
                    연결이 잠시 끊겼지만, 우리집 가계부에서 가져오기가 정상적으로 완료된 걸 확인했어요.
                  </Text>
                )}
              </View>
              {succeeded.counts &&
                RESULT_COUNT_ROWS.map((row, i) => (
                  <CountRow
                    key={row.key}
                    label={row.label}
                    value={succeeded.counts?.[row.key] ?? 0}
                    isLast={i === RESULT_COUNT_ROWS.length - 1}
                  />
                ))}
            </Card>
            <Text
              style={{
                fontFamily: fontFamily.regular,
                fontSize: 12,
                color: colors.textMuted,
                textAlign: 'center',
                marginTop: spacing.lg,
                lineHeight: 18,
              }}
            >
              이 기기의 기존 데이터는 그대로 남아있어요.{'\n'}
              우리집 가계부 화면은 다음 업데이트에서 열릴 예정이에요.
            </Text>
            <Pressable
              onPress={() => router.back()}
              hitSlop={8}
              style={{ alignItems: 'center', paddingVertical: spacing.md, marginTop: spacing.xl }}
            >
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
                확인
              </Text>
            </Pressable>
          </>
        ) : !isOwner ? (
          <Card>
            <View style={{ padding: spacing.lg }}>
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub, lineHeight: 20 }}>
                기존 데이터 가져오기는 방장이 진행할 수 있어요.
              </Text>
            </View>
          </Card>
        ) : statusState.kind === 'error' ? (
          <Card>
            <View style={{ padding: spacing.lg }}>
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub, lineHeight: 20 }}>
                가져오기 상태를 확인하지 못했어요. {statusState.message}
              </Text>
              <Pressable
                onPress={() => setRecheckCount((n) => n + 1)}
                hitSlop={8}
                style={{ marginTop: spacing.md }}
              >
                <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
                  다시 확인하기
                </Text>
              </Pressable>
            </View>
          </Card>
        ) : statusState.kind === 'ready' && statusState.imported ? (
          <>
            <Card>
              <View style={{ padding: spacing.lg }}>
                <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text }}>
                  기존 데이터 가져오기가 이미 완료됐어요.
                </Text>
              </View>
              {statusState.counts &&
                RESULT_COUNT_ROWS.map((row, i) => (
                  <CountRow
                    key={row.key}
                    label={row.label}
                    value={statusState.counts?.[row.key] ?? 0}
                    isLast={i === RESULT_COUNT_ROWS.length - 1}
                  />
                ))}
            </Card>
          </>
        ) : total === 0 ? (
          <Card>
            <View style={{ padding: spacing.lg }}>
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub, lineHeight: 20 }}>
                옮길 기존 데이터가 없어요.
              </Text>
            </View>
          </Card>
        ) : (
          <>
            <Card>
              {COUNT_ROWS.map((row, i) => (
                <CountRow
                  key={row.key}
                  label={row.label}
                  value={snapshot!.counts[row.key]}
                  isLast={i === COUNT_ROWS.length - 1}
                />
              ))}
            </Card>

            <Text
              style={{
                fontFamily: fontFamily.bold,
                fontSize: 12,
                color: colors.textSub,
                marginTop: spacing.xl,
                marginBottom: -4,
              }}
            >
              업로드 준비 상태
            </Text>
            <Card>
              <CheckRow ok label="기존 데이터 백업 구조 확인" isLast={false} />
              <CheckRow ok={!!activeHousehold} label="우리집 가계부 연결됨" isLast={false} />
              <CheckRow ok={!!readiness?.ready} label="데이터 관계 검사 완료" isLast />
            </Card>

            {readiness && readiness.blockers.length > 0 && (
              <NoteCard
                tone="blocker"
                title="⚠ 데이터를 옮기기 전에 확인이 필요해요"
                items={readiness.blockers}
              />
            )}
            {readiness && readiness.warnings.length > 0 && (
              <NoteCard tone="warning" title="참고할 내용이 있어요" items={readiness.warnings} />
            )}

            {readiness?.ready && statusState.kind === 'loading' && (
              <Text
                style={{
                  fontFamily: fontFamily.regular,
                  fontSize: 12,
                  color: colors.textMuted,
                  marginTop: spacing.md,
                }}
              >
                가져오기 가능 여부를 확인하는 중이에요…
              </Text>
            )}

            {readiness?.ready && statusState.kind === 'ready' && !statusState.imported && (
              <View
                style={{
                  width: '100%',
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderStyle: 'dashed',
                  borderRadius: radii.lg,
                  padding: spacing.lg,
                  marginTop: spacing.md,
                }}
              >
                <Text style={{ fontFamily: fontFamily.medium, fontSize: 13, color: colors.text, lineHeight: 20 }}>
                  이 기기에 저장된 기존 가계부 데이터를{'\n'}현재 &apos;우리집 가계부&apos;로 가져올까요?
                </Text>
                <Text
                  style={{
                    fontFamily: fontFamily.regular,
                    fontSize: 11,
                    color: colors.textMuted,
                    lineHeight: 16,
                    marginTop: 6,
                  }}
                >
                  이 데이터는 로그인 계정별로 구분되어 있지 않아요.{'\n'}
                  이 기기에서 사용하던 기존 가계부가 맞는지 확인해주세요.
                </Text>

                <Pressable
                  onPress={() => setConfirmedOwnData((v) => !v)}
                  disabled={importing}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    marginTop: spacing.lg,
                  }}
                >
                  <Toggle value={confirmedOwnData} onChange={setConfirmedOwnData} disabled={importing} />
                  <Text
                    style={{
                      fontFamily: fontFamily.medium,
                      fontSize: 12,
                      color: colors.text,
                      flex: 1,
                      lineHeight: 17,
                    }}
                  >
                    이 기기에서 사용하던 기존 가계부 데이터가 맞아요.
                  </Text>
                </Pressable>

                {importError && (
                  <Text
                    style={{
                      fontFamily: fontFamily.medium,
                      fontSize: 12,
                      color: colors.expenseText,
                      marginTop: spacing.md,
                      lineHeight: 17,
                    }}
                  >
                    {importError}
                  </Text>
                )}

                <GradientButton
                  label={importing ? '가져오는 중…' : '기존 데이터 가져오기'}
                  onPress={handleImportPress}
                  disabled={!confirmedOwnData || importing}
                  style={{ marginTop: spacing.lg }}
                />
                {importing && (
                  <Text
                    style={{
                      fontFamily: fontFamily.regular,
                      fontSize: 12,
                      color: colors.textMuted,
                      textAlign: 'center',
                      marginTop: spacing.sm,
                    }}
                  >
                    기존 데이터를 우리집 가계부로 옮기고 있어요…
                  </Text>
                )}
              </View>
            )}

            <Text
              style={{
                fontFamily: fontFamily.regular,
                fontSize: 12,
                color: colors.textMuted,
                textAlign: 'center',
                marginTop: spacing.lg,
                lineHeight: 18,
              }}
            >
              가져오기가 끝나도 이 기기의 기존 데이터는 그대로 남아있어요.{'\n'}
              우리집 가계부 화면은 다음 업데이트에서 열릴 예정이에요.
            </Text>
          </>
        )}

        {!succeeded && (
          <>
            <Pressable
              onPress={() => {
                if (importing) return;
                setRecheckCount((n) => n + 1);
                toast.show('최신 상태로 확인했어요');
              }}
              disabled={importing}
              hitSlop={8}
              style={{
                alignItems: 'center',
                paddingVertical: spacing.md,
                marginTop: spacing.xl,
                opacity: importing ? 0.4 : 1,
              }}
            >
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
                검사 다시 하기
              </Text>
            </Pressable>
            <Pressable
              onPress={() => !importing && router.back()}
              disabled={importing}
              hitSlop={8}
              style={{ alignItems: 'center', paddingVertical: spacing.sm, opacity: importing ? 0.4 : 1 }}
            >
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 13, color: colors.textMuted }}>
                나중에 하기
              </Text>
            </Pressable>
          </>
        )}
      </View>
    </ScrollView>
  );
}
