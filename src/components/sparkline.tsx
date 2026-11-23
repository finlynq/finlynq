"use client";

import { AreaChart, Area, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { formatCurrency, getMonthLabel } from "@/lib/currency";

type SparklineProps = {
  data: number[];
  color: string;
  /**
   * Optional point labels, parallel to `data`. When provided the sparkline
   * becomes interactive: hovering a point shows a tooltip with that point's
   * value + date. Labels are "YYYY-MM" month keys (rendered via getMonthLabel).
   */
  labels?: string[];
  /** Currency used to format the tooltip value. */
  currency?: string;
  /**
   * Fill the parent's height instead of the fixed 30px (GH #434: the dashboard
   * Net Worth card draws its line across the whole tile).
   */
  fill?: boolean;
  /**
   * Y range. Omitted = from 0, as every stat-tile sparkline. Pass the data's
   * own range (niceDomain) where a change must be visible on a large value.
   */
  domain?: [number, number];
  /**
   * Classes for the drawn area (e.g. opacity). Set here rather than on a
   * wrapper: an opacity on the wrapper makes it a stacking context, which puts
   * the tooltip under any content layered above the chart (GH #446).
   */
  areaClassName?: string;
};

type SparkRow = { index: number; value: number; label?: string };

/** Compact value + date tooltip for the interactive sparkline. */
function SparklineTooltip({
  active,
  payload,
  color,
  currency,
}: {
  active?: boolean;
  payload?: { value: number; payload: SparkRow }[];
  color: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  const label = point.payload?.label;
  return (
    <div className="rounded-lg border border-border/50 bg-card/95 backdrop-blur-sm px-2.5 py-1.5 shadow-lg">
      {label && (
        <p className="text-[10px] font-medium text-muted-foreground mb-0.5">{getMonthLabel(label)}</p>
      )}
      <div className="flex items-center gap-1.5 text-xs font-semibold tabular-nums">
        {/* Dot color set via ref-callback to keep inline style= off the HTML (CSP). */}
        <span
          className="h-1.5 w-1.5 rounded-full shrink-0"
          ref={(el) => {
            if (el) el.style.background = color;
          }}
        />
        {formatCurrency(Number(point.value), currency)}
      </div>
    </div>
  );
}

export function Sparkline({ data, color, labels, currency = "USD", fill = false, domain, areaClassName }: SparklineProps) {
  const chartData: SparkRow[] = data.map((value, index) => ({ index, value, label: labels?.[index] }));
  const interactive = Boolean(labels?.length);

  return (
    <div className={fill ? "w-full h-full" : "w-full h-[30px]"}>
      <ResponsiveContainer width="100%" height={fill ? "100%" : 30} minWidth={0}>
        <AreaChart data={chartData} margin={fill ? { top: 0, right: 0, bottom: 0, left: 0 } : { top: 2, right: 2, bottom: 2, left: 2 }}>
          {domain && <YAxis hide domain={domain} />}
          <defs>
            <linearGradient id={`spark-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {interactive && (
            <Tooltip
              content={<SparklineTooltip color={color} currency={currency} />}
              cursor={{ stroke: color, strokeOpacity: 0.35, strokeWidth: 1 }}
              // The chart is only 30px tall and sits at the bottom of an
              // overflow-hidden card. Render the tooltip ABOVE the cursor
              // (escape + reverse on the Y axis) so it lands inside the card
              // body, and keep X inside the viewbox so it never clips the card
              // edges. A `fill` chart already covers its card, so its tooltip
              // stays inside the chart on both axes (GH #446). (Do NOT use the
              // `portal` prop — recharts then drops the positioning transform
              // entirely.)
              allowEscapeViewBox={{ x: false, y: !fill }}
              reverseDirection={{ x: false, y: !fill }}
              offset={8}
              wrapperStyle={{ zIndex: 50, pointerEvents: "none" }}
              isAnimationActive={false}
            />
          )}
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#spark-${color.replace("#", "")})`}
            isAnimationActive={false}
            className={areaClassName}
            activeDot={interactive ? { r: 3, stroke: color, strokeWidth: 1, fill: color } : false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
