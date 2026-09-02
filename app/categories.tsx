import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { Field, SegmentedTabs, TextField } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { ModalScreen } from '@/components/ui/ModalScreen';
import {
  CAT_COLOR_PALETTE,
  CAT_ICON_PALETTE,
  getAllCats,
  type Category,
  type IconKey,
  type TxnType,
} from '@/data/categories';
import { useStore } from '@/store/store';
import { useToast } from '@/components/ui/Toast';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

const ROW_H = 54;

export default function CategoriesManager() {
  const router = useRouter();
  const toast = useToast();
  const { customCats, catOrder, addCustomCat, deleteCustomCat, reorderCats } = useStore();

  const [tab, setTab] = useState<TxnType>('expense');
  const [adding, setAdding] = useState(false);

  const allCats = getAllCats(tab, customCats, catOrder);
  const customIds = new Set(customCats[tab].map((c) => c.id));

  const confirmDelete = (id: string, name: string) => {
    Alert.alert(`${name} 카테고리를 삭제할까요?`, '이 카테고리로 저장된 기록은 "기타"로 표시돼요.', [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: () => {
          deleteCustomCat(tab, id);
          toast.show('카테고리를 삭제했어요');
        },
      },
    ]);
  };

  const addBtn = (
    <Pressable
      onPress={() => setAdding(true)}
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
    <ModalScreen title="카테고리 관리" onClose={() => router.back()} right={addBtn}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.xs }}>
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'expense', label: '지출' },
            { value: 'income', label: '수입' },
          ]}
        />
      </View>

      <Text
        style={{
          fontFamily: fontFamily.bold,
          fontSize: 11,
          letterSpacing: 0.2,
          color: colors.textSub,
          marginHorizontal: spacing.xl,
          marginTop: spacing.md,
          marginBottom: spacing.sm,
        }}
      >
        입력 시 이 순서대로 나타나요 ·{' '}
        <Text style={{ color: colors.primaryStrong }}>오른쪽 ⋮⋮ 손잡이를 끌어서 이동</Text>
      </Text>

      <DragList
        key={tab}
        cats={allCats}
        customIds={customIds}
        onReorder={(ids) => reorderCats(tab, ids)}
        onDelete={confirmDelete}
      />

      <View
        style={{
          marginHorizontal: spacing.xl,
          marginTop: 18,
          padding: spacing.md,
          backgroundColor: colors.primaryLighter,
          borderRadius: radii.md,
        }}
      >
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.primaryStrong, lineHeight: 17 }}>
          💡 기본 카테고리는 삭제만 안 되고 순서 변경은 자유예요. 자주 쓰는 걸 위로 올려두면 입력할 때 편해요.
        </Text>
      </View>

      {adding && (
        <AddCategoryOverlay
          type={tab}
          onCancel={() => setAdding(false)}
          onSave={(cat) => {
            addCustomCat(tab, cat);
            toast.show('카테고리를 추가했어요');
            setAdding(false);
          }}
        />
      )}
    </ModalScreen>
  );
}

/* ------------------------------------------------------------------ *
 * Long-press-and-drag reorderable list. Rows are absolutely positioned
 * inside a fixed-height card; the picked-up row follows the finger and
 * the others slide out of its way (reanimated). Commits the final order
 * once on release.
 * ------------------------------------------------------------------ */
