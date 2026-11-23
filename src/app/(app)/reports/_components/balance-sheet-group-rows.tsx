"use client";

/**
 * Balance Sheet rows grouped by account group, each group with a subtotal
 * (GH #440). Groups follow the user's saved order (Accounts → Manage groups),
 * "Other" last. Subtotals are in the display currency, from each row's
 * `convertedBalance`; for liabilities that is what is OWED, so a card in
 * credit reduces its group's subtotal (GH #433).
 */
import { Fragment } from "react";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { groupWithSubtotals } from "@/lib/accounts/groups";

export type BalanceSheetRow = {
  accountGroup: string;
  accountName: string;
  currency: string;
  balance: number;
  convertedBalance?: number;
};

export function BalanceSheetGroupRows({
  rows,
  kind,
  savedOrder,
  displayCurrency,
}: {
  rows: BalanceSheetRow[];
  kind: "asset" | "liability";
  savedOrder: string[];
  displayCurrency: string;
}) {
  const groups = groupWithSubtotals(rows, (r) => r.accountGroup, (r) => r.convertedBalance ?? r.balance, savedOrder);
  return (
    <>
      {groups.map((g) => (
        <Fragment key={g.group}>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableCell colSpan={3} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {g.group}
              <span className="ml-2 font-normal normal-case tracking-normal">
                {g.rows.length} {g.rows.length === 1 ? "account" : "accounts"}
              </span>
            </TableCell>
            <TableCell className="text-right font-mono text-sm font-semibold">
              <SignedAmount value={g.subtotal} currency={displayCurrency} kind={kind} />
            </TableCell>
          </TableRow>
          {g.rows.map((r, i) => (
            <TableRow key={`${g.group}-${i}`} className="hover:bg-muted/30">
              <TableCell className="w-4" />
              <TableCell className="text-sm">{r.accountName}</TableCell>
              <TableCell>
                <Badge variant="outline" className="text-[10px]">
                  {r.currency}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                <SignedAmount value={r.balance} currency={r.currency} kind={kind} />
              </TableCell>
            </TableRow>
          ))}
        </Fragment>
      ))}
    </>
  );
}

/** A liability amount below 0 is a credit (owed is positive, GH #433). */
function SignedAmount({ value, currency, kind }: { value: number; currency: string; kind: "asset" | "liability" }) {
  if (kind === "liability" && value < 0) {
    return (
      <>
        {formatCurrency(-value, currency)}
        <span className="ml-1 text-xs font-normal text-emerald-600 dark:text-emerald-400">credit</span>
      </>
    );
  }
  return <>{formatCurrency(value, currency)}</>;
}
