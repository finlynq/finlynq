"use client";

/**
 * /settings shared layout — left-nav shell that wraps every /settings/*
 * sub-page (issue #57). The 1573-line monolith was split into 8 grouped
 * sub-pages; this layout is what makes them feel like one section.
 *
 * - md+ : vertical left nav (~220px) + content slot.
 * - <md : horizontal scrollable pill row above the content.
 *
 * Active state mirrors the global app sidebar idiom (`pf-app/src/components/nav.tsx`):
 * amber left-edge marker + `bg-white/[0.08]` highlight.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Settings2,
  Shield,
  Database,
  Tag,
  Briefcase,
  Sliders,
  Server,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type NavItem = { href: string; label: string; icon: LucideIcon };

// Order matches issue #57 — Developer last per user decision.
const NAV_ITEMS: NavItem[] = [
  { href: "/settings/general", label: "General", icon: Settings2 },
  { href: "/settings/account", label: "Account & Security", icon: Shield },
  { href: "/settings/data", label: "Data", icon: Database },
  { href: "/settings/categorization", label: "Categorization", icon: Tag },
  { href: "/settings/investments", label: "Investments", icon: Briefcase },
  { href: "/settings/display", label: "Display & Ordering", icon: Sliders },
  { href: "/settings/integrations", label: "Integrations", icon: Server },
  { href: "/settings/developer", label: "Developer", icon: Wrench },
];

// Map legacy sub-routes to their group so deep links highlight the right
// nav entry without us having to add them as nav items.
const ROUTE_GROUP: Array<{ prefix: string; group: string }> = [
  { prefix: "/settings/holding-accounts", group: "/settings/investments" },
  { prefix: "/settings/dropdown-order", group: "/settings/display" },
];

function activeHref(pathname: string): string {
  for (const { prefix, group } of ROUTE_GROUP) {
    if (pathname.startsWith(prefix)) return group;
  }
  // Bare /settings -> redirect handles it, but also light up General as a
  // sensible fallback if the redirect hasn't landed yet on the first paint.
  if (pathname === "/settings") return "/settings/general";
  // Match the most specific nav item that prefixes the current pathname.
  let best: string | null = null;
  for (const item of NAV_ITEMS) {
    if (pathname === item.href || pathname.startsWith(item.href + "/")) {
      if (!best || item.href.length > best.length) best = item.href;
    }
  }
  return best ?? "";
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const active = activeHref(pathname);

  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-8">
      {/* Mobile pill row */}
      <nav
        aria-label="Settings sections"
        className="md:hidden -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
      >
        <div className="flex gap-2 overflow-x-auto pb-2">
          {NAV_ITEMS.map((item) => {
            const isActive = item.href === active;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "shrink-0 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  isActive
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Desktop left nav */}
      <aside
        aria-label="Settings sections"
        className="hidden md:block w-56 shrink-0"
      >
        <div className="sticky top-6">
          <p className="px-3 mb-2 text-[10px] font-semibold tracking-widest uppercase text-muted-foreground">
            Settings
          </p>
          <nav className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const isActive = item.href === active;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "group/link relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all duration-200",
                    isActive
                      ? "bg-white/[0.08] text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                  )}
                >
                  {isActive && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full bg-primary shadow-[0_0_8px_2px] shadow-primary/30" />
                  )}
                  <item.icon
                    className={cn(
                      "h-[16px] w-[16px] shrink-0 transition-colors",
                      isActive ? "text-primary" : "text-muted-foreground/70 group-hover/link:text-foreground"
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </aside>

      {/* Content slot */}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
