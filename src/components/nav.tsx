"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
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
  Inbox,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FinlynqLogo } from "@/components/FinlynqLogo";

type NavItem = { href: string; label: string; icon: LucideIcon; color: string; mode?: "prod" | "dev" };

// Single-accent system: active items glow amber (`text-primary`) to match the
// landing's restraint. Inactive icons use the sidebar-foreground muted tones.
const ACTIVE_ACCENT = "text-primary";

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, color: ACTIVE_ACCENT, mode: "prod" },
      { href: "/mcp-guide", label: "MCP Guide", icon: Bot, color: ACTIVE_ACCENT, mode: "prod" },
      { href: "/chat", label: "AI Chat", icon: MessageSquare, color: ACTIVE_ACCENT, mode: "dev" },
    ],
  },
  {
    label: "Tracking",
    items: [
      { href: "/transactions", label: "Transactions", icon: ArrowLeftRight, color: ACTIVE_ACCENT, mode: "prod" },
      { href: "/budgets", label: "Budgets", icon: PiggyBank, color: ACTIVE_ACCENT, mode: "prod" },
      { href: "/goals", label: "Goals", icon: Target, color: ACTIVE_ACCENT, mode: "prod" },
      { href: "/subscriptions", label: "Subscriptions", icon: CreditCard, color: ACTIVE_ACCENT, mode: "dev" },
      { href: "/calendar", label: "Calendar", icon: CalendarDays, color: ACTIVE_ACCENT, mode: "dev" },
    ],
  },
  {
    label: "Wealth",
    items: [
      { href: "/accounts", label: "Accounts", icon: Wallet, color: ACTIVE_ACCENT, mode: "prod" },
      { href: "/portfolio", label: "Portfolio", icon: TrendingUp, color: ACTIVE_ACCENT, mode: "prod" },
      { href: "/loans", label: "Loans & Debt", icon: Landmark, color: ACTIVE_ACCENT, mode: "dev" },
    ],
  },
  {
    label: "Analysis",
    items: [
      { href: "/reports", label: "Reports", icon: FileText, color: ACTIVE_ACCENT, mode: "prod" },
      { href: "/tax", label: "Tax", icon: Calculator, color: ACTIVE_ACCENT, mode: "dev" },
    ],
  },
  {
    label: "Planning",
    items: [
      { href: "/scenarios", label: "Scenarios", icon: GitBranch, color: ACTIVE_ACCENT, mode: "dev" },
      { href: "/fire", label: "FIRE Calculator", icon: FlameKindling, color: ACTIVE_ACCENT, mode: "dev" },
    ],
  },
];

const toolLinks: NavItem[] = [
  { href: "/import", label: "Import", icon: Upload, color: ACTIVE_ACCENT, mode: "prod" },
  { href: "/api-docs", label: "API Docs", icon: FileText, color: ACTIVE_ACCENT, mode: "dev" },
  { href: "/admin", label: "Admin", icon: ShieldCheck, color: ACTIVE_ACCENT, mode: "prod" },
  { href: "/admin/inbox", label: "Admin Inbox", icon: Inbox, color: ACTIVE_ACCENT, mode: "prod" },
  { href: "/settings", label: "Settings", icon: Settings, color: ACTIVE_ACCENT, mode: "prod" },
];

const mobileBarItems: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard, color: ACTIVE_ACCENT },
  { href: "/transactions", label: "Txns", icon: ArrowLeftRight, color: ACTIVE_ACCENT },
  { href: "/import", label: "Import", icon: Upload, color: ACTIVE_ACCENT },
  { href: "/budgets", label: "Budgets", icon: PiggyBank, color: ACTIVE_ACCENT },
];

const allFlatItems = navGroups.flatMap((g) => g.items).concat(toolLinks);

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [devMode, setDevMode] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const handleSignOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  };

  useEffect(() => {
    const saved = localStorage.getItem("pf-sidebar-collapsed");
    if (saved === "true") setCollapsed(true);
    const groups: Record<string, boolean> = {};
    navGroups.forEach((g) => { if (g.label) groups[g.label] = true; });
    setOpenGroups(groups);
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        setIsAdmin(data.isAdmin === true);
      })
      .catch(() => {});
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
        {toolLinks.filter((item) => (devMode || item.mode !== "dev") && (!item.href.startsWith("/admin") || isAdmin)).map((item) => renderLink(item, !collapsed))}
        <button
          onClick={handleSignOut}
          title={collapsed ? "Sign out" : undefined}
          className={cn(
            "group/link relative flex items-center gap-3 rounded-lg text-[13px] font-medium transition-all duration-200 w-full",
            collapsed ? "px-0 py-2 justify-center" : "px-3 py-2",
            "text-sidebar-foreground/50 hover:bg-white/[0.05] hover:text-sidebar-foreground"
          )}
        >
          <LogOut className="h-[18px] w-[18px] shrink-0 text-sidebar-foreground/40 group-hover/link:text-sidebar-foreground/70 group-hover/link:scale-110 transition-all duration-200" />
          {!collapsed && <span className="truncate">Sign out</span>}
        </button>
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
          onClick={() => setMobileOpen(!mobileOpen)}
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
      </div>
    </nav>
  );

  // Mobile slide-up panel (all pages + sign out)
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
          .filter((item) => !item.href.startsWith("/admin") || isAdmin)
          .map((item) => renderLink(item, true))}
        <button
          onClick={() => { setMobileOpen(false); handleSignOut(); }}
          className="group/link relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-sidebar-foreground/50 hover:bg-white/[0.05] hover:text-sidebar-foreground transition-all duration-200 w-full"
        >
          <LogOut className="h-[18px] w-[18px] shrink-0 text-sidebar-foreground/40 group-hover/link:text-sidebar-foreground/70 transition-all duration-200" />
          <span className="truncate">Sign out</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {sidebar}
      {mobileBar}
      {mobilePanel}
    </>
  );
}
