"use client";

import { useState, useEffect } from "react";
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
import { Landmark, ArrowRight, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { RawTransaction } from "@/lib/import-pipeline";
import type { OfxTransaction, OfxAccountInfo } from "@/lib/ofx-parser";

interface OfxPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactions: OfxTransaction[];
  accountInfo: OfxAccountInfo;
  balanceAmount: number | null;
  balanceDate: string | null;
  dateRange: { start: string; end: string } | null;
  currency: string;
  accounts: string[];
  onConfirm: (rows: RawTransaction[]) => void;
}

export function OfxPreview({
  open,
  onOpenChange,
  transactions,
  accountInfo,
  balanceAmount,
  balanceDate,
  dateRange,
  currency,
  accounts,
  onConfirm,
}: OfxPreviewProps) {
  const [selectedAccount, setSelectedAccount] = useState("");

  // Reset on open
  useEffect(() => {
    if (open) {
      setSelectedAccount("");
    }
  }, [open]);

  const handleConfirm = () => {
    const rows: RawTransaction[] = transactions.map((txn) => ({
      date: txn.date,
      account: selectedAccount,
      amount: txn.amount,
      payee: txn.payee,
      currency,
      note: txn.memo || "",
      fitId: txn.fitId,
    }));
    onConfirm(rows);
  };

  const totalCredits = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totalDebits = transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-indigo-600" />
            OFX/QFX Import Preview
          </DialogTitle>
          <DialogDescription>
            {transactions.length} transactions found in the bank file.
          </DialogDescription>
        </DialogHeader>

        {/* Account info summary */}
        <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{accountInfo.accountType || "BANK"}</Badge>
            {accountInfo.accountId && (
              <Badge variant="outline" className="font-mono">
                ...{accountInfo.accountId.slice(-4)}
              </Badge>
            )}
            {dateRange && (
              <Badge variant="outline">
                {dateRange.start} to {dateRange.end}
              </Badge>
            )}
            <Badge variant="outline">{currency}</Badge>
          </div>

          <div className="flex flex-wrap gap-4 text-xs">
            <span className="text-emerald-600">
              Credits: +{totalCredits.toFixed(2)}
            </span>
            <span className="text-rose-600">
              Debits: {totalDebits.toFixed(2)}
            </span>
            {balanceAmount !== null && (
              <span className="text-muted-foreground">
                Balance: {balanceAmount.toFixed(2)} {balanceDate ? `(${balanceDate})` : ""}
              </span>
            )}
          </div>
        </div>

        {/* Account assignment */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Assign to account:</span>
          <Select value={selectedAccount} onValueChange={(v) => setSelectedAccount(v ?? "")}>
            <SelectTrigger className="w-48" size="sm">
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((acc) => (
                <SelectItem key={acc} value={acc}>{acc}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!selectedAccount && (
            <span className="flex items-center gap-1 text-xs text-amber-600">
              <AlertTriangle className="h-3 w-3" />
              Required
            </span>
          )}
          {selectedAccount && (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <CheckCircle2 className="h-3 w-3" />
            </span>
          )}
        </div>

        {/* Transaction list */}
        <div className="overflow-auto flex-1 rounded-lg border">
          <div className="divide-y">
            {transactions.slice(0, 100).map((txn, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 text-xs">
                <span className="font-mono text-muted-foreground w-20 shrink-0">{txn.date}</span>
                <Badge variant="outline" className="shrink-0 text-[10px] px-1.5">
                  {txn.type}
                </Badge>
                <span className="flex-1 truncate">{txn.payee}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className={`font-mono w-20 text-right shrink-0 ${txn.amount < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                  {txn.amount.toFixed(2)}
                </span>
              </div>
            ))}
            {transactions.length > 100 && (
              <div className="text-center text-xs text-muted-foreground py-3">
                Showing first 100 of {transactions.length} transactions
              </div>
            )}
            {transactions.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-8">
                No transactions found in this file.
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
            disabled={transactions.length === 0 || !selectedAccount}
          >
            {!selectedAccount
              ? "Select an account first"
              : `Import ${transactions.length} transactions`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
