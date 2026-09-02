/**
 * Design tokens — pastel Korean household-budget palette.
 *
 * Ported 1:1 from the web version's CSS custom properties (:root).
 * Lavender accent #A78BFA on a cream #FAF6EE ground. No ads, privacy-first.
 *
 * Keep this file the single source of truth for colour, spacing, radius,
 * shadow and layout. Screens should never hard-code hex values.
 */

import type { ViewStyle } from 'react-native';

export const colors = {
  /* Surfaces */
  bg: '#FAF6EE', // app canvas (cream)
  appOutside: '#EDE7DA', // behind the phone frame on wide screens
  card: '#FFFFFF',
  track: '#F5EFE1', // progress-bar trough

  /* Hairlines */
  border: '#F0E9DA',
  borderStrong: '#E7E0CE',

  /* Text */
  text: '#3A3446',
  textSub: '#857E8F',
  textMuted: '#B8B1C1',
  textFaint: '#C7C0D0',

  /* Lavender accent */
  primary: '#A78BFA',
  primaryHover: '#9370E0',
  primaryStrong: '#7C63D4',
  primaryLight: '#EDE9FE',
  primaryLighter: '#F5F1FE',

  /* Income (mint) */
  income: '#6EE7B7',
  incomeLight: '#D1FAE5',
  incomeText: '#059669',
  incomeStrong: '#047857',

  /* Expense (rose) */
  expense: '#F0A4B4',
  expenseSolid: '#F472B6',
  expenseLight: '#FCE7EA',
  expenseText: '#E11D48',
  expenseStrong: '#BE185D',

  /* Warning (peach) */
  warning: '#FDBA74',
  warningLight: '#FEEBD2',
  warningText: '#C2410C',

  /* Info (sky) */
  info: '#93C5FD',
  infoLight: '#DBEAFE',
  infoText: '#2563EB',

  /* Neutral (slate) */
  neutral: '#CBD5E1',
  neutralLight: '#F1F5F9',
  neutralText: '#64748B',

  /* Misc */
  white: '#FFFFFF',
  overlay: 'rgba(58, 52, 70, 0.4)',
  overlayStrong: 'rgba(58, 52, 70, 0.5)',
} as const;

/**
 * Gradients are expressed as ordered colour stops. Pair with
 * expo-linear-gradient (or a manual interpolation) at the call site.
 * The web uses 135deg for fills and 90deg for the progress bar.
 */
export const gradients = {
  primary: ['#C4B5FD', '#A78BFA'] as const, // buttons, FAB, hero cards (135deg)
  primaryProgress: ['#C4B5FD', '#A78BFA'] as const, // progress fill (90deg)
  goalPink: ['#FEE4E6', '#FBCFE8'] as const, // savings-goal hero (135deg)
} as const;

/** 4-pt spacing scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16, // default screen gutter
  xl: 20,
  xxl: 24,
} as const;

/** Corner radii. `pill` = fully rounded. */
export const radii = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 14,
  xl: 16,
  xxl: 18,
  card: 22, // .card
  sheet: 24, // bottom-sheet top corners
  pill: 999,
} as const;

/** iOS shadow + Android elevation presets. */
export const shadows: Record<'sm' | 'md' | 'fab', ViewStyle> = {
  sm: {
    shadowColor: '#3A3446',
    shadowOpacity: 0.05,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  md: {
    shadowColor: '#3A3446',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  fab: {
    shadowColor: '#A78BFA',
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
};

/** Layout constants. The web app is capped at a 430px "phone" column. */
export const layout = {
  maxContentWidth: 430,
  screenGutter: spacing.lg,
  tabBarHeight: 64,
  fabSize: 56,
} as const;

export type ColorToken = keyof typeof colors;
