"use client";

/**
 * InvestmentOpPreviewDialog (FINLYNQ-208) — preview-before-record for an
 * investment bank row that a `record_investment_op` rule matched.
 *
 * Mirrors normal bank reconciliation: clicking "Create" on a reconcile row
 * shows what WILL be recorded and waits for an explicit confirm — it never
 * auto-records. The preview is built from the captured row data + the matched
 * op (the rule's default bindings read qty/amount straight off the row, which
 * is what the executor records).
 *
 * Neutral (non-destructive) styling — recording a transaction isn't a delete,
 * so this intentionally does NOT reuse the destructive ConfirmDialog.
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";

export interface InvestmentOpPreview {
  /** Op the matched rule will record (buy/sell/dividend/interest/fee/…). */
  op: string;
  ticker: string | null;
  securityName: string | null;
  /** Captured share/unit quantity (signed). */
  quantity: number | null;
  /** Bank row signed amount. */
  amount: number;
  currency: string;
  /** Display name of the investment account the op books into. */
  accountName: string;
}

function fmtQty(q: number | null): string {
  if (q == null || !Number.isFinite(q)) return "—";
  return String(Number(Math.abs(q).toFixed(6)));
}

export function InvestmentOpPreviewDialog({
  open,
  onOpenChange,
  preview,
  onConfirm,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: InvestmentOpPreview | null;
  onConfirm: () => void;
  busy?: boolean;
}) {
  if (!preview) return null;
  const op = preview.op;
  const isTrade = op === "buy" || op === "sell";
  const security = preview.ticker || preview.securityName || "—";
  const amountAbs = formatCurrency(Math.abs(preview.amount), preview.currency || "CAD");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record investment transaction</DialogTitle>
        </DialogHeader>
        <div className="text-sm space-y-3">
          <p className="text-muted-foreground">
            A matching rule will record this bank row as the operation below.
            Review it before recording — nothing is written until you confirm.
          </p>
          <dl className="rounded-md border bg-muted/20 p-3 grid grid-cols-[7rem_1fr] gap-y-1.5 gap-x-3">
            <dt className="text-muted-foreground">Operation</dt>
            <dd className="font-semibold uppercase tracking-wide">{op}</dd>
            {isTrade && (
              <>
                <dt className="text-muted-foreground">Security</dt>
                <dd className="font-mono">{security}</dd>
                <dt className="text-muted-foreground">Quantity</dt>
                <dd className="tabular-nums">{fmtQty(preview.quantity)}</dd>
              </>
            )}
            {!isTrade && security !== "—" && (
              <>
                <dt className="text-muted-foreground">Security</dt>
                <dd className="font-mono">{security}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="tabular-nums">{amountAbs}</dd>
            <dt className="text-muted-foreground">Account</dt>
            <dd>{preview.accountName}</dd>
          </dl>
          <p className="text-xs text-muted-foreground italic">
            {isTrade
              ? "Lots are matched FIFO automatically. The cash sleeve is adjusted and the bank row is linked."
              : "Records the cash entry on the account's sleeve and links the bank row."}
          </p>
        </div>
        <div className="flex gap-2 mt-2">
          <Button
            variant="outline"
            className="flex-1"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            className="flex-1"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Recording…" : `Record ${op}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
