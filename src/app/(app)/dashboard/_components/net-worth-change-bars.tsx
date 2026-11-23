"use client";

/**
 * Net Worth hero chart (GH #434): one bar per month for how much net worth
 * changed that month, green up and red down, anchored at 0. Replaces the 30px
 * sparkline of net worth itself, which drew a $15k drop on a $560k balance as
 * a nearly flat line.
 */
import { BarChart, Bar, Cell, ReferenceLine, ResponsiveContainer, Tooltip } from "recharts";
import { CHART_COLORS } from "@/lib/chart-colors";
import { formatCurrency, getMonthLabel } from "@/lib/currency";
import { monthlyChanges, type MonthlyChange } from "@/lib/net-worth-changes";

function ChangeTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: { payload: MonthlyChange }[];
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const { month, change } = payload[0].payload;
  return (
    <div className="rounded-lg border border-border/50 bg-card/95 backdrop-blur-sm px-2.5 py-1.5 shadow-lg">
      <p className="text-[10px] font-medium text-muted-foreground mb-0.5">{getMonthLabel(month)}</p>
      <p
        className={`text-xs font-semibold tabular-nums ${
          change >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
        }`}
      >
        {change >= 0 ? "+" : ""}
        {formatCurrency(change, currency)}
      </p>
    </div>
  );
}

export function NetWorthChangeBars({
  values,
  months,
  currency,
}: {
  values: number[];
  months: string[];
  currency: string;
}) {
  const data = monthlyChanges(values, months);
  if (data.length === 0) return null;
  return (
    <div className="w-full">
      <p className="text-[10px] font-medium text-muted-foreground mb-1">
        Monthly change, last {data.length} {data.length === 1 ? "month" : "months"}
      </p>
      <div className="h-16 w-full">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
            <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.25} />
            <Tooltip
              content={<ChangeTooltip currency={currency} />}
              cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ zIndex: 50, pointerEvents: "none" }}
              isAnimationActive={false}
            />
            <Bar dataKey="change" radius={[2, 2, 2, 2]} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.month} fill={d.change >= 0 ? CHART_COLORS.positive : CHART_COLORS.negative} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
