"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Wallet,
  ArrowLeftRight,
  PiggyBank,
  TrendingUp,
  Landmark,
  Target,
  FileText,
  Calculator,
  Upload,
  Settings,
} from "lucide-react";

const mainLinks = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, color: "text-blue-400" },
  { href: "/accounts", label: "Accounts", icon: Wallet, color: "text-violet-400" },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight, color: "text-amber-400" },
  { href: "/budgets", label: "Budgets", icon: PiggyBank, color: "text-emerald-400" },
  { href: "/portfolio", label: "Portfolio", icon: TrendingUp, color: "text-cyan-400" },
  { href: "/loans", label: "Loans & Debt", icon: Landmark, color: "text-rose-400" },
  { href: "/goals", label: "Goals", icon: Target, color: "text-orange-400" },
  { href: "/reports", label: "Reports", icon: FileText, color: "text-slate-400" },
  { href: "/tax", label: "Tax", icon: Calculator, color: "text-teal-400" },
];

const bottomLinks = [
  { href: "/import", label: "Import", icon: Upload, color: "text-blue-400" },
  { href: "/settings", label: "Settings", icon: Settings, color: "text-slate-400" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col w-60 bg-sidebar min-h-screen border-r border-sidebar-border">
      {/* Logo */}
      <Link href="/dashboard" className="flex items-center gap-3 px-5 py-5 mb-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/25">
          <span className="text-sm font-bold text-white">PF</span>
        </div>
        <div>
          <span className="text-base font-semibold text-sidebar-foreground">PersonalFi</span>
          <p className="text-[10px] text-sidebar-foreground/50 leading-none">Track here, analyze anywhere</p>
        </div>
      </Link>

      {/* Main links */}
      <div className="flex-1 px-3 space-y-0.5">
        <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">Menu</p>
        {mainLinks.map(({ href, label, icon: Icon, color }) => {
          const isActive = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                  : "text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              <Icon className={cn("h-[18px] w-[18px] shrink-0", isActive ? color : "text-sidebar-foreground/40")} />
              {label}
              {isActive && (
                <div className="ml-auto h-1.5 w-1.5 rounded-full bg-sidebar-primary" />
              )}
            </Link>
          );
        })}
      </div>

      {/* Bottom links */}
      <div className="px-3 pb-4 pt-2 border-t border-sidebar-border space-y-0.5">
        {bottomLinks.map(({ href, label, icon: Icon, color }) => {
          const isActive = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                  : "text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              <Icon className={cn("h-[18px] w-[18px] shrink-0", isActive ? color : "text-sidebar-foreground/40")} />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
