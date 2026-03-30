"use client";

import { formatCurrency } from "@/lib/currency";

export function ChartTooltip({
  active,
  payload,
  label,
  currency = "CAD",
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  currency?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border/50 bg-card/95 backdrop-blur-sm px-3.5 py-2.5 shadow-lg">
      <p className="text-[11px] font-medium text-muted-foreground mb-1.5">{label}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <div className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
          <span className="text-muted-foreground text-xs">{entry.name}</span>
          <span className="font-semibold text-xs ml-auto tabular-nums">
            {formatCurrency(Number(entry.value), currency)}
          </span>
        </div>
      ))}
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
