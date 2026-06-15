/**
 * FINLYNQ-176 — read-only lot inspector dialog.
 *
 * Opened from a per-account holding row in the portfolio All-Holdings table.
 * Fetches GET /api/portfolio/holdings/[holdingId]/lots?accountId=N and shows
 * every lot (open qty, cost basis, side, status) together with the closures
 * that consume it (the sell / transfer-out, with per-closure qty + realized
 * gain). Read-only — no mutation affordance (manual lot reassignment is a
 * separate fast-follow ticket).
 */

"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";

interface LotRow {
  id: number;
  accountId: number;
  openTxId: number;
  openDate: string;
  side: "long" | "short";
  origin: string;
  status: string;
  qtyOriginal: number;
  qtyRemaining: number;
  costPerShare: number;
  currency: string;
}
interface ClosureRow {
  id: number;
  lotId: number;
  closeTxId: number;
  closeDate: string;
  qtyClosed: number;
  proceedsPerShare: number;
  costPerShare: number;
  realizedGain: number;
  currency: string;
  closeKind: string;
}

export function LotInspectorDialog({
  open,
  onOpenChange,
  holdingId,
  accountId,
  holdingName,
  accountName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  holdingId: number | null;
  accountId: number | null;
  holdingName?: string;
  accountName?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [closures, setClosures] = useState<ClosureRow[]>([]);

  useEffect(() => {
    if (!open || holdingId == null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = accountId != null ? `?accountId=${accountId}` : "";
    fetch(`/api/portfolio/holdings/${holdingId}/lots${qs}`)
      .then(async (res) => {
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d?.error ?? `Failed to load lots (${res.status})`);
        }
        return res.json();
      })
      .then((data: { lots: LotRow[]; closures: ClosureRow[] }) => {
        if (cancelled) return;
        setLots(data.lots ?? []);
        setClosures(data.closures ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load lots");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, holdingId, accountId]);

  const closuresByLot = new Map<number, ClosureRow[]>();
  for (const c of closures) {
    const arr = closuresByLot.get(c.lotId) ?? [];
    arr.push(c);
    closuresByLot.set(c.lotId, arr);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            Lot inspector
            {holdingName ? <span className="text-muted-foreground font-normal"> — {holdingName}</span> : null}
            {accountName ? <span className="text-muted-foreground font-normal text-sm"> ({accountName})</span> : null}
          </DialogTitle>
        </DialogHeader>

        {loading && <p className="text-sm text-muted-foreground">Loading lots…</p>}
        {error && !loading && (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        )}
        {!loading && !error && lots.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No lots tracked for this holding yet.
          </p>
        )}

        {!loading && !error && lots.length > 0 && (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {lots.map((lot) => {
              const lotClosures = closuresByLot.get(lot.id) ?? [];
              return (
                <div
                  key={lot.id}
                  className="rounded-md border border-border overflow-hidden"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-3 py-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">Lot #{lot.id}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {lot.side}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {lot.origin}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${lot.status === "open" ? "border-emerald-500 text-emerald-600 dark:text-emerald-400" : ""}`}
                      >
                        {lot.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        opened {lot.openDate}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-muted-foreground">
                      {lot.qtyRemaining.toLocaleString()} / {lot.qtyOriginal.toLocaleString()} sh
                      {" @ "}
                      {formatCurrency(lot.costPerShare, lot.currency)}
                    </div>
                  </div>
                  {lotClosures.length > 0 ? (
                    <ul className="divide-y divide-border/60 text-xs">
                      {lotClosures.map((c) => (
                        <li
                          key={c.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5"
                        >
                          <span className="text-muted-foreground">
                            {c.closeKind} · tx #{c.closeTxId} · {c.closeDate}
                          </span>
                          <span className="flex items-center gap-3 font-mono">
                            <span>{c.qtyClosed.toLocaleString()} sh</span>
                            <span className="text-muted-foreground">
                              @ {formatCurrency(c.proceedsPerShare, c.currency)}
                            </span>
                            <span
                              className={
                                c.realizedGain >= 0
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-rose-600 dark:text-rose-400"
                              }
                            >
                              {c.realizedGain >= 0 ? "+" : ""}
                              {formatCurrency(c.realizedGain, c.currency)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="px-3 py-1.5 text-xs text-muted-foreground">
                      No closures — fully open.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
