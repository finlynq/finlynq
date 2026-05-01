"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Landmark,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import type { RawTransaction } from "@/lib/import-pipeline";

export interface InvestmentExternalAccount {
  externalId: string;
  displayName: string;
  type: "Brokerage" | "Bank" | "Credit Card";
  currency: string;
  isInvestment: boolean;
  brokerId?: string;
  accountId: string;
}

interface InvestmentStatementPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  format: "ofx" | "qfx" | "ibkr-xml";
  externalAccounts: InvestmentExternalAccount[];
  rows: RawTransaction[];
  dateRange: { start: string; end: string } | null;
  /** Finlynq accounts the user can bind external accounts to. */
  finlynqAccounts: string[];
  onConfirm: (boundRows: RawTransaction[]) => void;
}

/**
 * Preview dialog for investment-statement uploads (issue #64).
 *
 * Shows the inventory of brokerage/bank accounts found in the file and
 * asks the user to bind each one to a Finlynq account. Once every external
 * account has a binding, the dialog rewrites every row's `account` field
 * (currently the synthetic external id like `ofx:invacct:…`) to the bound
 * Finlynq account name and hands the result back to the parent for
 * `/api/import/execute`.
 *
 * Multi-account files (one OFX with two `<INVSTMTRS>`, or an IBKR
 * FlexQuery with a USD + CAD sub-account) need bindings for every
 * external account before the import button enables. Single-account files
 * are the common case and that flow is one dropdown + Import.
 */
export function InvestmentStatementPreview({
  open,
  onOpenChange,
  format,
  externalAccounts,
  rows,
  dateRange,
  finlynqAccounts,
  onConfirm,
}: InvestmentStatementPreviewProps) {
  const [bindings, setBindings] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) setBindings({});
  }, [open, externalAccounts]);

  // Per-external-account row counts so the user knows what's behind each
  // dropdown. Useful when an IBKR file lists empty sub-accounts.
  const rowCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      counts.set(r.account, (counts.get(r.account) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  const allBound = externalAccounts.every(
    (a) => (bindings[a.externalId] ?? "").trim() !== "",
  );

  const handleConfirm = () => {
    const bound: RawTransaction[] = rows.map((r) => ({
      ...r,
      account: bindings[r.account] ?? r.account,
    }));
    onConfirm(bound);
  };

  const totalCredits = rows
    .filter((r) => r.amount > 0)
    .reduce((s, r) => s + r.amount, 0);
  const totalDebits = rows
    .filter((r) => r.amount < 0)
    .reduce((s, r) => s + r.amount, 0);

  const formatLabel =
    format === "ibkr-xml"
      ? "IBKR FlexQuery XML"
      : format.toUpperCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-indigo-600" />
            {formatLabel} Investment Statement Preview
          </DialogTitle>
          <DialogDescription>
            {rows.length} rows across {externalAccounts.length} account
            {externalAccounts.length === 1 ? "" : "s"}.
            {dateRange && ` ${dateRange.start} → ${dateRange.end}.`}
          </DialogDescription>
        </DialogHeader>

        {/* Account bindings */}
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <div className="text-xs font-medium text-muted-foreground">
            Bind each account in the file to a Finlynq account:
          </div>
          {externalAccounts.map((acc) => (
            <div
              key={acc.externalId}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <Badge variant="outline">{acc.type}</Badge>
              <Badge variant="outline">{acc.currency}</Badge>
              <span className="flex-1 min-w-0 truncate">{acc.displayName}</span>
              <span className="text-muted-foreground">
                {rowCounts.get(acc.externalId) ?? 0} rows
              </span>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <Select
                value={bindings[acc.externalId] ?? ""}
                onValueChange={(v) =>
                  setBindings((prev) => ({
                    ...prev,
                    [acc.externalId]: v ?? "",
                  }))
                }
              >
                <SelectTrigger className="w-56" size="sm">
                  <SelectValue placeholder="Select Finlynq account" />
                </SelectTrigger>
                <SelectContent>
                  {finlynqAccounts.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {bindings[acc.externalId] ? (
                <CheckCircle2 className="h-3 w-3 text-emerald-600" />
              ) : (
                <AlertTriangle className="h-3 w-3 text-amber-600" />
              )}
            </div>
          ))}
        </div>

        {/* Totals summary */}
        <div className="flex flex-wrap gap-4 text-xs px-1">
          <span className="text-emerald-600">
            Credits: +{totalCredits.toFixed(2)}
          </span>
          <span className="text-rose-600">
            Debits: {totalDebits.toFixed(2)}
          </span>
        </div>

        {/* Row preview (first 100) */}
        <div className="overflow-auto flex-1 rounded-lg border">
          <div className="divide-y">
            {rows.slice(0, 100).map((row, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-3 py-2 text-xs"
              >
                <span className="font-mono text-muted-foreground w-20 shrink-0">
                  {row.date}
                </span>
                <Badge
                  variant="outline"
                  className="shrink-0 text-[10px] px-1.5 max-w-[12ch] truncate"
                >
                  {row.portfolioHolding ?? "—"}
                </Badge>
                <span className="flex-1 truncate">{row.payee}</span>
                {row.quantity != null && row.quantity !== 0 && (
                  <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                    qty {row.quantity}
                  </span>
                )}
                <span
                  className={`font-mono w-20 text-right shrink-0 ${row.amount < 0 ? "text-rose-600" : "text-emerald-600"}`}
                >
                  {row.amount.toFixed(2)}
                </span>
              </div>
            ))}
            {rows.length > 100 && (
              <div className="text-center text-xs text-muted-foreground py-3">
                Showing first 100 of {rows.length} rows
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!allBound || rows.length === 0}
          >
            {!allBound
              ? "Bind every account first"
              : `Import ${rows.length} rows`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
