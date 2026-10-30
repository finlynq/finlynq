"use client";

import { Clock } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import type { BudgetMonth } from "@/lib/budgets/month";
import { incomeAllocation, monthProgress, type AllocationKey } from "@/lib/budgets/month-view";

const SEGMENTS: Record<AllocationKey, { color: string; label: string }> = {
  spending: { color: "bg-primary", label: "Spending" },
  debt: { color: "bg-chart-4", label: "Debt payments" },
  left: { color: "bg-chart-2", label: "Left to plan" },
};

function StatRow({
  label,
  value,
  target,
  currency,
  pace,
  overIsBad,
}: {
  label: string;
  value: number;
  target: number;
  currency: string;
  /** Share of the month gone, drawn as a tick on the bar. */
  pace?: number;
  overIsBad?: boolean;
}) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  const over = target > 0 && value > target + 0.005;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">
          {formatCurrency(value, currency)}
          {target > 0 && <span className="text-muted-foreground"> of {formatCurrency(target, currency)}</span>}
        </span>
      </div>
      <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${over && overIsBad ? "bg-rose-500" : "bg-emerald-500"}`}
          style={{ width: `${pct}%` }}
        />
        {pace != null && pace > 0 && pace < 1 && (
          <div className="absolute inset-y-0 w-0.5 bg-foreground/70" style={{ left: `${pace * 100}%` }} title="Today" />
        )}
      </div>
    </div>
  );
}

/**
 * The month at a glance: what is left to plan out of expected income, where
 * that income goes, and how much has come in, been spent and been paid so far.
 */
export function MonthSummary({ data, ageOfMoney }: { data: BudgetMonth; ageOfMoney: number | null }) {
  const cur = data.currency;
  const s = data.summary;
  const fmt = (n: number) => formatCurrency(n, cur);
  const alloc = incomeAllocation(s);
  const progress = monthProgress(data.month, data.today);
  const hasIncome = s.plannedIncome > 0.005;
  const balanced = Math.abs(s.leftToPlan) <= 0.005;
  const tone = !hasIncome ? "" : s.leftToPlan < -0.005 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400";

  let sentence: React.ReactNode;
  if (!hasIncome) sentence = "Set expected income in the Income section to see how much of it is left to plan.";
  else if (balanced) sentence = `Every dollar of the ${fmt(s.plannedIncome)} you expect is planned.`;
  else if (s.leftToPlan > 0) sentence = `of the ${fmt(s.plannedIncome)} you expect isn't planned yet.`;
  else sentence = <span className="text-rose-600 dark:text-rose-400">more planned than the {fmt(s.plannedIncome)} you expect.</span>;

  const spentLabel =
    progress.state === "current" ? `Spent · day ${progress.day} of ${progress.days}` : progress.state === "future" ? "Spent · not started" : "Spent";
  const showDebt = data.debt.length > 0 || s.plannedDebt > 0;

  return (
    <section className="rounded-xl border bg-card p-4" aria-label="Month summary">
      <div className="grid gap-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] md:gap-8">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{hasIncome && s.leftToPlan < -0.005 ? "Over-planned" : "Left to plan"}</p>
          <p className={`hero-number text-3xl font-semibold ${tone}`}>
            {hasIncome && s.leftToPlan < -0.005 ? fmt(-s.leftToPlan) : fmt(hasIncome ? s.leftToPlan : 0)}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{sentence}</p>

          {alloc.segments.length > 0 && (
            <>
              <div className="relative mt-3 flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted">
                {alloc.segments.map((seg) => (
                  <div
                    key={seg.key}
                    className={`h-full ${SEGMENTS[seg.key].color}`}
                    style={{ width: `${seg.share * 100}%` }}
                    title={`${SEGMENTS[seg.key].label}: ${fmt(seg.amount)}`}
                  />
                ))}
                {alloc.overPlanned > 0 && alloc.incomeMark > 0 && (
                  <div
                    className="absolute inset-y-0 w-0.5 bg-rose-500"
                    style={{ left: `${alloc.incomeMark * 100}%` }}
                    title={`Expected income ends here: ${fmt(s.plannedIncome)}`}
                  />
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {alloc.segments.map((seg) => (
                  <span key={seg.key} className="inline-flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${SEGMENTS[seg.key].color}`} />
                    <span className="text-muted-foreground">{SEGMENTS[seg.key].label}</span>
                    <span className="font-mono tabular-nums">{fmt(seg.amount)}</span>
                  </span>
                ))}
                {alloc.overPlanned > 0 && hasIncome && (
                  <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
                    <span className="h-2 w-0.5 bg-rose-500" />
                    Over by <span className="font-mono tabular-nums">{fmt(alloc.overPlanned)}</span>
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        <div className="min-w-0 space-y-3 md:border-l md:pl-8">
          <StatRow label="Income received" value={s.receivedIncome} target={s.plannedIncome} currency={cur} />
          <StatRow label={spentLabel} value={s.spent} target={s.plannedSpending} currency={cur} pace={progress.fraction} overIsBad />
          {showDebt && <StatRow label="Debt paid" value={s.paidDebt} target={s.plannedDebt} currency={cur} />}
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5 text-xs text-muted-foreground">
            <span>
              Net so far{" "}
              <span
                className={`font-mono tabular-nums ${s.netCashFlow < -0.005 ? "text-rose-600 dark:text-rose-400" : "text-foreground"}`}
              >
                {s.netCashFlow > 0.005 ? "+" : ""}
                {fmt(s.netCashFlow)}
              </span>
            </span>
            {s.upcoming > 0.005 && (
              <span>
                <span className="font-mono tabular-nums text-foreground">{fmt(s.upcoming)}</span> still due this month
              </span>
            )}
            {ageOfMoney != null && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" /> Age of money {ageOfMoney} days
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
