/**
 * FINLYNQ-176 — lot inspector dialog. FINLYNQ-178 — manual lot reassignment.
 *
 * Opened from a per-account holding row in the portfolio All-Holdings table.
 * Fetches GET /api/portfolio/holdings/[holdingId]/lots?accountId=N and shows
 * every lot (open qty, cost basis, side, status) together with the closures
 * that consume it (the sell / transfer-out, with per-closure qty + realized
 * gain).
 *
 * FINLYNQ-178: each SELL closure now carries an "Edit allocation" affordance
 * that opens a lot picker pre-seeded with the closure's current allocation.
 * The user re-points the closure onto lots of their choosing; a preview
 * (opened shorts + restated realized gain) is fetched before they commit
 * (preview-then-commit, mirroring FINLYNQ-176). Posts to
 * POST /api/portfolio/holdings/[holdingId]/lots/reassign. Same-account only.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

interface ReassignPreview {
  proposedClosures: Array<{
    lotId: number;
    qtyClosed: number;
    realizedGain: number;
    isNewShortLot: boolean;
  }>;
  openedShortLots: Array<{ qty: number; currency: string }>;
  realizedGainDeltaByYear: Record<string, number>;
}

const EPS = 1e-6;

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
  const [reloadKey, setReloadKey] = useState(0);

  // FINLYNQ-178 reassignment editor state. `editTxId` is the closeTxId being
  // reallocated; `alloc` maps lotId → qty the user has chosen.
  const [editTxId, setEditTxId] = useState<number | null>(null);
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const [reassignBusy, setReassignBusy] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReassignPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

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
  }, [open, holdingId, accountId, reloadKey]);

  // Reset the editor whenever the dialog (re)opens or the holding changes.
  useEffect(() => {
    setEditTxId(null);
    setAlloc({});
    setPreview(null);
    setReassignError(null);
  }, [open, holdingId, accountId]);

  const closuresByLot = new Map<number, ClosureRow[]>();
  for (const c of closures) {
    const arr = closuresByLot.get(c.lotId) ?? [];
    arr.push(c);
    closuresByLot.set(c.lotId, arr);
  }

  // Closures grouped by the sell tx that produced them (a sell may span lots).
  const closuresByTx = useMemo(() => {
    const m = new Map<number, ClosureRow[]>();
    for (const c of closures) {
      const arr = m.get(c.closeTxId) ?? [];
      arr.push(c);
      m.set(c.closeTxId, arr);
    }
    return m;
  }, [closures]);

  // Open LONG lots available to allocate against (the reassignment target
  // pool). Same-account only — these are already scoped by the GET.
  const openLongLots = useMemo(
    () =>
      lots.filter((l) => l.side === "long" && l.status === "open" && l.qtyRemaining > EPS),
    [lots],
  );

  function startEdit(closeTxId: number) {
    const txClosures = closuresByTx.get(closeTxId) ?? [];
    const seed: Record<number, string> = {};
    for (const c of txClosures) {
      seed[c.lotId] = String((seed[c.lotId] ? Number(seed[c.lotId]) : 0) + c.qtyClosed);
    }
    setEditTxId(closeTxId);
    setAlloc(seed);
    setPreview(null);
    setReassignError(null);
  }

  function cancelEdit() {
    setEditTxId(null);
    setAlloc({});
    setPreview(null);
    setReassignError(null);
  }

  const closureTotalForEdit = useMemo(() => {
    if (editTxId == null) return 0;
    return (closuresByTx.get(editTxId) ?? []).reduce((s, c) => s + c.qtyClosed, 0);
  }, [editTxId, closuresByTx]);

  const allocTotal = useMemo(
    () =>
      Object.values(alloc).reduce((s, v) => {
        const n = Number(v);
        return s + (Number.isFinite(n) && n > 0 ? n : 0);
      }, 0),
    [alloc],
  );

  const sumMatches = Math.abs(allocTotal - closureTotalForEdit) <= EPS;

  function buildPerLotQty() {
    return Object.entries(alloc)
      .map(([lotId, v]) => ({ lotId: Number(lotId), qty: Number(v) }))
      .filter((p) => Number.isFinite(p.qty) && p.qty > EPS);
  }

  async function fetchPreview() {
    if (editTxId == null || holdingId == null) return;
    setPreviewBusy(true);
    setReassignError(null);
    setPreview(null);
    try {
      const res = await fetch(`/api/portfolio/holdings/${holdingId}/lots/reassign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ closeTxId: editTxId, perLotQty: buildPerLotQty(), preview: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Preview failed (${res.status})`);
      setPreview(data.preview as ReassignPreview);
    } catch (e: unknown) {
      setReassignError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewBusy(false);
    }
  }

  async function commitReassign() {
    if (editTxId == null || holdingId == null) return;
    setReassignBusy(true);
    setReassignError(null);
    try {
      const res = await fetch(`/api/portfolio/holdings/${holdingId}/lots/reassign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ closeTxId: editTxId, perLotQty: buildPerLotQty(), preview: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Reassignment failed (${res.status})`);
      // Reload the inspector to reflect the new allocation.
      cancelEdit();
      setReloadKey((k) => k + 1);
    } catch (e: unknown) {
      setReassignError(e instanceof Error ? e.message : "Reassignment failed");
    } finally {
      setReassignBusy(false);
    }
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

        {/* FINLYNQ-178 — reassignment editor (replaces the lot list while open) */}
        {!loading && !error && editTxId != null && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">
                Reassign sell tx #{editTxId}
              </h3>
              <span
                className={`text-xs font-mono ${sumMatches ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
              >
                {allocTotal.toLocaleString()} / {closureTotalForEdit.toLocaleString()} sh
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose how many shares to close from each open lot. The total must
              equal {closureTotalForEdit.toLocaleString()} shares. Requesting more
              than a lot holds opens a short for the overflow.
            </p>

            <div className="space-y-1.5 max-h-[40vh] overflow-y-auto">
              {openLongLots.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No open long lots available — the closure will open a short.
                </p>
              )}
              {openLongLots.map((lot) => (
                <div
                  key={lot.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-1.5 text-xs"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-medium">Lot #{lot.id}</span>
                    <span className="text-muted-foreground">
                      opened {lot.openDate} · {lot.qtyRemaining.toLocaleString()} sh @{" "}
                      {formatCurrency(lot.costPerShare, lot.currency)}
                    </span>
                  </span>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    className="h-7 w-24 text-right"
                    value={alloc[lot.id] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPreview(null);
                      setAlloc((a) => ({ ...a, [lot.id]: v }));
                    }}
                  />
                </div>
              ))}
            </div>

            {reassignError && (
              <p className="text-xs text-rose-600 dark:text-rose-400">{reassignError}</p>
            )}

            {preview && (
              <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 text-xs space-y-1">
                <p className="font-medium text-amber-800 dark:text-amber-300">Preview</p>
                {preview.openedShortLots.length > 0 ? (
                  <p>
                    Opens {preview.openedShortLots.length} short lot
                    {preview.openedShortLots.length > 1 ? "s" : ""} (
                    {preview.openedShortLots.map((s) => s.qty.toLocaleString()).join(", ")} sh).
                  </p>
                ) : (
                  <p>No short lots opened.</p>
                )}
                {Object.keys(preview.realizedGainDeltaByYear).length > 0 ? (
                  <p>
                    Restates realized gain:{" "}
                    {Object.entries(preview.realizedGainDeltaByYear)
                      .map(([y, d]) => `${y}: ${d >= 0 ? "+" : ""}${d.toLocaleString()}`)
                      .join(", ")}
                  </p>
                ) : (
                  <p>Realized gain unchanged.</p>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={cancelEdit} disabled={reassignBusy}>
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchPreview}
                disabled={!sumMatches || previewBusy || reassignBusy}
              >
                {previewBusy ? "Previewing…" : "Preview"}
              </Button>
              <Button
                size="sm"
                onClick={commitReassign}
                disabled={!sumMatches || reassignBusy}
              >
                {reassignBusy ? "Saving…" : "Reassign"}
              </Button>
            </div>
          </div>
        )}

        {!loading && !error && editTxId == null && lots.length > 0 && (
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
                            {c.closeKind === "sell" && (
                              <button
                                type="button"
                                className="text-[11px] text-primary underline-offset-2 hover:underline"
                                onClick={() => startEdit(c.closeTxId)}
                              >
                                Edit allocation
                              </button>
                            )}
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
