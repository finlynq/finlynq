"use client";

/**
 * TooltipBreakdownList — the shared "top-10 member breakdown" block appended to
 * chart tooltips (FINLYNQ-128). Renders a ranked list of contributors with
 * names + currency-formatted values, capped in height and scrollable so it
 * never overflows a small viewport (tc-4).
 *
 * The breakdown is PRE-RANKED by the API (top-10 + a single "Other" residual
 * via `rankBreakdown` in src/lib/chart-breakdown.ts) — this component only
 * renders. Reused by the Net Worth and Income vs Expenses tooltips, and is the
 * intended render target for FINLYNQ-129's stacked-member view legend.
 *
 * The default keeps the `max-h-40` cap + inner scroll (small-viewport safety for
 * the dashboard sparkline / Net Worth / Income-Expenses tooltips). Pass
 * `uncapped` to drop the cap so the list auto-sizes to its full content — used
 * ONLY by the Performance chart's StackTooltip (FINLYNQ-181), where clipping the
 * holdings list behind an inner scrollbar was the reported bug.
 */

import { formatCurrency } from "@/lib/currency";

export interface BreakdownRow {
  name: string;
  value: number;
  /**
   * FINLYNQ-192 — optional band/legend color. When present, a colored dot is
   * rendered before the name so the tooltip, chart band, and legend chip agree.
   * Omitted = no dot (legacy consumers stay byte-identical).
   */
  color?: string;
}

export function TooltipBreakdownList({
  rows,
  currency,
  /** Heading above the list, e.g. "By account" / "By category". */
  heading,
  /**
   * Drop the `max-h-40` height cap + inner scroll so the list auto-sizes to its
   * full content. Default `false` preserves the capped+scrollable behavior that
   * the dashboard sparkline / Net Worth / Income-Expenses tooltips rely on for
   * small-viewport safety. Opt in ONLY from the Performance StackTooltip
   * (FINLYNQ-181).
   */
  uncapped = false,
  /**
   * FINLYNQ-192 — raise/remove the per-name truncation so full names read on one
   * line. Opt in ONLY for the widened stacked tooltip; default keeps the
   * `max-w-[140px]` clamp the dashboard / Income-Expenses consumers rely on.
   */
  wide = false,
}: {
  rows: BreakdownRow[] | undefined;
  currency: string;
  heading?: string;
  uncapped?: boolean;
  wide?: boolean;
}) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="mt-2 border-t border-border/40 pt-2">
      {heading && (
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">
          {heading}
        </p>
      )}
      {/* Cap height so a long list scrolls instead of running off small screens,
          UNLESS `uncapped` — then auto-size to show the full list (FINLYNQ-181). */}
      <div className={uncapped ? "pr-1 space-y-0.5" : "max-h-40 overflow-y-auto pr-1 space-y-0.5"}>
        {rows.map((r, i) => (
          <div key={`${r.name}-${i}`} className="flex items-center gap-3 text-xs">
            {/* FINLYNQ-192 — colored dot only when a color is supplied; set via
                ref-callback so no inline style attribute hits the HTML (CSP). */}
            {r.color != null && (
              <span
                className="h-2 w-2 rounded-full shrink-0"
                ref={(el) => {
                  if (el && r.color) el.style.backgroundColor = r.color;
                }}
              />
            )}
            <span
              className={
                wide
                  ? "text-muted-foreground"
                  : "text-muted-foreground truncate max-w-[140px]"
              }
              title={r.name}
            >
              {r.name}
            </span>
            <span className="font-medium tabular-nums ml-auto whitespace-nowrap">
              {formatCurrency(Number(r.value), currency)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
