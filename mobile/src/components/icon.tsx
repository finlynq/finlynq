// Centralized lucide icon map — mirrors the web nav.tsx icon choices so the
// mobile app and the website use the same glyph vocabulary. Screens reference
// icons by semantic name (`<Icon name="accounts" />`) instead of importing
// lucide components directly, so a glyph swap happens in one place.
import React from "react";
import {
  LayoutDashboard,
  Wallet,
  TrendingUp,
  ArrowLeftRight,
  MoreHorizontal,
  PiggyBank,
  Target,
  Upload,
  Settings,
  CreditCard,
  Landmark,
  FileText,
  ArrowUpRight,
  ArrowDownLeft,
  Search,
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  LogOut,
  ScanFace,
  Trash2,
  Pencil,
  X,
  Check,
  RefreshCw,
  Building2,
  Tag,
  Sparkles,
  Megaphone,
  MessageCircle,
  Minus,
  Repeat,
  DollarSign,
  ArrowRightLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  LineChart,
  Coins,
  Scissors,
  Zap,
  ShieldCheck,
  Eye,
  Inbox,
  Link2,
  type LucideIcon,
} from "lucide-react-native";

export const Icons = {
  dashboard: LayoutDashboard,
  accounts: Wallet,
  portfolio: TrendingUp,
  transactions: ArrowLeftRight,
  transfer: ArrowLeftRight,
  more: MoreHorizontal,
  budgets: PiggyBank,
  goals: Target,
  import: Upload,
  settings: Settings,
  subscriptions: CreditCard,
  loans: Landmark,
  reports: FileText,
  bank: Building2,
  inflow: ArrowUpRight,
  outflow: ArrowDownLeft,
  search: Search,
  back: ArrowLeft,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  add: Plus,
  logout: LogOut,
  biometric: ScanFace,
  trash: Trash2,
  edit: Pencil,
  close: X,
  check: Check,
  refresh: RefreshCw,
  categories: Tag,
  sampleData: Sparkles,
  whatsNew: Megaphone,
  feedback: MessageCircle,
  split: Scissors,
  // Portfolio operations
  minus: Minus,
  swap: Repeat,
  dollar: DollarSign,
  fx: ArrowRightLeft,
  depositDown: ArrowDownToLine,
  withdrawUp: ArrowUpFromLine,
  performance: LineChart,
  coins: Coins,
  // Reconcile inbox
  inbox: Inbox,
  zap: Zap,
  shield: ShieldCheck,
  eye: Eye,
  link: Link2,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof Icons;

export function Icon({
  name,
  size = 18,
  color,
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}) {
  const Cmp = Icons[name];
  return <Cmp size={size} color={color} strokeWidth={strokeWidth} />;
}
