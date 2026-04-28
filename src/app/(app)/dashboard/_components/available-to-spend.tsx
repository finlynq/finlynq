"use client";

import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { Wallet } from "lucide-react";
import { motion } from "framer-motion";

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

type Props = {
  income: number;
  expenses: number;
  currency?: string;
};

export function AvailableToSpend({ income, expenses, currency = "CAD" }: Props) {
  const available = income - expenses;
  const pctSpent = income > 0 ? (expenses / income) * 100 : 0;

  return (
    <motion.div variants={itemVariants}>
      <Card className="h-full card-hover relative overflow-hidden">
        <div className="absolute -bottom-12 -right-12 w-32 h-32 rounded-full bg-cyan-500/5 blur-2xl pointer-events-none" />
        <CardContent className="relative pt-5 pb-5 px-5">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600 dark:bg-cyan-950/60 dark:text-cyan-400">
              <Wallet className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">Available to Spend</p>
              <p className="text-[11px] text-muted-foreground">This month remaining</p>
            </div>
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
              <span className="text-muted-foreground">Spent so far</span>
              <span className="font-semibold text-rose-500 tabular-nums">
                -{formatCurrency(expenses, currency)}
              </span>
            </div>
            <div className="border-t pt-2 flex justify-between text-[12px] font-semibold">
              <span>Remaining</span>
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
