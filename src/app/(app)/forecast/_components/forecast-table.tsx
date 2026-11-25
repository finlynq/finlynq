"use client";

/**
 * Forecast table: lines × months (or years), grouped like the budget, with
 * totals and balance rows. A blank cell (no layer gave it a value) shows "–".
 * In the monthly view a click on an income/spending cell asks the page for
 * its trace ("why is this number").
 */
import { Fragment } from "react";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";

export type TableLine = { key: string; label: string; type: string; group: string; amounts: Array<number | null> };
export type TableModel = {
  columns: string[];
  columnLabels: string[];
  lines: TableLine[];
  totals: { income: number[]; expense: number[]; debtPayment: number[]; net: number[]; toInvestments?: number[]; purchases?: number[]; borrowed?: number[]; withdrawn?: number[] };
  balances: { cash: number[]; investments: number[]; loans: number[]; netWorth: number[] };
};

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
  const fmt = (v: number | null) => (v == null ? "–" : formatCurrency(v, currency, { decimals: 0 }));
  const income = model.lines.filter((l) => l.type === "income");
  const spending = model.lines.filter((l) => l.type === "expense");
  const debt = model.lines.filter((l) => l.type === "debt");
  const groups = new Map<string, TableLine[]>();
  for (const l of spending) groups.set(l.group || "Other", [...(groups.get(l.group || "Other") ?? []), l]);

  const headCell = "sticky left-0 z-10 bg-card px-3 py-1.5 text-left font-medium whitespace-nowrap";
  const numCell = "px-3 py-1.5 text-right tabular-nums whitespace-nowrap";

  const lineRow = (l: TableLine) => (
    <tr key={l.key} className="border-t border-border/40">
      <td className={cn(headCell, "font-normal pl-6")}>{l.label}</td>
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

  const section = (title: string) => (
    <tr className="border-t border-border bg-muted/40">
      <td className={cn(headCell, "bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground")} colSpan={1}>{title}</td>
      {model.columns.map((c) => <td key={c} />)}
    </tr>
  );

  const totalRow = (label: string, values: number[], strong = false) => (
    <tr className={cn("border-t border-border/60", strong && "font-semibold")}>
      <td className={headCell}>{label}</td>
      {values.map((v, i) => <td key={model.columns[i]} className={numCell}>{fmt(v)}</td>)}
    </tr>
  );

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/40">
            <th className={cn(headCell, "bg-muted/40")}>Line</th>
            {model.columnLabels.map((c, i) => <th key={model.columns[i]} className={cn(numCell, "font-medium")}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {section("Income")}
          {income.length ? income.map(lineRow) : null}
          {totalRow("Total income", model.totals.income, true)}

          {section("Spending")}
          {[...groups.entries()].map(([g, ls]) => (
            <Fragment key={g}>
              <tr className="border-t border-border/40">
                <td className={cn(headCell, "text-muted-foreground")}>{g}</td>
                {model.columns.map((c) => <td key={c} />)}
              </tr>
              {ls.map(lineRow)}
            </Fragment>
          ))}
          {totalRow("Total spending", model.totals.expense, true)}

          {debt.length > 0 && (
            <>
              {section("Debt payments")}
              {debt.map(lineRow)}
              {totalRow("Total debt payments", model.totals.debtPayment, true)}
            </>
          )}

          {section("Result")}
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
  );
}
