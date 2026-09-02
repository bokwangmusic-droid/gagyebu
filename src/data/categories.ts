/**
 * Category catalogue — ported from the web version.
 *
 * `icon` is a semantic key resolved to a component by <AppIcon />.
 * Custom categories created by the user are merged on top of the defaults
 * and ordered by the user's `catOrder`.
 */

export type TxnType = 'income' | 'expense';

export interface Category {
  id: string;
  name: string;
  bg: string;
  color: string;
  icon: IconKey;
  custom?: boolean;
}

export type IconKey =
  | 'utensils'
  | 'bus'
  | 'car'
  | 'shopping-bag'
  | 'coffee'
  | 'map-pin'
  | 'home'
  | 'heart'
  | 'tv'
  | 'gift'
  | 'dots'
  | 'briefcase'
  | 'plus-circle'
  | 'plane'
  | 'laptop'
  | 'target'
  | 'shield'
  | 'flag'
  | 'calendar'
  | 'bell'
  | 'clipboard'
  | 'sparkle';

export const EXPENSE_CATS: Category[] = [
  { id: 'food', name: '식비', bg: '#EDE9FE', color: '#7C63D4', icon: 'utensils' },
  { id: 'transit', name: '교통', bg: '#D1FAE5', color: '#059669', icon: 'bus' },
  { id: 'shopping', name: '쇼핑', bg: '#FEEBD2', color: '#C2410C', icon: 'shopping-bag' },
  { id: 'cafe', name: '카페', bg: '#FCE7EA', color: '#E11D48', icon: 'coffee' },
  { id: 'leisure', name: '여가', bg: '#DBEAFE', color: '#2563EB', icon: 'map-pin' },
  { id: 'housing', name: '주거', bg: '#F3E8FF', color: '#7C63D4', icon: 'home' },
  { id: 'health', name: '건강', bg: '#FCE7F3', color: '#DB2777', icon: 'heart' },
  { id: 'subscribe', name: '구독', bg: '#FEE2E2', color: '#DC2626', icon: 'tv' },
  { id: 'gift', name: '경조사', bg: '#FEF3C7', color: '#B45309', icon: 'gift' },
  { id: 'other', name: '기타', bg: '#F1F5F9', color: '#64748B', icon: 'dots' },
];

export const INCOME_CATS: Category[] = [
  { id: 'salary', name: '월급', bg: '#D1FAE5', color: '#059669', icon: 'briefcase' },
  { id: 'side', name: '부수입', bg: '#EDE9FE', color: '#7C63D4', icon: 'plus-circle' },
  { id: 'allowance', name: '용돈', bg: '#FCE7F3', color: '#DB2777', icon: 'gift' },
  { id: 'other-in', name: '기타', bg: '#F1F5F9', color: '#64748B', icon: 'dots' },
];

/** Palettes offered when the user creates a custom category. */
export const CAT_COLOR_PALETTE = [
  { bg: '#EDE9FE', color: '#7C63D4' }, // violet
  { bg: '#D1FAE5', color: '#059669' }, // mint
  { bg: '#FCE7EA', color: '#E11D48' }, // coral
  { bg: '#FEEBD2', color: '#C2410C' }, // peach
  { bg: '#DBEAFE', color: '#2563EB' }, // sky
  { bg: '#FCE7F3', color: '#DB2777' }, // rose
  { bg: '#FEF3C7', color: '#B45309' }, // amber
  { bg: '#F3E8FF', color: '#9333EA' }, // lavender
  { bg: '#CFFAFE', color: '#0891B2' }, // cyan
  { bg: '#F1F5F9', color: '#64748B' }, // slate
] as const;

export const CAT_ICON_PALETTE: IconKey[] = [
  'utensils', 'coffee', 'bus', 'car', 'shopping-bag',
  'home', 'heart', 'tv', 'gift', 'plane',
  'laptop', 'target', 'briefcase', 'shield', 'flag',
  'calendar', 'bell', 'clipboard', 'sparkle', 'dots',
];

export interface CustomCatMap {
  expense: Category[];
  income: Category[];
}

export interface CatOrderMap {
  expense: string[];
  income: string[];
}

export const DEFAULT_CUSTOM_CATS: CustomCatMap = { expense: [], income: [] };

export const DEFAULT_CAT_ORDER: CatOrderMap = {
  expense: EXPENSE_CATS.map((c) => c.id),
  income: INCOME_CATS.map((c) => c.id),
};

function base(type: TxnType): Category[] {
  return type === 'income' ? INCOME_CATS : EXPENSE_CATS;
}

/** Resolve a category id to its definition; falls back to "기타". */
export function getCat(
  id: string,
  type: TxnType,
  custom: CustomCatMap = DEFAULT_CUSTOM_CATS,
): Category {
  const list = base(type);
  return (
    list.find((c) => c.id === id) ??
    custom[type].find((c) => c.id === id) ??
    list[list.length - 1]
  );
}

/** Full ordered category list (defaults + custom), honouring `catOrder`. */
export function getAllCats(
  type: TxnType,
  custom: CustomCatMap = DEFAULT_CUSTOM_CATS,
  order: CatOrderMap = DEFAULT_CAT_ORDER,
): Category[] {
  const combined = [...base(type), ...custom[type]];
  const ids = order[type];
  if (!ids?.length) return combined;
  const rank = new Map(ids.map((id, i) => [id, i]));
  return combined
    .slice()
    .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
}
