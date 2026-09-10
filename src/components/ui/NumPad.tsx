import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

/**
 * NUMPAD BACKSPACE LONG-PRESS REPEAT UX FIX — a tap deletes exactly one
 * digit; holding repeats after a short delay until release. `onBackspace` is
 * called repeatedly from a plain `setInterval`, never re-reading component
 * state itself — every caller's own handler already applies its edit via a
 * functional `setState(prev => ...)` update (verified across all 8 screens
 * using this component), so calling the SAME closure many times in a row is
 * safe with no stale-value risk, even though the closure identity captured
 * by the running interval doesn't change mid-hold.
 */
const BACKSPACE_REPEAT_DELAY_MS = 400;
const BACKSPACE_REPEAT_INTERVAL_MS = 80;

/** `onPressIn`/`onPressOut` pair for a press-and-hold-to-repeat backspace key.
 *  Deliberately NOT `onPress` — layering `onPress` on top of an immediate
 *  onPressIn delete would double-delete every tap, and firing it again on
 *  release after a long-press would delete one extra digit. */
function useBackspaceRepeat(onBackspace: () => void) {
  const delayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = () => {
    if (delayTimer.current != null) {
      clearTimeout(delayTimer.current);
      delayTimer.current = null;
    }
    if (repeatTimer.current != null) {
      clearInterval(repeatTimer.current);
      repeatTimer.current = null;
    }
  };

  // Unmount / navigation-away safety — a held key never keeps deleting after
  // the screen is gone.
  useEffect(() => clearTimers, []);

  const onPressIn = () => {
    clearTimers(); // defensive: a stray leftover timer never survives a new press
    onBackspace(); // the tap itself — exactly one digit, immediately
    delayTimer.current = setTimeout(() => {
      delayTimer.current = null;
      repeatTimer.current = setInterval(onBackspace, BACKSPACE_REPEAT_INTERVAL_MS);
    }, BACKSPACE_REPEAT_DELAY_MS);
  };

  // Release OR cancel (RN fires onPressOut in both cases) -> stop immediately.
  const onPressOut = () => {
    clearTimers();
  };

  return { onPressIn, onPressOut };
}

/**
 * The app's custom money keypad — 1–9 / 00 / 0 digit grid, a backspace key
 * and a gradient "완료" key. Presentational only: the parent owns the amount
 * string and decides when to show/hide the pad.
 *
 * `app/input.tsx` still has an equivalent grid inline (it also stacks its own
 * 저장 button inside the same sheet). That copy is left untouched on purpose
 * so extracting this component can't regress the primary expense-input
 * screen — keep the two visually in sync if either changes.
 *
 * `decimal` is an opt-in that swaps the "00" key for a "." key (used by the
 * 대출 추가 이자율 field). It only changes which key renders in that one slot
 * and which string `onKey` emits there — every money screen that doesn't pass
 * `decimal` gets the exact same pad as before.
 */
const KEY_HEIGHT = 52;
const KEY_GAP = 6;

export function NumPad({
  onKey,
  onBackspace,
  onDone,
  style,
  decimal = false,
}: {
  /** A pressed key — '0'–'9', '00', or '.' when `decimal` is set. */
  onKey: (digit: string) => void;
  onBackspace: () => void;
  onDone: () => void;
  /** Extra container style, e.g. safe-area bottom padding. */
  style?: StyleProp<ViewStyle>;
  /** Opt-in: replace the "00" key with a "." key for decimal entry. */
  decimal?: boolean;
}) {
  const backspace = useBackspaceRepeat(onBackspace);
  return (
    <View style={[styles.numPad, style]}>
      <View style={{ flexDirection: 'row', gap: KEY_GAP }}>
        {/* digit block */}
        <View style={{ flex: 3, gap: KEY_GAP }}>
          {[
            ['1', '2', '3'],
            ['4', '5', '6'],
            ['7', '8', '9'],
          ].map((row) => (
            <View key={row[0]} style={{ flexDirection: 'row', gap: KEY_GAP }}>
              {row.map((n) => (
                <NumKey key={n} label={n} onPress={() => onKey(n)} />
              ))}
            </View>
          ))}
          <View style={{ flexDirection: 'row', gap: KEY_GAP }}>
            {decimal ? (
              <NumKey label="." onPress={() => onKey('.')} />
            ) : (
              <NumKey label="00" ghost onPress={() => onKey('00')} />
            )}
            <NumKey label="0" onPress={() => onKey('0')} />
            <View style={{ flex: 1 }} />
          </View>
        </View>

        {/* backspace + 완료 */}
        <View style={{ flex: 1, gap: KEY_GAP }}>
          <Pressable
            onPressIn={backspace.onPressIn}
            onPressOut={backspace.onPressOut}
            style={({ pressed }) => [
              styles.key,
              { height: KEY_HEIGHT },
              pressed && styles.keyPressed,
            ]}
          >
            <AppIcon name="backspace" size={22} color={colors.textSub} />
          </Pressable>
          <Pressable
            onPress={onDone}
            style={{ flex: 1, borderRadius: radii.lg, overflow: 'hidden' }}
          >
            <LinearGradient
              colors={gradients.primary}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.doneKey}
            >
              <AppIcon name="down" size={18} color={colors.white} strokeWidth={2.5} />
              <Text style={styles.doneKeyText}>완료</Text>
            </LinearGradient>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function NumKey({
  label,
  ghost,
  onPress,
}: {
  label: string;
  ghost?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.key,
        { flex: 1, height: KEY_HEIGHT },
        ghost && styles.keyGhost,
        pressed && !ghost && styles.keyPressed,
        pressed && ghost && { opacity: 0.5 },
      ]}
    >
      <Text
        style={{
          fontFamily: fontFamily.semibold,
          fontSize: ghost ? 20 : 22,
          // Android's default font padding is asymmetric for Noto Sans KR
          // (tall Hangul metrics), so the digit glyph sits below the true
          // centre of its line box. Drop the padding and pin lineHeight ==
          // fontSize so the wrapper's justifyContent:'center' centres the
          // glyph itself. Same recipe as `noPad` elsewhere (typography.ts).
          ...noPad,
          lineHeight: ghost ? 20 : 22,
          textAlignVertical: 'center',
          color: ghost ? colors.textSub : colors.text,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  numPad: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.border,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
  },
  key: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyGhost: { backgroundColor: 'transparent' },
  keyPressed: { backgroundColor: colors.track },
  doneKey: {
    flex: 1,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  doneKeyText: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    color: colors.white,
  },
});

export default NumPad;