function DragList({
  cats,
  customIds,
  onReorder,
  onDelete,
}: {
  cats: Category[];
  customIds: Set<string>;
  onReorder: (ids: string[]) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const [data, setData] = useState<Category[]>(cats);
  const draggingRef = useRef(false);

  // Re-sync from the store unless a drag is in progress.
  useEffect(() => {
    if (!draggingRef.current) setData(cats);
  }, [cats]);

  const activeIndex = useSharedValue(-1);
  const dragY = useSharedValue(0);

  const setDragging = (v: boolean) => {
    draggingRef.current = v;
  };

  const commit = (from: number, to: number) => {
    setData((cur) => {
      if (to < 0 || to >= cur.length || from === to) return cur;
      const next = cur.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      onReorder(next.map((c) => c.id));
      return next;
    });
  };

  return (
    <View
      style={{
        marginHorizontal: spacing.lg,
        height: data.length * ROW_H,
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.xxl,
      }}
    >
      {data.map((c, index) => (
        <DragRow
          key={c.id}
          cat={c}
          index={index}
          count={data.length}
          custom={customIds.has(c.id)}
          activeIndex={activeIndex}
          dragY={dragY}
          onDelete={onDelete}
          onDragStart={() => setDragging(true)}
          onCommit={(from, to) => {
            commit(from, to);
            setDragging(false);
          }}
        />
      ))}
    </View>
  );
}

function DragRow({
  cat,
  index,
  count,
  custom,
  activeIndex,
  dragY,
  onDelete,
  onDragStart,
  onCommit,
}: {
  cat: Category;
  index: number;
  count: number;
  custom: boolean;
  activeIndex: { value: number };
  dragY: { value: number };
  onDelete: (id: string, name: string) => void;
  onDragStart: () => void;
  onCommit: (from: number, to: number) => void;
}) {
  const buzz = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  };

  // Starts as soon as the finger moves ~4px vertically on the handle — no hold.
  const pan = Gesture.Pan()
    .activeOffsetY([-4, 4])
    .failOffsetX([-16, 16])
    .onStart(() => {
      activeIndex.value = index;
      dragY.value = 0;
      runOnJS(onDragStart)();
      runOnJS(buzz)();
    })
    .onUpdate((e) => {
      dragY.value = e.translationY;
    })
    .onEnd(() => {
      const target = Math.min(
        count - 1,
        Math.max(0, Math.round(index + dragY.value / ROW_H)),
      );
      runOnJS(onCommit)(index, target);
      activeIndex.value = -1;
      dragY.value = 0;
    })
    .onFinalize(() => {
      if (activeIndex.value === index) {
        runOnJS(onCommit)(index, index);
        activeIndex.value = -1;
        dragY.value = 0;
      }
    });

  const animStyle = useAnimatedStyle(() => {
    const isActive = activeIndex.value === index;
    if (isActive) {
      return {
        transform: [{ translateY: dragY.value }, { scale: withSpring(1.03) }],
        zIndex: 20,
        opacity: 0.97,
        shadowColor: '#3A3446',
        shadowOpacity: 0.12,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
        elevation: 10,
      };
    }
    let shift = 0;
    if (activeIndex.value !== -1) {
      const from = activeIndex.value;
      const to = Math.min(count - 1, Math.max(0, Math.round(from + dragY.value / ROW_H)));
      if (from < to && index > from && index <= to) shift = -ROW_H;
      else if (from > to && index < from && index >= to) shift = ROW_H;
    }
    return {
      transform: [{ translateY: withSpring(shift, { damping: 20, stiffness: 220 }) }],
      zIndex: 1,
    };
  });

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: 0,
          right: 0,
          top: index * ROW_H,
          height: ROW_H,
        },
        animStyle,
      ]}
    >
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingLeft: spacing.lg,
          paddingRight: spacing.sm,
          borderBottomWidth: index === count - 1 ? 0 : 1,
          borderBottomColor: colors.track,
          backgroundColor: colors.white,
          borderRadius: radii.xxl,
        }}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            backgroundColor: cat.bg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AppIcon name={cat.icon} size={16} color={cat.color} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text
            numberOfLines={1}
            style={{ fontFamily: fontFamily.semibold, fontSize: 13, lineHeight: 16, color: colors.text, ...noPad }}
          >
            {cat.name}
          </Text>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, lineHeight: 12, color: colors.textMuted, ...noPad }}>
            {custom ? '사용자 추가' : '기본'}
          </Text>
        </View>
        {custom && (
          <Pressable
            onPress={() => onDelete(cat.id, cat.name)}
            hitSlop={8}
            style={{
              width: 30,
              height: 30,
              borderRadius: radii.sm,
              borderWidth: 1,
              borderColor: colors.expenseLight,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <AppIcon name="trash" size={13} color={colors.expenseText} />
          </Pressable>
        )}
        {/* Drag handle — grab here and slide, no hold needed. */}
        <GestureDetector gesture={pan}>
          <View style={{ paddingVertical: 12, paddingHorizontal: 8 }}>
            <AppIcon name="grip" size={20} color={colors.textMuted} />
          </View>
        </GestureDetector>
      </View>
    </Animated.View>
  );
}

