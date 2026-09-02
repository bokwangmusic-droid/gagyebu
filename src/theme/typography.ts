/**
 * Typography — Noto Sans KR, matching the web version's weight ramp.
 *
 * React Native has no `fontWeight`-picks-the-file behaviour for custom
 * fonts, so every weight is its own family string. Always style text via
 * `fontFamily`, never `fontWeight`.
 */

// Import per-weight subpaths (not the barrel) so only the 5 weights we use
// get bundled — the barrel pulls in all 9 (~55 MB of .ttf).
import { NotoSansKR_400Regular } from '@expo-google-fonts/noto-sans-kr/400Regular';
import { NotoSansKR_500Medium } from '@expo-google-fonts/noto-sans-kr/500Medium';
import { NotoSansKR_600SemiBold } from '@expo-google-fonts/noto-sans-kr/600SemiBold';
import { NotoSansKR_700Bold } from '@expo-google-fonts/noto-sans-kr/700Bold';
import { NotoSansKR_800ExtraBold } from '@expo-google-fonts/noto-sans-kr/800ExtraBold';
import { StyleSheet } from 'react-native';

import { colors } from './tokens';

export const fontFamily = {
  regular: 'NotoSansKR_400Regular',
  medium: 'NotoSansKR_500Medium',
  semibold: 'NotoSansKR_600SemiBold',
  bold: 'NotoSansKR_700Bold',
  extrabold: 'NotoSansKR_800ExtraBold',
} as const;

/** Map for expo-font's useFonts(). */
export const fontMap = {
  NotoSansKR_400Regular,
  NotoSansKR_500Medium,
  NotoSansKR_600SemiBold,
  NotoSansKR_700Bold,
  NotoSansKR_800ExtraBold,
} as const;

/**
 * Reusable text presets. `num` variants are for money — the web uses
 * `font-variant-numeric: tabular-nums`; RN exposes that via
 * `fontVariant: ['tabular-nums']`.
 */
export const type = StyleSheet.create({
  screenTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 20,
    letterSpacing: -0.4,
    color: colors.text,
  },
  sectionTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    color: colors.text,
  },
  eyebrow: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: 0.2,
    color: colors.textSub,
  },
  body: {
    fontFamily: fontFamily.regular,
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },
  bodySub: {
    fontFamily: fontFamily.regular,
    fontSize: 13,
    color: colors.textSub,
    lineHeight: 19,
  },
  label: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    color: colors.textSub,
  },
  caption: {
    fontFamily: fontFamily.regular,
    fontSize: 11,
    color: colors.textMuted,
  },
  balanceValue: {
    fontFamily: fontFamily.extrabold,
    fontSize: 34,
    letterSpacing: -1,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  amount: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
});

export const tabularNums = { fontVariant: ['tabular-nums'] as ['tabular-nums'] };

/**
 * Android adds extra vertical padding inside every text line box, which
 * makes stacked title/subtitle pairs look loosely spaced. Spread this into
 * such text (and pair it with an explicit `lineHeight`) to tighten them.
 */
export const noPad = { includeFontPadding: false } as const;
