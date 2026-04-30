"use client";

/**
 * SplitDialog — allows splitting a transaction across multiple categories/accounts.
 *
 * Opens a dialog with rows of (category, account, amount, description, tags). Rows must sum to
 * the transaction total. On confirm, POSTs to /api/transactions/splits.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { Plus, Trash2, Scissors } from "lucide-react";

type Category = { id: number; name: string; type: string; group: string };
type Account = { id: number; name: string; currency: string };

type SplitRow = {
  categoryId: string;
  accountId: string;
  amount: string;
  note: string;
  description: string;
  tags: string;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactionId: number;
  totalAmount: number;
  currency: string;
  categories: Category[];
  accounts: Account[];
  onSaved: () => void;
}

export function SplitDialog({
  open,
  onOpenChange,
  transactionId,
  totalAmount,
  currency,
  categories,
  accounts,
  onSaved,
}: Props) {
  const [rows, setRows] = useState<SplitRow[]>([
    { categoryId: "", accountId: "", amount: String(Math.abs(totalAmount)), note: "", description: "", tags: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [hasSplits, setHasSplits] = useState(false);

  const sortCategory = useDropdownOrder("category");
  const sortAccount = useDropdownOrder("account");

  // Load existing splits when dialog opens
  useEffect(() => {
    if (!open || !transactionId) return;
    fetch(`/api/transactions/splits?transactionId=${transactionId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Array<{ categoryId: number | null; accountId: number | null; amount: number; note: string; description: string; tags: string }>) => {
        if (data.length > 0) {
          setHasSplits(true);
          setRows(
            data.map((s) => ({
              categoryId: s.categoryId ? String(s.categoryId) : "",
              accountId: s.accountId ? String(s.accountId) : "",
              amount: String(s.amount),
              note: s.note ?? "",
              description: s.description ?? "",
              tags: s.tags ?? "",
            }))
          );
        } else {
          setHasSplits(false);
          setRows([{ categoryId: "", accountId: "", amount: String(Math.abs(totalAmount)), note: "", description: "", tags: "" }]);
        }
      })
      .catch(() => {});
  }, [open, transactionId, totalAmount]);

  function addRow() {
    setRows([...rows, { categoryId: "", accountId: "", amount: "", note: "", description: "", tags: "" }]);
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
            accountId: r.accountId ? parseInt(r.accountId) : null,
            amount: sign * Math.abs(parseFloat(r.amount) || 0),
            note: r.note,
            description: r.description,
            tags: r.tags,
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
      setRows([{ categoryId: "", accountId: "", amount: String(Math.abs(totalAmount)), note: "", description: "", tags: "" }]);
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
      <DialogContent className="max-w-2xl">
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

          {/* Column headers */}
          <div className="grid grid-cols-[1fr_1fr_80px_1fr_1fr_32px] gap-1.5 text-[10px] text-muted-foreground font-medium uppercase tracking-wide px-0.5">
            <span>Category</span>
            <span>Account</span>
            <span>Amount</span>
            <span>Note</span>
            <span>Tags</span>
            <span />
          </div>

          {/* Split rows */}
          <div className="space-y-1.5">
            {rows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_80px_1fr_1fr_32px] gap-1.5 items-center">
                <Combobox
                  value={row.categoryId}
                  onValueChange={(v) => updateRow(i, "categoryId", v)}
                  items={sortCategory(
                    categories.map((c): ComboboxItemShape => ({
                      value: String(c.id),
                      label: `${c.group} — ${c.name}`,
                    })),
                    (c) => Number(c.value),
                    (a, z) => a.label.localeCompare(z.label),
                  )}
                  placeholder="Category"
                  searchPlaceholder="Search categories…"
                  emptyMessage="No matches"
                  size="sm"
                  className="h-7 w-full text-xs"
                />
                <Combobox
                  value={row.accountId}
                  onValueChange={(v) => updateRow(i, "accountId", v)}
                  items={sortAccount(
                    accounts.map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name })),
                    (a) => Number(a.value),
                    (a, z) => a.label.localeCompare(z.label),
                  )}
                  placeholder="Account"
                  searchPlaceholder="Search accounts…"
                  emptyMessage="No matches"
                  size="sm"
                  className="h-7 w-full text-xs"
                />
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={row.amount}
                  onChange={(e) => updateRow(i, "amount", e.target.value)}
                  className="h-7 text-xs font-mono"
                  placeholder="0.00"
                />
                <Input
                  value={row.note}
                  onChange={(e) => updateRow(i, "note", e.target.value)}
                  className="h-7 text-xs"
                  placeholder="Note"
                />
                <Input
                  value={row.tags}
                  onChange={(e) => updateRow(i, "tags", e.target.value)}
                  className="h-7 text-xs"
                  placeholder="Tags"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground"
                  onClick={() => removeRow(i)}
                  disabled={rows.length <= 1}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          {/* Add row */}
          <Button variant="outline" size="sm" onClick={addRow} className="w-full h-7 text-xs">
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
