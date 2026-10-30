"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getMonthLabel } from "@/lib/currency";
import { budgetApi } from "./budget-api";

/** Set what a rollover line carries into a month (a starting balance or a correction). */
export function CarryoverDialog({
  target,
  month,
  currency,
  onClose,
  onSaved,
}: {
  target: { key: string; name: string; carriedIn: number } | null;
  month: string;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (target) {
      setText(String(target.carriedIn));
      setError("");
    }
  }, [target]);

  async function save(amount: number | null) {
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      await budgetApi.carryover(target.key, month, amount);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={target != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Carried into {getMonthLabel(month)}: {target?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            The amount this line starts {getMonthLabel(month)} with. Later months carry on from here. Use a negative amount to start
            with a deficit.
          </p>
          <div>
            <Label>Amount ({currency})</Label>
            <Input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" onClick={() => void save(null)} disabled={busy} title="Remove this month's pin and work the carry out from earlier months">
              Remove my edit
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const n = Number(text.replace(/,/g, ""));
                  if (!Number.isFinite(n) || text.trim() === "") {
                    setError("Enter an amount");
                    return;
                  }
                  void save(n);
                }}
                disabled={busy}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
