"use client";

import { formatCurrency } from "@/lib/currency";
import { TooltipBreakdownList, type BreakdownRow } from "@/components/chart-breakdown-list";

/** The data row Recharts hands back on each payload entry's `.payload`. */
type IncomeExpenseRow = {
  incomeBreakdown?: BreakdownRow[];
  expenseBreakdown?: BreakdownRow[];
};

export function ChartTooltip({
  active,
  payload,
  label,
  currency = "CAD",
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string; dataKey?: string; payload?: IncomeExpenseRow }[];
  label?: string;
  currency?: string;
}) {
  if (!active || !payload?.length) return null;
  // The data row is shared across series entries; read the breakdown once.
  const row = payload[0]?.payload;
  return (
    <div className="rounded-xl border border-border/50 bg-card/95 backdrop-blur-sm px-3.5 py-2.5 shadow-lg max-w-[260px]">
      <p className="text-[11px] font-medium text-muted-foreground mb-1.5">{label}</p>
      {payload.map((entry, i) => {
        // FINLYNQ-128 — append the per-category breakdown beneath the series
        // total it decomposes (income → incomeBreakdown, expenses → expenseBreakdown).
        const isIncome = entry.dataKey === "income";
        const breakdown = isIncome ? row?.incomeBreakdown : row?.expenseBreakdown;
        return (
          <div key={i}>
            <div className="flex items-center gap-2 text-sm">
              {/* Dot color set via ref-callback to keep inline `style=` off the HTML (CSP, FINLYNQ-83) */}
              <div
                className="h-2 w-2 rounded-full"
                ref={(el) => {
                  if (el) el.style.background = entry.color;
                }}
              />
              <span className="text-muted-foreground text-xs">{entry.name}</span>
              <span className="font-semibold text-xs ml-auto tabular-nums">
                {formatCurrency(Number(entry.value), currency)}
              </span>
            </div>
            <TooltipBreakdownList rows={breakdown} currency={currency} />
          </div>
        );
      })}
    </div>
  );
}

export function PieTooltip({
  active,
  payload,
  currency = "CAD",
}: {
  active?: boolean;
  payload?: { name: string; value: number; payload: { name: string } }[];
  currency?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border/50 bg-card/95 backdrop-blur-sm px-3.5 py-2.5 shadow-lg">
      <p className="text-[11px] font-semibold mb-0.5">{payload[0].payload.name}</p>
      <p className="text-sm font-bold tabular-nums">{formatCurrency(Number(payload[0].value), currency)}</p>
    </div>
  );
}
