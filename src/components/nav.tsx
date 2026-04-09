"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
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
  CreditCard,
  CalendarDays,
  FlameKindling,
  GitBranch,
  MessageSquare,
  Bot,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  X,
  MoreHorizontal,
  ShieldCheck,
  LogOut,
  User,
  Cloud,
  HardDrive,
  ArrowRightLeft,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FinlynqLogo } from "@/components/FinlynqLogo";

type NavItem = { href: string; label: string; icon: LucideIcon; color: string; mode?: "prod" | "dev" };

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, color: "text-blue-400", mode: "prod" },
      { href: "/mcp-guide", label: "MCP Guide", icon: Bot, color: "text-violet-400", mode: "prod" },
      { href: "/chat", label: "AI Chat", icon: MessageSquare, color: "text-indigo-400", mode: "dev" },
    ],
  },
  {
    label: "Tracking",
    items: [
      { href: "/transactions", label: "Transactions", icon: ArrowLeftRight, color: "text-amber-400", mode: "prod" },
      { href: "/budgets", label: "Budgets", icon: PiggyBank, color: "text-emerald-400", mode: "prod" },
      { href: "/goals", label: "Goals", icon: Target, color: "text-orange-400", mode: "prod" },
      { href: "/subscriptions", label: "Subscriptions", icon: CreditCard, color: "text-pink-400", mode: "dev" },
      { href: "/calendar", label: "Calendar", icon: CalendarDays, color: "text-sky-400", mode: "dev" },
    ],
  },
  {
    label: "Wealth",
    items: [
      { href: "/accounts", label: "Accounts", icon: Wallet, color: "text-violet-400", mode: "prod" },
      { href: "/portfolio", label: "Portfolio", icon: TrendingUp, color: "text-cyan-400", mode: "prod" },
      { href: "/loans", label: "Loans & Debt", icon: Landmark, color: "text-rose-400", mode: "dev" },
    ],
  },
  {
    label: "Analysis",
    items: [
      { href: "/reports", label: "Reports", icon: FileText, color: "text-slate-400", mode: "prod" },
      { href: "/tax", label: "Tax", icon: Calculator, color: "text-teal-400", mode: "dev" },
    ],
  },
  {
    label: "Planning",
    items: [
      { href: "/scenarios", label: "Scenarios", icon: GitBranch, color: "text-purple-400", mode: "dev" },
      { href: "/fire", label: "FIRE Calculator", icon: FlameKindling, color: "text-red-400", mode: "dev" },
    ],
  },
];

const toolLinks: NavItem[] = [
  { href: "/import", label: "Import", icon: Upload, color: "text-blue-400", mode: "prod" },
  { href: "/api-docs", label: "API Docs", icon: FileText, color: "text-slate-400", mode: "dev" },
  { href: "/admin", label: "Admin", icon: ShieldCheck, color: "text-amber-400", mode: "prod" },
  { href: "/settings", label: "Settings", icon: Settings, color: "text-slate-400", mode: "prod" },
];

// Bottom bar items for mobile (5th slot is the account icon, handled separately)
const mobileBarItems: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard, color: "text-blue-400" },
  { href: "/transactions", label: "Txns", icon: ArrowLeftRight, color: "text-amber-400" },
  { href: "/import", label: "Import", icon: Upload, color: "text-indigo-400" },
  { href: "/budgets", label: "Budgets", icon: PiggyBank, color: "text-emerald-400" },
];

