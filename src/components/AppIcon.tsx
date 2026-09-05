/**
 * <AppIcon /> — single entry point for iconography.
 *
 * The web version drew inline Lucide-style SVG paths keyed by short names.
 * Here we map those same keys onto `lucide-react-native` components so the
 * rest of the app keeps using semantic names ("utensils", "chev-right").
 */

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bell,
  Briefcase,
  Bus,
  Calendar,
  Car,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clipboard,
  Cloud,
  Coffee,
  CreditCard,
  Delete,
  Download,
  Eye,
  EyeOff,
  Flag,
  Gift,
  GripVertical,
  Heart,
  HelpCircle,
  Home,
  Info,
  Landmark,
  Laptop,
  MapPin,
  Minus,
  MoreHorizontal,
  Pencil,
  Plane,
  Plus,
  PlusCircle,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShoppingBag,
  Sparkles,
  Target,
  Trash2,
  Tv,
  User,
  Utensils,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react-native';

import { colors } from '@/theme/tokens';

/** Semantic name -> lucide component. Kept flat and readable. */
const MAP: Record<string, LucideIcon> = {
  // category icons
  utensils: Utensils,
  bus: Bus,
  car: Car,
  'shopping-bag': ShoppingBag,
  coffee: Coffee,
  'map-pin': MapPin,
  home: Home,
  heart: Heart,
  tv: Tv,
  gift: Gift,
  dots: MoreHorizontal,
  briefcase: Briefcase,
  'plus-circle': PlusCircle,
  plane: Plane,
  laptop: Laptop,
  target: Target,
  shield: Shield,
  flag: Flag,
  calendar: Calendar,
  bell: Bell,
  clipboard: Clipboard,
  sparkle: Sparkles,

  // nav + ui
  'chev-left': ChevronLeft,
  'chev-right': ChevronRight,
  'chev-up': ChevronUp,
  'chev-down': ChevronDown,
  chevron: ChevronDown,
  x: X,
  plus: Plus,
  minus: Minus,
  search: Search,
  settings: Settings,
  refresh: RefreshCw,
  backspace: Delete,
  edit: Pencil,
  up: ArrowUp,
  down: ArrowDown,
  trash: Trash2,
  grip: GripVertical,
  card: CreditCard,
  landmark: Landmark,
  won: Wallet,
  info: Info,
  help: HelpCircle,
  download: Download,
  eye: Eye,
  'eye-off': EyeOff,
  warn: AlertTriangle,
  cloud: Cloud,
  'nav-home': Home,
  'nav-chart': BarChart3,
  'nav-budget': Wallet,
  'nav-user': User,
  'nav-calendar': Calendar,
};

export type IconName = keyof typeof MAP;

export interface AppIconProps {
  name: IconName | (string & {});
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export function AppIcon({
  name,
  size = 20,
  color = colors.text,
  strokeWidth = 2,
}: AppIconProps) {
  const Cmp = MAP[name] ?? MoreHorizontal;
  return <Cmp size={size} color={color} strokeWidth={strokeWidth} />;
}

export default AppIcon;
