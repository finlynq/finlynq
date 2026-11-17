"use client";

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { CHART_COLORS } from "@/lib/chart-colors";
import { formatCurrency } from "@/lib/currency";
import {
  buildCashFlowColumns,
  type CashFlowItem,
  type CashFlowNode,
} from "@/lib/reports/cash-flow-sankey";

type SankeyChartProps = {
  incomeData: CashFlowItem[];
  expenseData: CashFlowItem[];
  currency?: string;
};

type HoverInfo = {
  x: number;
  y: number;
  /** Highlight key: the node or link under the pointer. */
  key: string;
  title: string;
  amount: number;
  percentage: number;
} | null;

type PlacedNode = CashFlowNode & { y: number; h: number; color: string };

type Link = {
  key: string;
  title: string;
  value: number;
  color: string;
  x0: number;
  x1: number;
  y0: number; // top of the band at x0
  y1: number; // top of the band at x1
  h: number;
};

function truncateLabel(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

function nodeColor(node: CashFlowNode, expenseIndex: number): string {
  switch (node.kind) {
    case "income":
      return CHART_COLORS.positive;
    case "surplus":
      return CHART_COLORS.positive;
    case "deficit":
      return CHART_COLORS.negative;
    case "other":
      return CHART_COLORS.categories[11]; // slate
    default:
      return CHART_COLORS.categories[expenseIndex % (CHART_COLORS.categories.length - 1)];
  }
}

/** Minimum vertical room a node takes, so a tiny item's label never overlaps the next one. */
const MIN_SLOT = 16;
const GAP = 8;

export function SankeyChart({ incomeData, expenseData, currency = "CAD" }: SankeyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<HoverInfo>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // CSP-safe positioning: mutate the tooltip element's style via a ref AFTER
  // the browser has evaluated CSP on the HTML. CSP only inspects HTML-rendered
  // `style="..."` attributes, not JS-set element.style mutations. (FINLYNQ-83)
  useEffect(() => {
    const el = tooltipRef.current;
    if (!el || !hover) return;
    el.style.left = `${hover.x}px`;
    el.style.top = `${hover.y}px`;
  }, [hover]);

  const columns = useMemo(() => buildCashFlowColumns(incomeData, expenseData), [incomeData, expenseData]);
  const { sources, uses, totalIncome, totalExpenses, pool, surplus, deficit } = columns;
  // Percentages read against income when there is any, so "Groceries 12%" means 12% of what came in.
  const base = totalIncome > 0 ? totalIncome : pool;

  const showHover = useCallback(
    (e: React.MouseEvent, key: string, title: string, amount: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setHover({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top - 10,
        key,
        title,
        amount,
        percentage: base > 0 ? (amount / base) * 100 : 0,
      });
    },
    [base],
  );

  if (pool === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No cash flow data for the selected period.
      </div>
    );
  }

  // ---- Layout -------------------------------------------------------------
  const narrow = width < 640;
  const padding = { top: narrow ? 8 : 32, bottom: 16, left: 8, right: 8 };
  const nodeWidth = 16;
  const labelGap = 8;
  const maxLabelWidth = Math.max(70, Math.min(170, (width - 3 * nodeWidth) * (narrow ? 0.22 : 0.18)));
  const maxLabelChars = Math.max(8, Math.floor(maxLabelWidth / 6.5));

  const xLeft = padding.left + maxLabelWidth + labelGap;
  const xRight = width - padding.right - maxLabelWidth - labelGap - nodeWidth;
  const xMid = (xLeft + xRight) / 2;

  // One scale for every column, so a band keeps its thickness end to end.
  const baseFlowHeight = Math.max(320, Math.max(sources.length, uses.length) * 34);
  const gapsFor = (n: number) => Math.max(0, n - 1) * GAP;
  const scale = (baseFlowHeight - Math.max(gapsFor(sources.length), gapsFor(uses.length))) / pool;

  const place = (nodes: CashFlowNode[]): { placed: PlacedNode[]; extent: number } => {
    const placed: PlacedNode[] = [];
    let y = padding.top;
    let expenseIndex = 0;
    for (const n of nodes) {
      const h = n.value * scale;
      placed.push({ ...n, y, h, color: nodeColor(n, n.kind === "expense" ? expenseIndex++ : 0) });
      y += Math.max(h, MIN_SLOT) + GAP;
    }
    return { placed, extent: y - GAP - padding.top };
  };

  const leftCol = place(sources);
  const rightCol = place(uses);
  const poolH = pool * scale;
  const contentH = Math.max(leftCol.extent, rightCol.extent, poolH);
  // Centre each column vertically against the tallest one.
  const shift = (extent: number) => (contentH - extent) / 2;
  const left = { placed: leftCol.placed.map((n) => ({ ...n, y: n.y + shift(leftCol.extent) })) };
  const right = { placed: rightCol.placed.map((n) => ({ ...n, y: n.y + shift(rightCol.extent) })) };
  const poolY = padding.top + shift(poolH);
  const height = padding.top + contentH + padding.bottom;

  // Bands: each source into the pool, the pool out to each use. Both stack on
  // the pool in column order, so the bands never cross at the middle node.
  const links: Link[] = [];
  {
    let into = poolY;
    for (const n of left.placed) {
      links.push({
        key: `in:${n.name}`,
        title: `${n.name} → Income`,
        value: n.value,
        color: n.color,
        x0: xLeft + nodeWidth,
        x1: xMid,
        y0: n.y,
        y1: into,
        h: n.h,
      });
      into += n.h;
    }
    let out = poolY;
    for (const n of right.placed) {
      links.push({
        key: `out:${n.name}`,
        title: `Income → ${n.name}`,
        value: n.value,
        color: n.color,
        x0: xMid + nodeWidth,
        x1: xRight,
        y0: out,
        y1: n.y,
        h: n.h,
      });
      out += n.h;
    }
  }

  const dimmed = (key: string) => hover !== null && hover.key !== key && hover.key !== "pool";

  return (
    <div ref={containerRef} className="relative w-full select-none">
      {narrow && (
        <p className="mb-1 text-xs text-muted-foreground">
          Income <span className="font-medium text-foreground">{formatCurrency(totalIncome, currency)}</span> · Spending{" "}
          <span className="font-medium text-foreground">{formatCurrency(totalExpenses, currency)}</span>
        </p>
      )}
      <svg width={width} height={height} className="overflow-visible" role="img" aria-label="Cash flow diagram">
        {/* Bands */}
        {links.map((l) => {
          const cx = (l.x0 + l.x1) / 2;
          const d = `M${l.x0},${l.y0} C${cx},${l.y0} ${cx},${l.y1} ${l.x1},${l.y1} L${l.x1},${l.y1 + l.h} C${cx},${l.y1 + l.h} ${cx},${l.y0 + l.h} ${l.x0},${l.y0 + l.h} Z`;
          return (
            <path
              key={l.key}
              d={d}
              fill={l.color}
              opacity={dimmed(l.key) ? 0.08 : 0.3}
              className="transition-opacity duration-150 cursor-pointer"
              onMouseMove={(e) => showHover(e, l.key, l.title, l.value)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}

        {/* Left: income sources (+ deficit) */}
        {left.placed.map((n) => (
          <g
            key={`l-${n.name}`}
            className="cursor-pointer"
            onMouseMove={(e) => showHover(e, `in:${n.name}`, n.name, n.value)}
            onMouseLeave={() => setHover(null)}
          >
            <rect x={xLeft} y={n.y} width={nodeWidth} height={Math.max(n.h, 2)} rx={3} fill={n.color} />
            <text x={xLeft - labelGap} y={n.y + Math.max(n.h, 2) / 2} textAnchor="end" dominantBaseline="central" className="fill-foreground text-[11px]">
              {truncateLabel(n.name, maxLabelChars)}
            </text>
          </g>
        ))}

        {/* Middle: the income pool */}
        <g
          className="cursor-pointer"
          onMouseMove={(e) => showHover(e, "pool", deficit > 0 ? "Income + deficit" : "Income", pool)}
          onMouseLeave={() => setHover(null)}
        >
          {totalIncome > 0 && (
            <rect x={xMid} y={poolY} width={nodeWidth} height={totalIncome * scale} rx={3} fill={CHART_COLORS.positive} />
          )}
          {deficit > 0 && (
            <rect x={xMid} y={poolY + totalIncome * scale} width={nodeWidth} height={deficit * scale} rx={3} fill={CHART_COLORS.negative} />
          )}
        </g>

        {/* Right: expense categories (+ surplus) */}
        {right.placed.map((n) => (
          <g
            key={`r-${n.name}`}
            className="cursor-pointer"
            onMouseMove={(e) => showHover(e, `out:${n.name}`, n.name, n.value)}
            onMouseLeave={() => setHover(null)}
          >
            <rect x={xRight} y={n.y} width={nodeWidth} height={Math.max(n.h, 2)} rx={3} fill={n.color} />
            <text
              x={xRight + nodeWidth + labelGap}
              y={n.y + Math.max(n.h, 2) / 2}
              textAnchor="start"
              dominantBaseline="central"
              className={n.kind === "surplus" ? "fill-foreground text-[11px] font-semibold" : "fill-foreground text-[11px]"}
            >
              {truncateLabel(n.name, maxLabelChars)}
            </text>
          </g>
        ))}

        {/* Column headers (on a phone they don't fit side by side; the line above the chart carries them) */}
        {!narrow && (
          <>
            <text x={xLeft + nodeWidth / 2} y={14} textAnchor="middle" className="fill-muted-foreground text-xs font-medium">
              Sources
            </text>
            <text x={xMid + nodeWidth / 2} y={14} textAnchor="middle" className="fill-foreground text-xs font-semibold">
              Income {formatCurrency(totalIncome, currency)}
            </text>
            <text x={xRight + nodeWidth / 2} y={14} textAnchor="middle" className="fill-muted-foreground text-xs font-medium">
              Spending {formatCurrency(totalExpenses, currency)}
            </text>
          </>
        )}
      </svg>

      {/* Summary line under the chart */}
      <p className="mt-2 text-xs text-muted-foreground">
        {surplus > 0 ? (
          <>
            Surplus <span className="font-medium text-foreground">{formatCurrency(surplus, currency)}</span>
            {totalIncome > 0 ? ` (${((surplus / totalIncome) * 100).toFixed(1)}% of income)` : ""}
          </>
        ) : deficit > 0 ? (
          <>
            Deficit <span className="font-medium text-foreground">{formatCurrency(deficit, currency)}</span>: spending was more than income in this period
          </>
        ) : (
          "Income and spending were equal in this period."
        )}
      </p>

      {/* Tooltip — position set via ref + useEffect to keep inline `style=` off the HTML (CSP) */}
      {hover && (
        <div
          ref={tooltipRef}
          className="absolute z-50 pointer-events-none px-3 py-2 bg-popover text-popover-foreground border rounded-lg shadow-lg text-xs whitespace-nowrap -translate-x-1/2 -translate-y-full"
        >
          <p className="font-semibold">{hover.title}</p>
          <p>
            {formatCurrency(hover.amount, currency)}
            {totalIncome > 0 ? ` (${hover.percentage.toFixed(1)}% of income)` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
