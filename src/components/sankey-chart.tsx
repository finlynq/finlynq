"use client";

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { CHART_COLORS } from "@/lib/chart-colors";
import { formatCurrency } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import {
  buildCashFlowColumns,
  groupKey,
  hasGroups,
  type CashFlowItem,
  type CashFlowLevel,
  type CashFlowNode,
} from "@/lib/reports/cash-flow-sankey";

type SankeyChartProps = {
  incomeData: CashFlowItem[];
  expenseData: CashFlowItem[];
  currency?: string;
  /** Which level the chart opens on; the user can switch. */
  initialLevel?: CashFlowLevel;
};

type HoverInfo = {
  x: number;
  y: number;
  /** Highlight key: the node or link under the pointer. */
  key: string;
  title: string;
  amount: number;
  percentage: number;
  hint?: string;
} | null;

type Side = "income" | "expense";

type PlacedNode = CashFlowNode & { y: number; h: number; color: string; caption?: { y: number } };

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

/** Minimum vertical room a node takes, so a tiny item's label never overlaps the next one. */
const MIN_SLOT = 16;
const GAP = 8;
/** Between categories of one expanded group: tighter, so they read as one block. */
const CHILD_GAP = 3;
/** Room above an expanded group for its clickable caption. */
const CAPTION = 16;

const SLATE = CHART_COLORS.categories[11];
const PALETTE = CHART_COLORS.categories.slice(0, 11);

