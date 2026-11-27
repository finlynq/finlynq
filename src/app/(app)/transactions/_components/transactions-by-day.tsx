"use client";

/**
 * "By day" view of the Transactions page (GH #465): the same filtered, paged
 * rows as the List view, grouped under one header per day. Each header shows
 * the day's transaction count and its income / spending / net, totalled over
 * the WHOLE day under the current filters (GET /api/transactions?dayTotals=1,
 * see lib/transactions/day-totals.ts), so a day that runs onto the next page
 * shows the same full total on both pages. Clicking a row opens the same edit
 * flow as the List view.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { AccountAvatar, useAccountLogos } from "@/components/accounts/account-logo";
import { formatCurrency } from "@/lib/currency";
import { formatAccountLabel } from "@/lib/account-label";
import {
  formatDayHeading,
  groupTransactionsByDay,
  signedMoney,
  sumDayTotals,
  type DayTotal,
  type DayTotalsPayload,
} from "@/lib/transactions/by-day";
import { ChevronDown, ChevronRight, Link2, Receipt } from "lucide-react";
import { getCategoryBadgeClass } from "./transaction-table";
import type { Transaction } from "../_types";

/** "In +$1,200.00 · Out −$84.10 · Net +$1,115.90", leaving out what is zero. */
function MoneyParts({ income, spending, currency }: { income: number; spending: number; currency: string }) {
  const parts: ReactNode[] = [];
  if (income !== 0) {
    parts.push(
      <span key="in" className="text-emerald-600 dark:text-emerald-400">
        In {signedMoney(income, currency)}
      </span>,
    );
  }
  if (spending > 0) {
    parts.push(
      <span key="out" className="text-rose-600 dark:text-rose-400">
        Out {signedMoney(-spending, currency)}
      </span>,
    );
  } else if (spending < 0) {
    // Refunds outweighed purchases that day: say so instead of "Out +$X".
    parts.push(
      <span key="out" className="text-emerald-600 dark:text-emerald-400">
        Refunds {signedMoney(-spending, currency)}
      </span>,
    );
  }
  if (income !== 0 && spending !== 0) {
    parts.push(
      <span key="net" className="font-semibold text-foreground">
        Net {signedMoney(income - spending, currency)}
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className="whitespace-nowrap">
          <span className="mx-1.5 text-muted-foreground/60" aria-hidden>·</span>
          {p}
        </span>
      ))}
    </>
  );
}

function ByDaySkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border/50 bg-card">
          <div className="h-10 border-b border-border/50 bg-muted/40 rounded-t-xl" />
          {Array.from({ length: 3 }).map((__, j) => (
            <div key={j} className="flex items-center gap-3 px-4 py-3">
              <div className="h-6 w-6 rounded bg-muted animate-pulse" />
              <div className="h-4 w-40 rounded bg-muted animate-pulse" />
              <div className="h-4 w-20 rounded bg-muted animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function TransactionsByDay({
  loading,
  txns,
  dayTotals,
  sortAscending,
  sortOverridden,
  onEdit,
}: {
  loading: boolean;
  /** The current page of rows, already in date order. */
  txns: Transaction[];
  /** Whole-day totals for the days on this page; null while loading or unavailable. */
  dayTotals: DayTotalsPayload | null;
  /** The user sorted by date, oldest first. */
  sortAscending: boolean;
  /** The user had a non-date sort, which this view sets aside. */
  sortOverridden: boolean;
  onEdit: (t: Transaction) => void;
}) {
  const { versions: logoVersions } = useAccountLogos();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => groupTransactionsByDay(txns), [txns]);
  const totalsByDate = useMemo(() => {
    const map = new Map<string, DayTotal>();
    for (const d of dayTotals?.days ?? []) map.set(d.date, d);
    return map;
  }, [dayTotals]);
  const currency = dayTotals?.displayCurrency ?? "USD";
  const pageDays = useMemo(
    () => groups.map((g) => totalsByDate.get(g.date)).filter((d): d is DayTotal => d != null),
    [groups, totalsByDate],
  );
  const pageSum = sumDayTotals(pageDays);

  if (loading && txns.length === 0) return <ByDaySkeleton />;
  if (txns.length === 0) {
    return (
      <div className="rounded-xl border border-border/50 bg-card">
        <EmptyState
          icon={Receipt}
          title="No transactions"
          description="Nothing matches these filters. Clear a filter or import bank statements to get started."
          action={{ label: "Import data", href: "/import" }}
        />
      </div>
    );
  }

  const toggle = (date: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Grouped by day, {sortAscending ? "oldest" : "newest"} first.
        {sortOverridden && " Your column sort applies in the List view."}
        {" "}Day totals count income and spending in {currency}; transfers, trades and uncategorized rows are counted but not added.
      </p>

      {groups.map((g) => {
        const day = totalsByDate.get(g.date);
        const count = day?.count ?? g.rows.length;
        const isCollapsed = collapsed.has(g.date);
        const onOtherPages = count - g.rows.length;
        return (
          <section key={g.date} className="rounded-xl border border-border/50 bg-card" aria-label={formatDayHeading(g.date)}>
            <button
              type="button"
              onClick={() => toggle(g.date)}
              aria-expanded={!isCollapsed}
              className={`sticky top-0 z-10 flex w-full items-start gap-2 bg-muted/90 px-3 py-2 text-left text-sm backdrop-blur supports-[backdrop-filter]:bg-muted/75 sm:px-4 ${isCollapsed ? "rounded-xl" : "rounded-t-xl border-b border-border/50"}`}
            >
              {isCollapsed ? (
                <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 leading-6">
                <span className="font-semibold">{formatDayHeading(g.date)}</span>
                <span className="whitespace-nowrap">
                  <span className="mx-1.5 text-muted-foreground/60" aria-hidden>·</span>
                  <span className="text-muted-foreground">
                    {count} transaction{count === 1 ? "" : "s"}
                    {onOtherPages > 0 && ` (${g.rows.length} on this page)`}
                  </span>
                </span>
                {day && <MoneyParts income={day.income} spending={day.spending} currency={currency} />}
              </span>
            </button>

            {!isCollapsed && (
              <ul className="divide-y divide-border/50">
                {g.rows.map((t) => {
                  const enteredAmt = t.enteredAmount ?? t.amount;
                  const enteredCcy = t.enteredCurrency ?? t.currency;
                  const accountLabel = formatAccountLabel({ name: t.accountName, alias: t.accountAlias, type: t.accountType });
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => onEdit(t)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:outline-none sm:px-4"
                      >
                        <AccountAvatar
                          accountId={t.accountId}
                          name={t.accountName}
                          logoVersion={logoVersions[t.accountId]}
                          className="h-7 w-7 rounded-md text-xs"
                          letterClassName="bg-muted text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {t.payee || t.portfolioHolding || t.note || "No payee"}
                          </span>
                          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                            {t.categoryName ? (
                              <Badge variant="outline" className={`shrink-0 text-[10px] ${getCategoryBadgeClass(t.categoryType)}`}>
                                {t.categoryName}
                              </Badge>
                            ) : (
                              <span className="shrink-0 italic">Uncategorized</span>
                            )}
                            {t.linkId && <Link2 className="h-3 w-3 shrink-0 text-sky-500" aria-label="Linked transaction" />}
                            <span className="truncate">{accountLabel}</span>
                          </span>
                        </span>
                        <span className={`shrink-0 text-right font-mono text-sm font-semibold ${t.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          <span className="block">{formatCurrency(enteredAmt, enteredCcy)}</span>
                          {enteredCcy !== t.currency && (
                            <span className="block text-[10px] font-normal text-muted-foreground">
                              → {formatCurrency(t.amount, t.currency)}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      {pageDays.length > 1 && (
        <div className="rounded-xl border border-dashed border-border/70 px-3 py-2 text-sm sm:px-4">
          <span className="font-medium">
            {pageDays.length} days on this page
          </span>
          <span className="whitespace-nowrap">
            <span className="mx-1.5 text-muted-foreground/60" aria-hidden>·</span>
            <span className="text-muted-foreground">
              {pageSum.count} transaction{pageSum.count === 1 ? "" : "s"}
            </span>
          </span>
          <MoneyParts income={pageSum.income} spending={pageSum.spending} currency={currency} />
        </div>
      )}
    </div>
  );
}
