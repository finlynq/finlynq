"use client";

/**
 * OfxConfirmDialog — field-mapping preview/confirm for OFX/QFX uploads
 * (§A, 2026-06-04).
 *
 * OFX/QFX bank statements have fixed semantic fields (NAME, MEMO, AMOUNT,
 * DATE, FITID) — there's no arbitrary column to remap like a CSV. The only
 * meaningful choice is which field becomes the **payee** vs the **note**:
 * many banks bury the merchant string in <MEMO> and put a generic type label
 * ("POINT OF SALE PURCHASE") in <NAME>.
 *
 * So this is a read-only PREVIEW of how the statement will land in staging,
 * plus a single live "Payee source: Name / Memo" toggle that swaps payee↔note
 * across all rows client-side (the upload returned raw NAME + MEMO per row, so
 * no re-upload is needed to re-render). Confirming re-uploads with the chosen
 * `payeeSource` + `confirmedImport=1`. Mirrors the CSV ColumnMappingDialog's
 * confirm flow; the per-account "apply automatically" choice is shared with it.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

export interface OfxPreviewRow {
  date: string;
  amount: number;
  /** Raw <NAME>. */
  name: string;
  /** Raw <MEMO>. */
  memo: string;
  /** TRNTYPE — DEBIT / CREDIT / CHECK / … */
  type: string;
  fitId: string;
}

interface OfxConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  account: string;
  currency: string;
  format: "ofx" | "qfx";
  rows: OfxPreviewRow[];
  rowCount: number;
  statementBalance: number | null;
  statementBalanceDate: string | null;
  /** The account's saved payee source — seeds the toggle. */
  initialPayeeSource: "name" | "memo";
  submitting: boolean;
  onConfirm: (params: {
    payeeSource: "name" | "memo";
    dontAskAgain: boolean;
  }) => void;
}

/** Resolve payee/note for one row given the chosen source. The non-chosen
 *  field becomes the note (falling back to "" when blank). */
function resolveRow(
  row: OfxPreviewRow,
  source: "name" | "memo",
): { payee: string; note: string } {
  if (source === "memo") {
    return { payee: row.memo || row.name || "", note: row.memo ? row.name : "" };
  }
  return { payee: row.name || row.memo || "", note: row.name ? row.memo : "" };
}

export function OfxConfirmDialog({
  open,
  onOpenChange,
  fileName,
  account,
  currency,
  format,
  rows,
  rowCount,
  statementBalance,
  statementBalanceDate,
  initialPayeeSource,
  submitting,
  onConfirm,
}: OfxConfirmDialogProps) {
  const [payeeSource, setPayeeSource] = useState<"name" | "memo">(
    initialPayeeSource,
  );
  // "ask" = keep confirming (account stays 'confirm'); "auto" = don't ask again
  // for this account (flip to 'auto').
  const [futureMode, setFutureMode] = useState<"ask" | "auto">("ask");

  // Re-seed when the dialog opens against a new file/account.
  useEffect(() => {
    if (!open) return;
    setPayeeSource(initialPayeeSource);
    setFutureMode("ask");
  }, [open, fileName, initialPayeeSource]);

  const previewRows = useMemo(
    () => rows.map((r) => ({ ...r, ...resolveRow(r, payeeSource) })),
    [rows, payeeSource],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[88vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Confirm import — {format.toUpperCase()} statement</DialogTitle>
          <DialogDescription>
            Here&apos;s how{" "}
            <span className="font-mono text-xs">{fileName}</span> will be added to{" "}
            <span className="font-medium text-foreground">{account}</span>. Pick
            which field becomes the Payee, then import.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-auto flex-1 space-y-4 pr-1">
          {/* Statement snapshot */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
            <span className="flex items-center gap-1.5 font-medium">
              <FileText className="h-3.5 w-3.5" /> {rowCount} transaction
              {rowCount === 1 ? "" : "s"}
            </span>
            {statementBalance != null && (
              <span className="text-muted-foreground">
                Statement balance:{" "}
                <span className="font-medium text-foreground">
                  {formatCurrency(statementBalance, currency)}
                </span>
                {statementBalanceDate ? ` · ${statementBalanceDate}` : ""}
              </span>
            )}
            <span className="text-muted-foreground">Currency: {currency}</span>
          </div>

          {/* Payee source toggle — the one editable field. */}
          <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
            <div className="text-sm font-medium">Payee comes from</div>
            <div className="flex gap-4">
              {(["name", "memo"] as const).map((opt) => (
                <label
                  key={opt}
                  className="flex items-center gap-1.5 text-sm cursor-pointer"
                >
                  <input
                    type="radio"
                    name="ofx-confirm-payee-source"
                    value={opt}
                    checked={payeeSource === opt}
                    onChange={() => setPayeeSource(opt)}
                  />
                  {opt === "name" ? "Name field" : "Memo field"}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              The other field becomes the transaction Note. Some banks put the
              real merchant in Memo and a generic label in Name — flip this if the
              Payee column below looks generic.
            </p>
          </div>

          {/* Preview table — how rows land in staging. */}
          <div className="space-y-1.5">
            <div className="text-sm font-medium">
              Preview{" "}
              <span className="font-normal text-muted-foreground">
                (first {Math.min(previewRows.length, 50)} of {rowCount})
              </span>
            </div>
            <div className="rounded-lg border overflow-auto max-h-[42vh]">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium whitespace-nowrap">Date</th>
                    <th className="text-left px-2 py-1.5 font-medium">Payee</th>
                    <th className="text-left px-2 py-1.5 font-medium">Note</th>
                    <th className="text-left px-2 py-1.5 font-medium whitespace-nowrap">Type</th>
                    <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {previewRows.slice(0, 50).map((r) => (
                    <tr key={r.fitId}>
                      <td className="px-2 py-1 font-mono whitespace-nowrap">{r.date}</td>
                      <td className="px-2 py-1 max-w-[260px] truncate" title={r.payee}>
                        {r.payee || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-2 py-1 max-w-[220px] truncate text-muted-foreground" title={r.note}>
                        {r.note || "—"}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">{r.type || "—"}</td>
                      <td className="px-2 py-1 text-right font-mono whitespace-nowrap">
                        {formatCurrency(r.amount, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rowCount > 50 && (
              <p className="text-[11px] text-muted-foreground">
                Showing the first 50 rows — all {rowCount} will be imported.
              </p>
            )}
          </div>

          {/* Auto-vs-ask choice (shared concept with the CSV dialog). */}
          <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
            <div className="text-sm font-medium">On future uploads to {account}</div>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="ofx-future-mode"
                  className="mt-0.5"
                  checked={futureMode === "ask"}
                  onChange={() => setFutureMode("ask")}
                />
                <span>
                  <span className="font-medium">Ask me to confirm first</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Show this preview each time (recommended).
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="ofx-future-mode"
                  className="mt-0.5"
                  checked={futureMode === "auto"}
                  onChange={() => setFutureMode("auto")}
                />
                <span>
                  <span className="font-medium">Apply automatically</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Import silently using this Payee source — don&apos;t ask again.
                    Reset anytime on the account&apos;s page → Import preferences.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onConfirm({ payeeSource, dontAskAgain: futureMode === "auto" })
            }
            disabled={submitting}
          >
            {submitting ? "Importing…" : "Import statement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