export function SankeyChart({ incomeData, expenseData, currency = "CAD", initialLevel = "category" }: SankeyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<HoverInfo>(null);
  const [level, setLevel] = useState<CashFlowLevel>(initialLevel);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

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

  const groupable = useMemo(() => hasGroups(incomeData) || hasGroups(expenseData), [incomeData, expenseData]);
  const effectiveLevel: CashFlowLevel = groupable ? level : "category";

  const columns = useMemo(
    () => buildCashFlowColumns(incomeData, expenseData, { level: effectiveLevel, expanded }),
    [incomeData, expenseData, effectiveLevel, expanded],
  );
  const { sources, uses, totalIncome, totalExpenses, pool, surplus, deficit } = columns;
  // Percentages read against income when there is any, so "Groceries 12%" means 12% of what came in.
  const base = totalIncome > 0 ? totalIncome : pool;

  const showHover = useCallback(
    (e: React.MouseEvent, key: string, title: string, amount: number, hint?: string) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setHover({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top - 10,
        key,
        title,
        amount,
        percentage: base > 0 ? (amount / base) * 100 : 0,
        hint,
      });
    },
    [base],
  );

  const toggleGroup = useCallback((side: Side, group: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const k = groupKey(side, group);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
    setHover(null);
  }, []);

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

  // Colour per colourKey, in column order: an expanded group's categories share one colour.
  const colourFor = (side: Side) => {
    const seen = new Map<string, string>();
    return (n: CashFlowNode): string => {
      if (n.kind === "surplus") return CHART_COLORS.positive;
      if (n.kind === "deficit") return CHART_COLORS.negative;
      if (n.kind === "other") return SLATE;
      if (side === "income" && effectiveLevel === "category") return CHART_COLORS.positive;
      const existing = seen.get(n.colourKey);
      if (existing) return existing;
      const c = side === "income" ? CHART_COLORS.positive : PALETTE[seen.size % PALETTE.length];
      seen.set(n.colourKey, c);
      return c;
    };
  };

  const place = (nodes: CashFlowNode[], side: Side): { placed: PlacedNode[]; extent: number } => {
    const colour = colourFor(side);
    const placed: PlacedNode[] = [];
    let y = padding.top;
    let prev: CashFlowNode | undefined;
    for (const n of nodes) {
      const sameGroup = prev?.role === "child" && n.role === "child" && prev.group === n.group;
      if (prev) y += sameGroup ? CHILD_GAP : GAP;
      let caption: { y: number } | undefined;
      if (n.role === "child" && !sameGroup) {
        caption = { y: y + CAPTION - 5 };
        y += CAPTION;
      }
      const h = n.value * scale;
      placed.push({ ...n, y, h, color: colour(n), caption });
      y += Math.max(h, MIN_SLOT);
      prev = n;
    }
    return { placed, extent: y - padding.top };
  };

  const leftCol = place(sources, "income");
  const rightCol = place(uses, "expense");
  const poolH = pool * scale;
  const contentH = Math.max(leftCol.extent, rightCol.extent, poolH);
  // Centre each column vertically against the tallest one.
  const shift = (extent: number) => (contentH - extent) / 2;
  const moveBy = (n: PlacedNode, d: number): PlacedNode => ({ ...n, y: n.y + d, caption: n.caption ? { y: n.caption.y + d } : undefined });
  const left = leftCol.placed.map((n) => moveBy(n, shift(leftCol.extent)));
  const right = rightCol.placed.map((n) => moveBy(n, shift(rightCol.extent)));
  const poolY = padding.top + shift(poolH);
  const height = padding.top + contentH + padding.bottom;

  // Bands: each source into the pool, the pool out to each use. Both stack on
  // the pool in column order, so the bands never cross at the middle node.
  const links: Link[] = [];
  {
    let into = poolY;
    for (const n of left) {
      links.push({
        key: `in:${n.key}`,
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
    for (const n of right) {
      links.push({
        key: `out:${n.key}`,
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
  const expandable = (n: CashFlowNode) => n.role === "group" && (n.childCount ?? 0) > 1;

  const nodeTitle = (n: CashFlowNode) => (expandable(n) ? `${n.name} (${n.childCount} categories)` : n.name);
  const nodeHint = (n: CashFlowNode) =>
    expandable(n) ? "Click to see its categories" : n.role === "child" ? `In ${n.group}. Click to fold it back` : undefined;
  const onNodeClick = (side: Side, n: CashFlowNode) => {
    if (expandable(n) || n.role === "child") toggleGroup(side, n.group ?? n.name);
  };
  const clickable = (n: CashFlowNode) => expandable(n) || n.role === "child";
  const labelFor = (n: CashFlowNode) => truncateLabel(n.name, maxLabelChars - (expandable(n) ? 2 : 0)) + (expandable(n) ? " ›" : "");

  const renderNode = (n: PlacedNode, side: Side) => {
    const isLeft = side === "income";
    const x = isLeft ? xLeft : xRight;
    const prefix = isLeft ? "in" : "out";
    const h = Math.max(n.h, 2);
    return (
      <g
        key={`${prefix}-node-${n.key}`}
        className="cursor-pointer"
        onMouseMove={(e) => showHover(e, `${prefix}:${n.key}`, nodeTitle(n), n.value, nodeHint(n))}
        onMouseLeave={() => setHover(null)}
        onClick={() => onNodeClick(side, n)}
        role={clickable(n) ? "button" : undefined}
        aria-label={clickable(n) ? (expandable(n) ? `Show the categories in ${n.name}` : `Fold ${n.group} back into one group`) : undefined}
      >
        {n.caption && (
          <text
            x={isLeft ? x - labelGap : x + nodeWidth + labelGap}
            y={n.caption.y}
            textAnchor={isLeft ? "end" : "start"}
            className="fill-muted-foreground text-[10px] font-semibold uppercase tracking-wide"
          >
            {isLeft ? `${truncateLabel(n.group ?? "", maxLabelChars)} ‹` : `‹ ${truncateLabel(n.group ?? "", maxLabelChars)}`}
          </text>
        )}
        <rect x={x} y={n.y} width={nodeWidth} height={h} rx={3} fill={n.color} />
        <text
          x={isLeft ? x - labelGap : x + nodeWidth + labelGap}
          y={n.y + h / 2}
          textAnchor={isLeft ? "end" : "start"}
          dominantBaseline="central"
          className={[
            "fill-foreground text-[11px]",
            n.kind === "surplus" || n.kind === "deficit" ? "font-semibold" : "",
            expandable(n) ? "underline decoration-dotted underline-offset-2" : "",
          ].join(" ")}
        >
          {labelFor(n)}
        </text>
      </g>
    );
  };

  return (
    <div ref={containerRef} className="relative w-full select-none">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {groupable && (
          <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="Detail">
            <Button
              size="sm"
              variant={effectiveLevel === "group" ? "secondary" : "ghost"}
              aria-pressed={effectiveLevel === "group"}
              onClick={() => setLevel("group")}
            >
              Groups
            </Button>
            <Button
              size="sm"
              variant={effectiveLevel === "category" ? "secondary" : "ghost"}
              aria-pressed={effectiveLevel === "category"}
              onClick={() => setLevel("category")}
            >
              Categories
            </Button>
          </div>
        )}
        {groupable && effectiveLevel === "group" && (
          <span className="text-xs text-muted-foreground">Click a group to see its categories.</span>
        )}
        {effectiveLevel === "group" && expanded.size > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setExpanded(new Set())}>
            Fold all
          </Button>
        )}
        {narrow && (
          <p className="w-full text-xs text-muted-foreground">
            Income <span className="font-medium text-foreground">{formatCurrency(totalIncome, currency)}</span> · Spending{" "}
            <span className="font-medium text-foreground">{formatCurrency(totalExpenses, currency)}</span>
          </p>
        )}
      </div>

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
        {left.map((n) => renderNode(n, "income"))}

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
        {right.map((n) => renderNode(n, "expense"))}

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
          {hover.hint && <p className="text-muted-foreground">{hover.hint}</p>}
        </div>
      )}
    </div>
  );
}
