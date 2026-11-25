"use client";

/**
 * Forecast table: lines × months (or years), grouped like the budget, with
 * totals and balance rows. A blank cell (no layer gave it a value) shows "–".
 * In the monthly view a click on an income/spending cell asks the page for
 * its trace ("why is this number").
 *
 * Income, Spending and Debt payments, and each spending group, can be
 * collapsed; a group's row carries its total (sum of its lines, "–" when
 * every line is blank), and section totals always show.
 */
import { Fragment, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";

export type TableLine = { key: string; label: string; type: string; group: string; amounts: Array<number | null> };
export type TableModel = {
  columns: string[];
  columnLabels: string[];
  lines: TableLine[];
  totals: { income: number[]; expense: number[]; debtPayment: number[]; net: number[]; toInvestments?: number[]; purchases?: number[]; borrowed?: number[]; withdrawn?: number[] };
  balances: { cash: number[]; investments: number[]; loans: number[]; netWorth: number[] };
};

// Whole amounts with no currency sign (the currency is named once above the
// table), so more columns fit.
const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** A table amount: whole number, grouped, no currency sign; "–" for blank. */
export function formatTableAmount(v: number | null): string {
  if (v == null) return "–";
  const r = Math.round(v);
  return r === 0 ? "0" : WHOLE.format(r).replace("-", "−");
}

/** Per column, the sum of the lines' amounts; null where every line is blank. */
export function groupTotals(lines: TableLine[], columns: number): Array<number | null> {
  return Array.from({ length: columns }, (_, i) => {
    let sum: number | null = null;
    for (const l of lines) {
      const v = l.amounts[i];
      if (v != null) sum = (sum ?? 0) + v;
    }
    return sum;
  });
}

/** Spending lines by group, in first-seen order ("Other" for no group). */
export function spendingGroups(lines: TableLine[]): Map<string, TableLine[]> {
  const groups = new Map<string, TableLine[]>();
  for (const l of lines) {
    if (l.type !== "expense") continue;
    const g = l.group || "Other";
    groups.set(g, [...(groups.get(g) ?? []), l]);
  }
  return groups;
}

export function ForecastTable({
  model,
  currency,
  selected,
  onSelect,
}: {
  model: TableModel;
  currency: string;
  selected: { key: string; column: string } | null;
  onSelect: ((key: string, column: string) => void) | null;
}) {
  // Collapsed sections ("s:income", "s:spending", "s:debt") and spending groups ("g:<name>").
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const fmt = formatTableAmount;
  const income = model.lines.filter((l) => l.type === "income");
  const debt = model.lines.filter((l) => l.type === "debt");
  const groups = spendingGroups(model.lines);
  const allIds = ["s:income", "s:spending", ...(debt.length ? ["s:debt"] : []), ...[...groups.keys()].map((g) => `g:${g}`)];
  const allCollapsed = allIds.every((id) => collapsed.has(id));

  const headCell = "sticky left-0 z-10 bg-card px-3 py-1.5 text-left text-sm font-medium whitespace-nowrap";
  const numCell = "px-2 py-1.5 text-right text-xs tabular-nums whitespace-nowrap";

  const lineRow = (l: TableLine, indent = "pl-6") => (
    <tr key={l.key} className="border-t border-border/40">
      <td className={cn(headCell, "font-normal", indent)}>{l.label}</td>
      {l.amounts.map((v, i) => {
        const col = model.columns[i];
        const clickable = !!onSelect && l.type !== "debt";
        const isSel = selected?.key === l.key && selected.column === col;
        return (
          <td
            key={col}
            className={cn(numCell, v == null && "text-muted-foreground/60", clickable && "cursor-pointer hover:bg-muted/60", isSel && "bg-primary/10")}
            onClick={clickable ? () => onSelect!(l.key, col) : undefined}
          >
            {fmt(v)}
          </td>
        );
      })}
    </tr>
  );

  const Chevron = ({ open }: { open: boolean }) =>
    open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;

  const section = (id: string, title: string) => {
    const open = !collapsed.has(id);
    return (
      <tr className="border-t border-border bg-muted/40">
        <td className={cn(headCell, "bg-muted/40 py-1")}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => toggle(id)}
            className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            <Chevron open={open} /> {title}
          </button>
        </td>
        {model.columns.map((c) => <td key={c} />)}
      </tr>
    );
  };

  const groupRow = (name: string, lines: TableLine[]) => {
    const id = `g:${name}`;
    const open = !collapsed.has(id);
    const totals = groupTotals(lines, model.columns.length);
    return (
      <tr className="border-t border-border/40">
        <td className={cn(headCell, "pl-3")}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => toggle(id)}
            className="flex items-center gap-1 font-medium hover:text-primary"
          >
            <Chevron open={open} /> {name}
            <span className="text-xs font-normal text-muted-foreground">({lines.length})</span>
          </button>
        </td>
        {totals.map((v, i) => (
          <td key={model.columns[i]} className={cn(numCell, "font-medium", v == null && "text-muted-foreground/60")}>{fmt(v)}</td>
        ))}
      </tr>
    );
  };

  const totalRow = (label: string, values: number[], strong = false) => (
    <tr className={cn("border-t border-border/60", strong && "font-semibold")}>
      <td className={headCell}>{label}</td>
      {values.map((v, i) => <td key={model.columns[i]} className={numCell}>{fmt(v)}</td>)}
    </tr>
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Amounts in {currency}</span>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(allIds))}
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full">
          <thead>
            <tr className="bg-muted/40">
              <th className={cn(headCell, "bg-muted/40")}>Line</th>
              {model.columnLabels.map((c, i) => <th key={model.columns[i]} className={cn(numCell, "font-medium")}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {section("s:income", "Income")}
            {!collapsed.has("s:income") && income.map((l) => lineRow(l))}
            {totalRow("Total income", model.totals.income, true)}

            {section("s:spending", "Spending")}
            {!collapsed.has("s:spending") && [...groups.entries()].map(([g, ls]) => (
              <Fragment key={g}>
                {groupRow(g, ls)}
                {!collapsed.has(`g:${g}`) && ls.map((l) => lineRow(l, "pl-9"))}
              </Fragment>
            ))}
            {totalRow("Total spending", model.totals.expense, true)}

            {debt.length > 0 && (
              <>
                {section("s:debt", "Debt payments")}
                {!collapsed.has("s:debt") && debt.map((l) => lineRow(l))}
                {totalRow("Total debt payments", model.totals.debtPayment, true)}
              </>
            )}

            <tr className="border-t border-border bg-muted/40">
              <td className={cn(headCell, "bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground")}>Result</td>
              {model.columns.map((c) => <td key={c} />)}
            </tr>
            {totalRow("Net cash flow", model.totals.net, true)}
            {model.totals.borrowed?.some((v) => Math.abs(v) >= 0.5) && totalRow("Borrowed (into cash)", model.totals.borrowed)}
            {model.totals.purchases?.some((v) => Math.abs(v) >= 0.5) && totalRow("Down payments (cash into a home)", model.totals.purchases)}
            {model.totals.toInvestments?.some((v) => Math.abs(v) >= 0.5) && totalRow("Moved to investments", model.totals.toInvestments)}
            {model.totals.withdrawn?.some((v) => Math.abs(v) >= 0.5) && totalRow("Paid from investments (retirement)", model.totals.withdrawn)}
            {totalRow("Cash at end", model.balances.cash)}
            {totalRow("Investments at end", model.balances.investments)}
            {totalRow("Loans owed at end", model.balances.loans)}
            {totalRow("Net worth at end", model.balances.netWorth, true)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
