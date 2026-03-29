"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { CHART_COLORS } from "@/lib/chart-colors";
import { formatCurrency } from "@/lib/currency";

type DataItem = { name: string; value: number };

type SankeyChartProps = {
  incomeData: DataItem[];
  expenseData: DataItem[];
};

type HoverInfo = {
  x: number;
  y: number;
  from: string;
  to: string;
  amount: number;
  percentage: number;
} | null;

function truncateLabel(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "\u2026" : text;
}

export function SankeyChart({ incomeData, expenseData }: SankeyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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

  const totalIncome = incomeData.reduce((s, d) => s + d.value, 0);
  const totalExpenses = expenseData.reduce((s, d) => s + d.value, 0);

  if (totalIncome === 0 && totalExpenses === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No cash flow data for the selected period.
      </div>
    );
  }

  // Layout constants
  const padding = { top: 30, bottom: 30, left: 16, right: 16 };
  const nodeWidth = 18;
  const labelGap = 8;
  const maxLabelWidth = Math.min(140, (width - padding.left - padding.right - 160) / 2);
  const leftLabelArea = maxLabelWidth + labelGap;
  const rightLabelArea = maxLabelWidth + labelGap;
  const flowAreaLeft = padding.left + leftLabelArea + nodeWidth;
  const flowAreaRight = width - padding.right - rightLabelArea - nodeWidth;
  const height = Math.max(350, Math.max(incomeData.length, expenseData.length) * 50 + padding.top + padding.bottom);
  const flowHeight = height - padding.top - padding.bottom;

  // Compute node positions
  const maxTotal = Math.max(totalIncome, totalExpenses);
  const incomeGap = incomeData.length > 1 ? 6 : 0;
  const expenseGap = expenseData.length > 1 ? 6 : 0;

  const incomeTotalGap = (incomeData.length - 1) * incomeGap;
  const incomeScale = (flowHeight - incomeTotalGap) / maxTotal;
  const expenseTotalGap = (expenseData.length - 1) * expenseGap;
  const expenseScale = (flowHeight - expenseTotalGap) / maxTotal;

  // Income nodes (left side)
  let incomeY = padding.top + (flowHeight - totalIncome * incomeScale - incomeTotalGap) / 2;
  const incomeNodes = incomeData.map((d) => {
    const h = d.value * incomeScale;
    const node = { ...d, x: padding.left + leftLabelArea, y: incomeY, h };
    incomeY += h + incomeGap;
    return node;
  });

  // Expense nodes (right side)
  let expenseY = padding.top + (flowHeight - totalExpenses * expenseScale - expenseTotalGap) / 2;
  const expenseNodes = expenseData.map((d, i) => {
    const h = d.value * expenseScale;
    const node = { ...d, x: flowAreaRight, y: expenseY, h, colorIndex: i % CHART_COLORS.categories.length };
    expenseY += h + expenseGap;
    return node;
  });

  // Generate flows: each income source distributes proportionally to expenses
  type Flow = {
    fromIdx: number;
    toIdx: number;
    value: number;
    fromY: number;
    fromH: number;
    toY: number;
    toH: number;
  };
  const flows: Flow[] = [];
  const incomeOffsets = incomeNodes.map(() => 0);
  const expenseOffsets = expenseNodes.map(() => 0);

  for (let i = 0; i < incomeNodes.length; i++) {
    for (let j = 0; j < expenseNodes.length; j++) {
      const value = (incomeNodes[i].value / totalIncome) * expenseNodes[j].value;
      if (value < 0.01) continue;
      const fromH = value * incomeScale;
      const toH = value * expenseScale;
      flows.push({
        fromIdx: i,
        toIdx: j,
        value,
        fromY: incomeNodes[i].y + incomeOffsets[i],
        fromH,
        toY: expenseNodes[j].y + expenseOffsets[j],
        toH,
      });
      incomeOffsets[i] += fromH;
      expenseOffsets[j] += toH;
    }
  }

  // Savings flow (if income > expenses)
  const savings = totalIncome - totalExpenses;

  const handleFlowHover = useCallback(
    (e: React.MouseEvent, flow: Flow) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setHover({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top - 10,
        from: incomeNodes[flow.fromIdx].name,
        to: expenseNodes[flow.toIdx].name,
        amount: flow.value,
        percentage: (flow.value / totalIncome) * 100,
      });
    },
    [incomeNodes, expenseNodes, totalIncome]
  );

  const handleNodeHover = useCallback(
    (e: React.MouseEvent, name: string, value: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setHover({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top - 10,
        from: name,
        to: "",
        amount: value,
        percentage: (value / totalIncome) * 100,
      });
    },
    [totalIncome]
  );

  const maxLabelChars = Math.floor(maxLabelWidth / 7.5);

  return (
    <div ref={containerRef} className="relative w-full select-none">
      <svg width={width} height={height + (savings > 0 ? 44 : 0)} className="overflow-visible">
        {/* Flows */}
        {flows.map((flow, i) => {
          const x0 = flowAreaLeft + nodeWidth;
          const x1 = flowAreaRight;
          const cx = (x0 + x1) / 2;
          const y0Top = flow.fromY;
          const y0Bot = flow.fromY + flow.fromH;
          const y1Top = flow.toY;
          const y1Bot = flow.toY + flow.toH;
          const d = `M${x0},${y0Top} C${cx},${y0Top} ${cx},${y1Top} ${x1},${y1Top} L${x1},${y1Bot} C${cx},${y1Bot} ${cx},${y0Bot} ${x0},${y0Bot} Z`;
          return (
            <path
              key={i}
              d={d}
              fill={CHART_COLORS.categories[flow.toIdx % CHART_COLORS.categories.length]}
              opacity={hover && (hover.from !== incomeNodes[flow.fromIdx].name || hover.to !== expenseNodes[flow.toIdx].name) ? 0.08 : 0.25}
              className="transition-opacity duration-150 cursor-pointer"
              onMouseMove={(e) => handleFlowHover(e, flow)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}

        {/* Income nodes (left) */}
        {incomeNodes.map((node, i) => (
          <g
            key={`in-${i}`}
            onMouseMove={(e) => handleNodeHover(e, node.name, node.value)}
            onMouseLeave={() => setHover(null)}
            className="cursor-pointer"
          >
            <rect
              x={node.x}
              y={node.y}
              width={nodeWidth}
              height={Math.max(node.h, 2)}
              rx={3}
              fill={CHART_COLORS.positive}
            />
            <text
              x={node.x - labelGap}
              y={node.y + node.h / 2}
              textAnchor="end"
              dominantBaseline="central"
              className="fill-foreground text-[11px]"
            >
              {truncateLabel(node.name, maxLabelChars)}
            </text>
          </g>
        ))}

        {/* Expense nodes (right) */}
        {expenseNodes.map((node, i) => (
          <g
            key={`ex-${i}`}
            onMouseMove={(e) => handleNodeHover(e, node.name, node.value)}
            onMouseLeave={() => setHover(null)}
            className="cursor-pointer"
          >
            <rect
              x={node.x}
              y={node.y}
              width={nodeWidth}
              height={Math.max(node.h, 2)}
              rx={3}
              fill={CHART_COLORS.categories[node.colorIndex]}
            />
            <text
              x={node.x + nodeWidth + labelGap}
              y={node.y + node.h / 2}
              textAnchor="start"
              dominantBaseline="central"
              className="fill-foreground text-[11px]"
            >
              {truncateLabel(node.name, maxLabelChars)}
            </text>
          </g>
        ))}

        {/* Column headers */}
        <text x={padding.left + leftLabelArea + nodeWidth / 2} y={14} textAnchor="middle" className="fill-muted-foreground text-xs font-medium">
          Income ({formatCurrency(totalIncome, "CAD")})
        </text>
        <text x={flowAreaRight + nodeWidth / 2} y={14} textAnchor="middle" className="fill-muted-foreground text-xs font-medium">
          Expenses ({formatCurrency(totalExpenses, "CAD")})
        </text>

        {/* Savings bar */}
        {savings > 0 && (
          <g>
            <rect
              x={flowAreaLeft}
              y={height + 8}
              width={(savings / totalIncome) * (flowAreaRight - flowAreaLeft + nodeWidth)}
              height={20}
              rx={4}
              fill={CHART_COLORS.positive}
              opacity={0.7}
            />
            <text
              x={flowAreaLeft + 8}
              y={height + 21}
              className="fill-white text-[11px] font-medium"
            >
              Savings: {formatCurrency(savings, "CAD")} ({((savings / totalIncome) * 100).toFixed(1)}%)
            </text>
          </g>
        )}
      </svg>

      {/* Tooltip */}
      {hover && (
        <div
          className="absolute z-50 pointer-events-none px-3 py-2 bg-popover text-popover-foreground border rounded-lg shadow-lg text-xs whitespace-nowrap"
          style={{ left: hover.x, top: hover.y, transform: "translate(-50%, -100%)" }}
        >
          <p className="font-semibold">{hover.from}{hover.to ? ` \u2192 ${hover.to}` : ""}</p>
          <p>{formatCurrency(hover.amount, "CAD")} ({hover.percentage.toFixed(1)}%)</p>
        </div>
      )}
    </div>
  );
}
