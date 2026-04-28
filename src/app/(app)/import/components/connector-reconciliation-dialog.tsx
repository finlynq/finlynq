"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

interface ReconciliationRow {
  externalAccountId: string;
  finlynqAccountId: number;
  accountName: string;
  currency: string;
  wpBalance: number;
  pfBalance: number;
  diff: number;
  matches: boolean;
}

interface ReconciliationResponse {
  date: string;
  rows: ReconciliationRow[];
  unmatchedExternal: string[];
}

interface ConnectorReconciliationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function ConnectorReconciliationDialog({ open, onOpenChange }: ConnectorReconciliationDialogProps) {
  const [date, setDate] = useState<string>(todayIsoDate());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReconciliationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adjustingId, setAdjustingId] = useState<number | null>(null);

  const fetchReconciliation = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/import/connectors/wealthposition/reconcile?date=${encodeURIComponent(date)}`,
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ReconciliationResponse;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconcile failed");
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    if (open) fetchReconciliation();
  }, [open, fetchReconciliation]);

  const addAdjustment = useCallback(
    async (row: ReconciliationRow) => {
      setAdjustingId(row.finlynqAccountId);
      try {
        const res = await fetch("/api/import/connectors/wealthposition/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            finlynqAccountId: row.finlynqAccountId,
            date: "1970-01-01",
            amount: row.diff,
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        await fetchReconciliation();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Adjustment failed");
      } finally {
        setAdjustingId(null);
      }
    },
    [fetchReconciliation],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Balance reconciliation</DialogTitle>
          <DialogDescription>
            Compare each mapped account&rsquo;s balance as of a date. Any mismatch is likely due
            to missing opening balances before WP&rsquo;s oldest imported transaction.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label className="text-xs">Reconcile as of</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 text-sm" />
          </div>
          <Button onClick={fetchReconciliation} disabled={loading}>
            {loading && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Check
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">WP balance</TableHead>
                  <TableHead className="text-right">Finlynq sum</TableHead>
                  <TableHead className="text-right">Diff</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row) => (
                  <TableRow key={row.finlynqAccountId}>
                    <TableCell className="font-medium">
                      {row.accountName}
                      <span className="text-muted-foreground ml-1">({row.currency})</span>
                    </TableCell>
                    <TableCell className="text-right font-mono">{row.wpBalance.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono">{row.pfBalance.toFixed(2)}</TableCell>
                    <TableCell
                      className={`text-right font-mono ${
                        row.matches ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {row.matches ? (
                        <span className="inline-flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" /> 0.00
                        </span>
                      ) : (
                        row.diff.toFixed(2)
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!row.matches && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => addAdjustment(row)}
                          disabled={adjustingId === row.finlynqAccountId}
                        >
                          {adjustingId === row.finlynqAccountId ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            "Add opening balance"
                          )}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {result.unmatchedExternal.length > 0 && (
              <div className="text-xs text-muted-foreground">
                {result.unmatchedExternal.length} external account{result.unmatchedExternal.length === 1 ? "" : "s"}{" "}
                in your mapping were not returned by WealthPosition for this date.
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