function AddCategoryOverlay({
  type,
  onCancel,
  onSave,
}: {
  type: TxnType;
  onCancel: () => void;
  onSave: (cat: { name: string; icon: IconKey; color: string; bg: string }) => void;
}) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [iconIdx, setIconIdx] = useState(0);
  const [colorIdx, setColorIdx] = useState(0);
  const color = CAT_COLOR_PALETTE[colorIdx];
  const icon = CAT_ICON_PALETTE[iconIdx];
  const canSave = name.trim().length > 0;

  return (
    <Modal transparent visible animationType="slide" statusBarTranslucent onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: colors.overlayStrong, justifyContent: 'flex-end' }}>
        {/* Tap the dimmed area above the sheet to dismiss. */}
        <Pressable style={{ flex: 1 }} onPress={onCancel} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View
            style={{
              backgroundColor: colors.bg,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              maxHeight: '90%',
            }}
          >
            <ScrollView
              contentContainerStyle={{
                padding: spacing.xl,
                paddingBottom: insets.bottom + 28,
              }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
            >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: spacing.lg,
            }}
          >
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text }}>
              {type === 'expense' ? '지출' : '수입'} 카테고리 추가
            </Text>
            <Pressable onPress={onCancel} hitSlop={10}>
              <AppIcon name="x" size={18} color={colors.textSub} />
            </Pressable>
          </View>

          <View
            style={{
              alignItems: 'center',
              marginBottom: 16,
              paddingVertical: 16,
              backgroundColor: colors.white,
              borderRadius: radii.xl,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <View
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                backgroundColor: color.bg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <AppIcon name={icon} size={24} color={color.color} />
            </View>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, marginTop: 8 }}>
              {name.trim() || '카테고리 이름'}
            </Text>
          </View>

          <Field label="이름" hint="최대 12자">
            <TextField
              value={name}
              onChangeText={(t) => setName(t.slice(0, 12))}
              placeholder="예: 반려동물, 자기계발, 커피"
              maxLength={12}
              autoFocus
            />
          </Field>

          <Field label="아이콘">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {CAT_ICON_PALETTE.map((ic, i) => {
                const active = iconIdx === i;
                return (
                  <Pressable
                    key={ic}
                    onPress={() => setIconIdx(i)}
                    style={{
                      width: 46,
                      height: 46,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: active ? color.bg : colors.white,
                      borderWidth: 2,
                      borderColor: active ? color.color : colors.border,
                      borderRadius: radii.md,
                    }}
                  >
                    <AppIcon name={ic} size={19} color={active ? color.color : colors.textSub} />
                  </Pressable>
                );
              })}
            </View>
          </Field>

          <Field label="색상">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {CAT_COLOR_PALETTE.map((c, i) => (
                <Pressable
                  key={i}
                  onPress={() => setColorIdx(i)}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: radii.pill,
                    backgroundColor: c.bg,
                    borderWidth: 2,
                    borderColor: colorIdx === i ? c.color : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <View style={{ width: 16, height: 16, borderRadius: radii.pill, backgroundColor: c.color }} />
                </Pressable>
              ))}
            </View>
          </Field>

          <GradientButton
            label="카테고리 추가"
            disabled={!canSave}
            onPress={() =>
              canSave &&
              onSave({ name: name.trim().slice(0, 12), icon, color: color.color, bg: color.bg })
            }
          />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
