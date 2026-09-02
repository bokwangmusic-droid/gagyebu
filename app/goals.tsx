import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Field, TextField } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { GradientButton } from '@/components/ui/GradientButton';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { useToast } from '@/components/ui/Toast';
import { fmt, formatShortDate, parseNum } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';
import type { Goal } from '@/store/types';

export default function GoalsList() {
  const router = useRouter();
  const toast = useToast();
  const { goals, updateGoal, deleteGoal } = useStore();

  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<Goal | null>(null);
  const [moveMode, setMoveMode] = useState<'in' | 'out'>('in');
  const [moveAmount, setMoveAmount] = useState('');

  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const totalSaved = goals.reduce((s, g) => s + g.saved, 0);

  const handleDelete = (id: string) => {
    if (confirmDel === id) {
      deleteGoal(id);
      setConfirmDel(null);
    } else {
      setConfirmDel(id);
    }
  };

  const openMove = (g: Goal, mode: 'in' | 'out') => {
    setMoveFor(g);
    setMoveMode(mode);
    setMoveAmount('');
  };

  const doMove = () => {
    const n = parseNum(moveAmount);
    if (n <= 0 || !moveFor) return;
    const next =
      moveMode === 'in' ? moveFor.saved + n : Math.max(0, moveFor.saved - n);
    updateGoal(moveFor.id, { saved: next });
    toast.show(moveMode === 'in' ? '입금했어요' : '출금했어요');
    setMoveFor(null);
    setMoveAmount('');
  };

  const addBtn = (
    <Pressable
      onPress={() => router.push('/goal-add')}
      style={{
        width: 36,
        height: 36,
        borderRadius: radii.pill,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AppIcon name="plus" size={18} color={colors.white} strokeWidth={2.5} />
    </Pressable>
  );

  return (
    <ModalScreen title="저축 목표" onClose={() => router.back()} right={addBtn}>
      <LinearGradient
        colors={gradients.goalPink}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          marginHorizontal: spacing.lg,
          marginTop: spacing.sm,
          marginBottom: 18,
          padding: spacing.xl,
          borderRadius: radii.card,
          overflow: 'hidden',
        }}
      >
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: '#831843' }}>총 모은 금액</Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
          <Text
            style={{
              fontFamily: fontFamily.extrabold,
              fontSize: 30,
              letterSpacing: -1,
              color: '#831843',
              ...tabularNums,
            }}
          >
            {fmt(totalSaved)}
          </Text>
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 15, color: '#9F1239' }}>원</Text>
        </View>
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: '#9F1239', marginTop: 8 }}>
          {goals.length}개 목표 진행 중
        </Text>
      </LinearGradient>

      {goals.length === 0 ? (
        <EmptyState
          onPress={() => router.push('/goal-add')}
          title="목표가 없어요"
          sub={'여행, 비상금, 노트북 등\n모으고 싶은 걸 등록해보세요'}
          cta="목표 추가하기"
        />
      ) : (
        goals.map((g) => {
          const pct = g.target > 0 ? Math.round((g.saved / g.target) * 100) : 0;
          const done = pct >= 100;
          return (
            <View
              key={g.id}
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
                  <AppIcon name={g.icon || 'target'} size={22} color={colors.primaryStrong} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 18, color: colors.text, ...noPad }}>
                      {g.name}
                    </Text>
                    <Text
                      style={{
                        fontFamily: fontFamily.bold,
                        fontSize: 12,
                        color: done ? colors.incomeText : colors.primaryStrong,
                        ...tabularNums,
                      }}
                    >
                      {pct}%
                    </Text>
                  </View>
                  <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 14, color: colors.textMuted, ...noPad }}>
                    {fmt(g.saved)} <Text style={{ color: colors.textFaint }}>/ {fmt(g.target)}원</Text>
                    {g.deadline ? ` · 목표일 ${formatShortDate(g.deadline)}` : ''}
                  </Text>
                </View>
              </View>
              <ProgressBar percent={pct} size="md" style={{ marginTop: spacing.md }} />
              <View style={{ flexDirection: 'row', gap: 6, marginTop: spacing.md, justifyContent: 'flex-end' }}>
                {g.saved > 0 && (
                  <Pressable
                    onPress={() => openMove(g, 'out')}
                    style={{
                      paddingVertical: 10,
                      paddingHorizontal: 14,
                      borderRadius: radii.md,
                      backgroundColor: colors.white,
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  >
                    <Text style={{ fontFamily: fontFamily.semibold, fontSize: 14, color: colors.textSub }}>− 출금</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => openMove(g, 'in')}
                  style={{
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                    borderRadius: radii.md,
                    backgroundColor: colors.primaryLight,
                  }}
                >
                  <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.primaryStrong }}>+ 입금</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleDelete(g.id)}
                  style={{
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                    borderRadius: radii.md,
                    backgroundColor: confirmDel === g.id ? colors.expenseSolid : colors.white,
                    borderWidth: 1,
                    borderColor: confirmDel === g.id ? colors.expenseSolid : colors.border,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: fontFamily.semibold,
                      fontSize: 14,
                      color: confirmDel === g.id ? colors.white : colors.expenseText,
                    }}
                  >
                    {confirmDel === g.id ? '삭제할래요' : '삭제'}
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        })
      )}

      {moveFor && (
        <BottomSheet
          visible
          onClose={() => setMoveFor(null)}
          title={`「${moveFor.name}」${moveMode === 'in' ? '에 입금' : '에서 출금'}`}
        >
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub, marginBottom: spacing.md }}>
            현재 {fmt(moveFor.saved)}원
            {moveMode === 'in' ? ` · 목표 ${fmt(moveFor.target)}원` : ' 에서 뺄 금액을 입력하세요'}
          </Text>
          <Field label={moveMode === 'in' ? '얼마 넣을까요?' : '얼마 뺄까요?'}>
            <TextField
              keyboardType="number-pad"
              autoFocus
              value={moveAmount ? fmt(Number(moveAmount)) : ''}
              onChangeText={(t) => {
                const n = parseNum(t);
                setMoveAmount(String(moveMode === 'out' ? Math.min(n, moveFor.saved) : n));
              }}
              placeholder="0"
            />
          </Field>
          {moveMode === 'out' && (
            <Pressable
              onPress={() => setMoveAmount(String(moveFor.saved))}
              style={{ alignSelf: 'flex-start', marginTop: -spacing.sm, marginBottom: spacing.md }}
              hitSlop={8}
            >
              <Text style={{ fontFamily: fontFamily.semibold, fontSize: 12, color: colors.primaryStrong }}>
                전액 {fmt(moveFor.saved)}원
              </Text>
            </Pressable>
          )}
          <GradientButton
            label={moveMode === 'in' ? '입금하기' : '출금하기'}
            onPress={doMove}
            disabled={!parseNum(moveAmount)}
          />
        </BottomSheet>
      )}
    </ModalScreen>
  );
}
