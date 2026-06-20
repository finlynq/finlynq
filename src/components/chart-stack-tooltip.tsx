"use client";

/**
 * StackedAreaTooltip — the ONE shared tooltip for stacked-area "By account" /
 * "By holding" charts (FINLYNQ-192). Replaces the two near-identical custom
 * tooltips that lived in PerformanceChart (`StackTooltip`) and the recharts
 * DEFAULT `<Tooltip>` the Net Worth stacked branch used to render the
 * inconsistent `Name : value` text.
 *
 * It maps each `legend` band's key → its value at the hovered point, then
 * renders the shared `TooltipBreakdownList` (FINLYNQ-128) with a colored dot
 * per row (FINLYNQ-192) whose color matches the band fill + the legend chip.
 *
 * Row order MIRRORS the visual stack: the stack draws `legend[0]` (the largest
 * band) at the BOTTOM, so we reverse the legend (largest-first) to anchor the
 * largest row at the bottom of the tooltip too.
 *
 * `uncapped` (FINLYNQ-181) auto-sizes to the full list; `wide` (FINLYNQ-192)
 * drops the per-name truncation so full account/holding names read on one line.
 * The container width tracks `wide` so the widened tooltip doesn't overflow.
 */

import { formatCurrency } from "@/lib/currency";
import {
  TooltipBreakdownList,
  type BreakdownRow,
} from "@/components/chart-breakdown-list";
import type { StackLegendEntry } from "@/lib/chart-stack";

export function StackedAreaTooltip({
  active,
  payload,
  label,
  currency,
  legend,
  /** Heading text formatter applied to the hovered X label (e.g. a full date). */
  formatLabel,
  /** Optional bold total line above the breakdown (sum of all bands). */
  showTotal = false,
  /** Drop the per-name truncation + widen the container (FINLYNQ-192). */
  wide = false,
}: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number | string }[];
  label?: string;
  currency: string;
  legend: StackLegendEntry[];
  formatLabel?: (label: string) => string;
  showTotal?: boolean;
  wide?: boolean;
}) {
  if (!active || !payload?.length) return null;
  const valueByKey = new Map<string, number>();
  for (const entry of payload) {
    if (entry.dataKey != null) {
      valueByKey.set(String(entry.dataKey), Number(entry.value) || 0);
    }
  }
  // Stack-order rows: the largest band sits at the BOTTOM of the chart, so
  // reverse the legend (largest-first) to anchor the largest row at the bottom.
  const rows: BreakdownRow[] = [...legend]
    .reverse()
    .map((b) => ({ name: b.name, value: valueByKey.get(b.key) ?? 0, color: b.color }))
    .filter((r) => r.value !== 0);
  // The total is the signed sum of all bands at this point — with FINLYNQ-187
  // sign-split this equals the aggregate net-worth line (positives − liabilities).
  const total = rows.reduce((s, r) => s + r.value, 0);
  const heading = label != null ? (formatLabel ? formatLabel(label) : label) : "";
  return (
    <div
      className={`rounded-xl border border-border/50 bg-card/95 backdrop-blur-sm px-3.5 py-2.5 shadow-lg ${
        wide ? "max-w-[320px]" : "max-w-[260px]"
      }`}
    >
      {heading && (
        <p className="text-[11px] font-medium text-muted-foreground mb-1">{heading}</p>
      )}
      {showTotal && (
        <p className="text-sm font-semibold tabular-nums">
          {formatCurrency(total, currency)}
        </p>
      )}
      <TooltipBreakdownList rows={rows} currency={currency} uncapped wide={wide} />
    </div>
  );
}
