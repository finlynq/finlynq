"use client";

/**
 * Manage-prices dialog for a manually-priced security (price_source='manual').
 *
 * Lists the security's `custom_security_prices` marks (one per date, newest
 * first) with delete, plus an add form (date + price). The "effective price at
 * date D" the valuation paths read is the latest mark on-or-before D
 * (forward-fill); before the first mark the holding values at 0. Modeled on the
 * FX-overrides editor. Wired to /api/securities/prices (DEK-free). → custom-prices.ts
 */

import { useCallback, useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/date-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { parseSaveError } from "@/lib/save-error";
import { formatCurrency } from "@/lib/currency";
import { todayISO } from "@/lib/utils/date";
import { Loader2, Trash2 } from "lucide-react";

type Mark = { id: number; date: string; price: number; currency: string };

export function ManagePricesDialog({
  securityId,
  securityLabel,
  currency,
  open,
  onOpenChange,
  onChanged,
}: {
  securityId: number | null;
  securityLabel: string;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a mark is added/deleted so the parent can refresh its list. */
  onChanged: () => void;
}) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [loading, setLoading] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [price, setPrice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (securityId == null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/securities/prices?securityId=${securityId}`);
      if (res.ok) {
        const json = await res.json();
        setMarks((json.data ?? []) as Mark[]);
      }
    } finally {
      setLoading(false);
    }
  }, [securityId]);

  useEffect(() => {
    if (open) {
      setDate(todayISO());
      setPrice("");
      setError("");
      load();
    }
  }, [open, load]);

  async function submit() {
    const value = Number(price);
    if (!price.trim() || !Number.isFinite(value) || value < 0) {
      setError("Enter a price (0 or more)");
      return;
    }
    if (securityId == null) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/securities/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ securityId, date, price: value }),
      });
      if (!res.ok) {
        setError(await parseSaveError(res, "Failed to save price"));
        return;
      }
      setPrice("");
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save price");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (deleteId == null) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/securities/prices?id=${deleteId}`, { method: "DELETE" });
      if (res.ok) {
        setDeleteId(null);
        await load();
        onChanged();
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Prices · {securityLabel}</DialogTitle>
            <DialogDescription>
              Enter what this holding is worth, with an effective date. The most recent
              price on or before any date is used to value it; before your first price it
              counts as 0. Amounts are in {currency}.
            </DialogDescription>
          </DialogHeader>

          {/* Existing marks */}
          <div className="rounded-md border divide-y max-h-56 overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : marks.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                No prices yet — add one below.
              </div>
            ) : (
              marks.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="font-mono tabular-nums text-muted-foreground">{m.date}</span>
                  <span className="ml-auto font-medium tabular-nums">
                    {formatCurrency(m.price, m.currency)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => setDeleteId(m.id)}
                    title="Delete this price"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                  </Button>
                </div>
              ))
            )}
          </div>

          {/* Add a mark */}
          <div className="grid grid-cols-[1fr_1fr] gap-3 items-end">
            <DatePicker value={date} onChange={setDate} max={todayISO()} label="Effective date" />
            <div className="space-y-1">
              <Label>Price ({currency})</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>
          {error && <p className="text-xs text-rose-600">{error}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Close
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "Saving…" : "Add price"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId != null}
        onOpenChange={(o) => {
          if (!o) setDeleteId(null);
        }}
        title="Delete price"
        description="Remove this price mark? The holding will fall back to the next most recent price (or 0)."
        confirmLabel="Delete"
        busyLabel="Deleting…"
        busy={deleting}
        onConfirm={confirmDelete}
      />
    </>
  );
}
