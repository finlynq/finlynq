"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, getMonthLabel } from "@/lib/currency";
import {
  SPEND_MONTH_STORAGE_KEY,
  parseSpendMonthMode,
  type SpendMonthFigures,
  type SpendMonthMode,
} from "@/lib/dashboard/spend-month";
import { ArrowLeftRight, Wallet } from "lucide-react";
import { motion } from "framer-motion";

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

type Props = {
  /** Last complete month; null when there is none yet (then only the current month shows). */
  last: SpendMonthFigures | null;
  /** The current month so far. */
  current: SpendMonthFigures;
  currency?: string;
};

function readStoredMode(): SpendMonthMode {
  try {
    return parseSpendMonthMode(window.localStorage.getItem(SPEND_MONTH_STORAGE_KEY));
  } catch {
    return "last";
  }
}

/**
 * GH #447: shows the last complete month (closed figures, worded as such) or
 * the current month so far, switched on the card and remembered per browser.
 */
export function AvailableToSpend({ last, current, currency = "USD" }: Props) {
  const [mode, setMode] = useState<SpendMonthMode>(readStoredMode);

  function choose(next: SpendMonthMode) {
    setMode(next);
    try {
      window.localStorage.setItem(SPEND_MONTH_STORAGE_KEY, next);
    } catch {
      // Storage blocked: the choice still applies until the page reloads.
    }
  }

  const showingCurrent = mode === "current" || !last;
  const figures = showingCurrent ? current : last;
  const { income, expenses } = figures;
  const monthLabel = getMonthLabel(figures.month);
  const available = income - expenses;
  const pctSpent = income > 0 ? (expenses / income) * 100 : 0;

  const subtitle = showingCurrent ? `${monthLabel} so far` : `Left over in ${monthLabel}`;
  const spentLabel = showingCurrent ? "Spent so far" : "Spent";
  const totalLabel = showingCurrent ? "Remaining" : "Left over";
  const switchLabel = showingCurrent ? "Show last month" : "Show this month";

  return (
    <motion.div variants={itemVariants}>
      <Card className="h-full card-hover relative overflow-hidden">
        <div className="absolute -bottom-12 -right-12 w-32 h-32 rounded-full bg-cyan-500/5 blur-2xl pointer-events-none" />
        <CardContent className="relative pt-5 pb-5 px-5">
          {/* flex-wrap: in the 3-column row at lg the card is ~225px, so the
              switch drops to its own line when title + switch don't fit. */}
          <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600 dark:bg-cyan-950/60 dark:text-cyan-400">
                <Wallet className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">Available to Spend</p>
                <p className="text-[11px] text-muted-foreground">{subtitle}</p>
              </div>
            </div>
            {last && (
              <div className="flex items-center gap-1">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={switchLabel}
                  title={switchLabel}
                  onClick={() => choose(showingCurrent ? "last" : "current")}
                >
                  <ArrowLeftRight />
                </Button>
                <span className="text-[11px] font-medium text-muted-foreground" data-testid="spend-month-shown">
                  {showingCurrent ? "This month" : "Last month"}
                </span>
              </div>
            )}
          </div>

          <p className={`text-3xl font-bold tracking-tight tabular-nums ${available >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"}`}>
            {formatCurrency(Math.abs(available), currency)}
          </p>

          <div className="mt-4 space-y-2">
            <div className="flex justify-between text-[12px]">
              <span className="text-muted-foreground">Income</span>
              <span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                {formatCurrency(income, currency)}
              </span>
            </div>
            <div className="flex justify-between text-[12px]">
              <span className="text-muted-foreground">{spentLabel}</span>
              <span className="font-semibold text-rose-500 tabular-nums">
                -{formatCurrency(expenses, currency)}
              </span>
            </div>
            <div className="border-t pt-2 flex justify-between text-[12px] font-semibold">
              <span>{totalLabel}</span>
              <span className={`tabular-nums ${available >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"}`}>
                {formatCurrency(available, currency)}
              </span>
            </div>
          </div>

          {/* Progress bar */}
          {income > 0 && (
            <>
              <div className="w-full bg-muted/50 rounded-full h-2 overflow-hidden mt-3">
                <motion.div
                  className={`h-full rounded-full ${pctSpent > 100 ? "bg-rose-500" : pctSpent > 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, pctSpent)}%` }}
                  transition={{ duration: 1, ease: "easeOut", delay: 0.5 }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground text-center mt-1.5 tabular-nums">
                {Math.round(pctSpent)}% of income spent
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
