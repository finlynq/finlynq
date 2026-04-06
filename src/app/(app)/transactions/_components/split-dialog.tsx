"use client";

/**
 * SplitDialog — allows splitting a transaction across multiple categories.
 *
 * Opens a dialog with rows of (category, amount, note). Rows must sum to
 * the transaction total. On confirm, PUTs to /api/transactions/splits.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { Plus, Trash2, Scissors } from "lucide-react";

type Category = { id: number; name: string; type: string; group: string };

type SplitRow = {
  categoryId: string;
  amount: string;
  note: string;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactionId: number;
  totalAmount: number;
  currency: string;
  categories: Category[];
  onSaved: () => void;
}

export function SplitDialog({
  open,
  onOpenChange,
  transactionId,
  totalAmount,
  currency,
  categories,
  onSaved,
}: Props) {
  const [rows, setRows] = useState<SplitRow[]>([
    { categoryId: "", amount: String(Math.abs(totalAmount)), note: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [hasSplits, setHasSplits] = useState(false);

  // Load existing splits when dialog opens
  useEffect(() => {
    if (!open || !transactionId) return;
    fetch(`/api/transactions/splits?transactionId=${transactionId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Array<{ categoryId: number | null; amount: number; note: string }>) => {
        if (data.length > 0) {
          setHasSplits(true);
          setRows(
            data.map((s) => ({
              categoryId: s.categoryId ? String(s.categoryId) : "",
              amount: String(s.amount),
              note: s.note ?? "",
            }))
          );
        } else {
          setHasSplits(false);
          setRows([{ categoryId: "", amount: String(Math.abs(totalAmount)), note: "" }]);
        }
      })
      .catch(() => {});
  }, [open, transactionId, totalAmount]);

  function addRow() {
    setRows([...rows, { categoryId: "", amount: "", note: "" }]);
  }

  function removeRow(index: number) {
    setRows(rows.filter((_, i) => i !== index));
  }

  function updateRow(index: number, field: keyof SplitRow, value: string) {
    setRows(rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  const allocated = rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
  const remaining = Math.abs(totalAmount) - allocated;
  const isBalanced = Math.abs(remaining) < 0.01;

  async function handleSave() {
    setError("");
    if (rows.length < 2) {
      setError("A split requires at least 2 rows.");
      return;
    }
    if (!isBalanced) {
      setError(`Splits must sum to ${formatCurrency(Math.abs(totalAmount), currency)}. Difference: ${formatCurrency(Math.abs(remaining), currency)}`);
      return;
    }

    setSaving(true);
    try {
      const sign = totalAmount < 0 ? -1 : 1;
      const res = await fetch("/api/transactions/splits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionId,
          splits: rows.map((r) => ({
            categoryId: r.categoryId ? parseInt(r.categoryId) : null,
            amount: sign * Math.abs(parseFloat(r.amount) || 0),
            note: r.note,
          })),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to save splits");
        return;
      }
      onSaved();
      onOpenChange(false);
    } catch {
      setError("Failed to save splits");
    } finally {
      setSaving(false);
    }
  }

  async function handleClearSplits() {
    setSaving(true);
    try {
      await fetch(`/api/transactions/splits?transactionId=${transactionId}`, { method: "DELETE" });
      setHasSplits(false);
      setRows([{ categoryId: "", amount: String(Math.abs(totalAmount)), note: "" }]);
      onSaved();
      onOpenChange(false);
    } catch {
      setError("Failed to clear splits");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4" />
            Split Transaction
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total amount</span>
            <span className="font-mono font-semibold">
              {formatCurrency(Math.abs(totalAmount), currency)}
            </span>
          </div>

          {/* Split rows */}
          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="flex gap-2 items-start">
                <div className="flex-1 min-w-0">
                  <Select
                    value={row.categoryId}
                    onValueChange={(v) => updateRow(i, "categoryId", v ?? "")}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Category (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">No category</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.group} — {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={row.amount}
                  onChange={(e) => updateRow(i, "amount", e.target.value)}
                  className="w-24 h-8 text-xs font-mono"
                  placeholder="0.00"
                />
                <Input
                  value={row.note}
                  onChange={(e) => updateRow(i, "note", e.target.value)}
                  className="w-28 h-8 text-xs"
                  placeholder="Note"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground"
                  onClick={() => removeRow(i)}
                  disabled={rows.length <= 1}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          {/* Add row */}
          <Button variant="outline" size="sm" onClick={addRow} className="w-full h-8 text-xs">
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add row
          </Button>

          {/* Balance indicator */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Allocated</span>
            <div className="flex items-center gap-2">
              <span className="font-mono">{formatCurrency(allocated, currency)}</span>
              {isBalanced ? (
                <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-600 bg-emerald-50">
                  Balanced
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] border-rose-300 text-rose-600 bg-rose-50">
                  {remaining > 0 ? `${formatCurrency(remaining, currency)} left` : `${formatCurrency(Math.abs(remaining), currency)} over`}
                </Badge>
              )}
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex gap-2">
            {hasSplits && (
              <Button variant="outline" size="sm" onClick={handleClearSplits} disabled={saving} className="text-xs">
                Clear splits
              </Button>
            )}
            <Button variant="outline" size="sm" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" className="flex-1" onClick={handleSave} disabled={saving || !isBalanced}>
              {saving ? "Saving…" : "Save splits"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