const allFlatItems = navGroups.flatMap((g) => g.items).concat(toolLinks);

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [hostingMode, setHostingMode] = useState<"managed" | "self-hosted" | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  // Close desktop account menu on outside click
  useEffect(() => {
    if (!accountMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [accountMenuOpen]);

  const handleSignOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  };

  // Load collapsed state and hosting mode
  useEffect(() => {
    const saved = localStorage.getItem("pf-sidebar-collapsed");
    if (saved === "true") setCollapsed(true);
    // All groups open by default
    const groups: Record<string, boolean> = {};
    navGroups.forEach((g) => { if (g.label) groups[g.label] = true; });
    setOpenGroups(groups);
    // Detect hosting mode and admin status
    fetch("/api/auth/unlock")
      .then((r) => r.json())
      .then((data) => {
        setHostingMode(data.authMethod === "account" ? "managed" : "self-hosted");
        setIsAdmin(data.isAdmin === true);
      })
      .catch(() => {});
    // Load dev mode
    fetch("/api/settings/dev-mode")
      .then((r) => r.json())
      .then((data) => { if (data.devMode) setDevMode(true); })
      .catch(() => {});
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("pf-sidebar-collapsed", String(next));
  };

  const toggleGroup = (label: string) => {
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  const renderLink = (item: NavItem, showLabel: boolean) => {
    const isActive = pathname.startsWith(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        title={!showLabel ? item.label : undefined}
        aria-current={isActive ? "page" : undefined}
        onClick={() => setMobileOpen(false)}
        className={cn(
          "group/link relative flex items-center gap-3 rounded-lg text-[13px] font-medium transition-all duration-200",
          showLabel ? "px-3 py-2" : "px-0 py-2 justify-center",
          isActive
            ? "bg-white/[0.08] text-sidebar-accent-foreground"
            : "text-sidebar-foreground/50 hover:bg-white/[0.05] hover:text-sidebar-foreground"
        )}
      >
        {isActive && (
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full bg-sidebar-primary shadow-[0_0_8px_2px] shadow-sidebar-primary/30" />
        )}
        <item.icon className={cn(
          "h-[18px] w-[18px] shrink-0 transition-all duration-200",
          isActive ? item.color : "text-sidebar-foreground/40 group-hover/link:text-sidebar-foreground/70 group-hover/link:scale-110"
        )} />
        {showLabel && <span className="truncate">{item.label}</span>}
        {showLabel && isActive && <div className="ml-auto h-1.5 w-1.5 rounded-full bg-sidebar-primary animate-pulse" />}
      </Link>
    );
  };

  // Desktop sidebar
  const sidebar = (
    <nav
      aria-label="Main navigation"
      className={cn(
        "hidden md:flex flex-col bg-sidebar h-screen sticky top-0 border-r border-sidebar-border/50 transition-[width] duration-200 ease-in-out overflow-hidden",
        collapsed ? "w-14" : "w-60"
      )}
    >
      {/* Logo */}
      <Link href="/dashboard" className={cn("flex items-center gap-3 py-5 mb-2 group/logo", collapsed ? "px-3 justify-center" : "px-5")}>
        <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-card/50 shrink-0 transition-transform duration-300 group-hover/logo:scale-110">
          <FinlynqLogo size={28} />
        </div>
        {!collapsed && (
          <div className="overflow-hidden">
            <span className="text-base font-semibold text-sidebar-foreground whitespace-nowrap tracking-tight">Finlynq</span>
            <p className="text-[10px] text-sidebar-foreground/50 leading-none whitespace-nowrap">Track here, analyze anywhere</p>
          </div>
        )}
      </Link>

      {/* Account / Mode indicator */}
      <div className="px-2 mb-2">
        <div className="relative" ref={accountMenuRef}>
          <button
            onClick={() => setAccountMenuOpen(!accountMenuOpen)}
            className={cn(
              "flex items-center gap-2 w-full rounded-lg text-[13px] font-medium transition-all duration-200",
              collapsed ? "px-0 py-2 justify-center" : "px-3 py-2",
              "text-sidebar-foreground/60 hover:bg-white/[0.06] hover:text-sidebar-foreground"
            )}
            title={collapsed ? `${hostingMode === "managed" ? "Cloud" : "Self-Hosted"} · Account` : undefined}
          >
            <div className="relative flex h-7 w-7 items-center justify-center rounded-full bg-sidebar-primary/20 shrink-0">
              {hostingMode === "managed" ? (
                <Cloud className="h-3.5 w-3.5 text-sidebar-primary" />
              ) : (
                <HardDrive className="h-3.5 w-3.5 text-sidebar-primary" />
              )}
            </div>
            {!collapsed && (
              <>
                <div className="flex-1 text-left overflow-hidden">
                  <span className="block truncate text-[12px] leading-tight text-sidebar-foreground/80">
                    {hostingMode === "managed" ? "Cloud Mode" : "Self-Hosted"}
                  </span>
                </div>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 text-sidebar-foreground/40 transition-transform duration-200",
                    accountMenuOpen && "rotate-180"
                  )}
                />
              </>
            )}
          </button>
          {accountMenuOpen && (
            <div className={cn(
              "absolute z-50 mt-1 rounded-lg border border-sidebar-border bg-sidebar shadow-xl shadow-black/20 py-1",
              collapsed ? "left-full top-0 ml-2 w-48" : "left-0 right-0"
            )}>
              <div className="px-3 py-2 text-[11px] text-sidebar-foreground/40 uppercase tracking-wider font-semibold">
                {hostingMode === "managed" ? "Cloud Mode" : "Self-Hosted Mode"}
              </div>
              <a
                href="/"
                onClick={() => setAccountMenuOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-[13px] text-sidebar-foreground/60 hover:bg-white/[0.06] hover:text-sidebar-foreground transition-colors"
              >
                <ArrowRightLeft className="h-4 w-4" />
                Switch Mode
              </a>
              <button
                onClick={() => { setAccountMenuOpen(false); handleSignOut(); }}
                className="flex items-center gap-2 px-3 py-2 text-[13px] text-sidebar-foreground/60 hover:bg-white/[0.06] hover:text-sidebar-foreground transition-colors w-full"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Nav groups */}
      <div className="flex-1 px-2 space-y-1 overflow-y-auto">
        {navGroups.map((group) => {
          const visibleItems = group.items.filter((item) => devMode || item.mode !== "dev");
          if (visibleItems.length === 0) return null;
          return (
          <div key={group.label || "top"}>
            {group.label && !collapsed && (
              <button
                onClick={() => toggleGroup(group.label)}
                className="flex items-center w-full px-3 mb-1 mt-5 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/30 hover:text-sidebar-foreground/50 transition-colors"
              >
                <ChevronDown
                  className={cn(
                    "h-3 w-3 mr-1 transition-transform duration-200",
                    !openGroups[group.label] && "-rotate-90"
                  )}
                />
                {group.label}
              </button>
            )}
            {collapsed && group.label && (
              <div className="mx-auto my-2 w-6 border-t border-sidebar-border" />
            )}
            {(collapsed || !group.label || openGroups[group.label]) &&
              visibleItems.map((item) => renderLink(item, !collapsed))}
          </div>
          );
        })}
      </div>

      {/* Bottom section */}
      <div className="px-2 pb-3 pt-2 border-t border-sidebar-border/50 space-y-0.5">
        {toolLinks.filter((item) => (devMode || item.mode !== "dev") && (item.href !== "/admin" || isAdmin)).map((item) => renderLink(item, !collapsed))}
        <div className={cn("flex items-center mt-2", collapsed ? "justify-center" : "justify-between px-1")}>
          <ThemeToggle />
          <button
            onClick={toggleCollapsed}
            className="p-1.5 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-all duration-200 hover:scale-110"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </nav>
  );

  // Mobile bottom bar
  const mobileBar = (
    <nav aria-label="Mobile navigation" className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-sidebar border-t border-sidebar-border">
      <div className="flex items-center justify-around h-14">
        {mobileBarItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center gap-0.5 py-1 px-3 text-[10px] font-medium transition-colors",
                isActive ? "text-sidebar-primary" : "text-sidebar-foreground/50"
              )}
            >
              <item.icon className={cn("h-5 w-5", isActive && item.color)} />
              {item.label}
            </Link>
          );
        })}
        <button
          onClick={() => { setMobileOpen(!mobileOpen); setMobileAccountOpen(false); }}
          aria-expanded={mobileOpen}
          aria-label="Show all pages"
          className={cn(
            "flex flex-col items-center gap-0.5 py-1 px-3 text-[10px] font-medium transition-colors",
            mobileOpen ? "text-sidebar-primary" : "text-sidebar-foreground/50"
          )}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <MoreHorizontal className="h-5 w-5" />}
          More
        </button>
        <button
          onClick={() => { setMobileAccountOpen(!mobileAccountOpen); setMobileOpen(false); }}
          aria-expanded={mobileAccountOpen}
          aria-label="Account menu"
          className={cn(
            "flex flex-col items-center gap-0.5 py-1 px-3 text-[10px] font-medium transition-colors",
            mobileAccountOpen ? "text-sidebar-primary" : "text-sidebar-foreground/50"
          )}
        >
          <User className={cn("h-5 w-5", mobileAccountOpen && "text-violet-400")} />
          Account
        </button>
      </div>
    </nav>
  );

  // Mobile slide-up panel (all pages)
  const mobilePanel = mobileOpen && (
    <div className="md:hidden fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      <div className="absolute bottom-14 left-0 right-0 bg-sidebar border-t border-sidebar-border rounded-t-xl max-h-[70vh] overflow-y-auto p-4 space-y-1 animate-in slide-in-from-bottom duration-200">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-sidebar-foreground">All Pages</span>
          <ThemeToggle />
        </div>
        {allFlatItems
          .filter((item) => !mobileBarItems.some((m) => m.href === item.href))
          .filter((item) => devMode || item.mode !== "dev")
          .filter((item) => item.href !== "/admin" || isAdmin)
          .map((item) => renderLink(item, true))}
      </div>
    </div>
  );

  // Mobile account panel
  const mobileAccountPanel = mobileAccountOpen && (
    <div className="md:hidden fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/50" onClick={() => setMobileAccountOpen(false)} aria-hidden="true" />
      <div className="absolute bottom-14 left-0 right-0 bg-sidebar border-t border-sidebar-border rounded-t-xl p-4 space-y-1 animate-in slide-in-from-bottom duration-200">
        <div className="flex items-center gap-3 mb-3 px-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-primary/20">
            {hostingMode === "managed" ? (
              <Cloud className="h-4 w-4 text-sidebar-primary" />
            ) : (
              <HardDrive className="h-4 w-4 text-sidebar-primary" />
            )}
          </div>
          <div>
            <span className="text-sm font-semibold text-sidebar-foreground">
              {hostingMode === "managed" ? "Cloud Mode" : "Self-Hosted Mode"}
            </span>
          </div>
        </div>
        <a
          href="/"
          onClick={() => setMobileAccountOpen(false)}
          className="flex items-center gap-3 rounded-lg px-3 py-3 text-[14px] font-medium text-sidebar-foreground/70 hover:bg-white/[0.06] hover:text-sidebar-foreground transition-colors"
        >
          <ArrowRightLeft className="h-5 w-5" />
          Switch Mode
        </a>
        <button
          onClick={() => { setMobileAccountOpen(false); handleSignOut(); }}
          className="flex items-center gap-3 rounded-lg px-3 py-3 text-[14px] font-medium text-sidebar-foreground/70 hover:bg-white/[0.06] hover:text-sidebar-foreground transition-colors w-full"
        >
          <LogOut className="h-5 w-5" />
          Sign Out
        </button>
      </div>
    </div>
  );

  return (
    <>
      {sidebar}
      {mobileBar}
      {mobilePanel}
      {mobileAccountPanel}
    </>
  );
}
