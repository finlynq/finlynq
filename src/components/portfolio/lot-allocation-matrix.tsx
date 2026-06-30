/**
 * FINLYNQ — whole-ticker lot allocation matrix (editor).
 *
 * Rendered inside the Lot Inspector as the "Edit all allocations" mode. Lots
 * are rows, editable sells are columns, each cell = shares of that lot the
 * sale consumes. A bottom "Open short" row carries the short remainder. Quick
 * strategies (FIFO / HIFO / LIFO / Current) refill the whole grid at once.
 *
 * Live feedback reuses the SAME pure `planHoldingAllocation` the server
 * validates against (engine.ts is type-only → the planner is client-safe), so
 * the on-screen totals match the committed result. The matrix derives
 * everything from the lots + closures already loaded by the inspector — no
 * refetch. Commit POSTs to /lots/allocate (preview:false).
 */

"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import {
  planHoldingAllocation,
  SHORT_LOT_ID,
  type AllocLot,
  type AllocSell,
  type AllocSpec,
} from "@/lib/portfolio/lots/allocate";

interface LotRow {
  id: number;
  openDate: string;
  side: "long" | "short";
  status: string;
  qtyOriginal: number;
  costPerShare: number;
  currency: string;
  openTxId: number;
}
interface ClosureRow {
  lotId: number;
  closeTxId: number;
  closeDate: string;
  qtyClosed: number;
  proceedsPerShare: number;
  costPerShare: number;
  currency: string;
  closeKind: string;
}

const EPS = 1e-6;
const qf = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export function LotAllocationMatrix({
  holdingId,
  accountId,
  lots,
  closures,
  onCancel,
  onApplied,
}: {
  holdingId: number;
  accountId: number;
  lots: LotRow[];
  closures: ClosureRow[];
  onCancel: () => void;
  onApplied: () => void;
}) {
  // ─── Derive rows (long lots) + columns (editable sells) ─────────────────
  const longLots = useMemo(
    () => lots.filter((l) => l.side === "long").sort((a, b) => a.openDate.localeCompare(b.openDate) || a.id - b.id),
    [lots],
  );
  const nonSellByLot = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of closures) if (c.closeKind !== "sell") m.set(c.lotId, (m.get(c.lotId) ?? 0) + c.qtyClosed);
    return m;
  }, [closures]);
  const availableByLot = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of longLots) m.set(l.id, l.qtyOriginal - (nonSellByLot.get(l.id) ?? 0));
    return m;
  }, [longLots, nonSellByLot]);

  const sells = useMemo(() => {
    const byTx = new Map<number, { closeDate: string; pps: number; currency: string; closed: number }>();
    for (const c of closures) {
      if (c.closeKind !== "sell") continue;
      const cur = byTx.get(c.closeTxId) ?? { closeDate: c.closeDate, pps: c.proceedsPerShare, currency: c.currency, closed: 0 };
      cur.closed += c.qtyClosed;
      byTx.set(c.closeTxId, cur);
    }
    // needed = long-closed + the original short this sell opened.
    const shortByTx = new Map<number, number>();
    for (const l of lots) if (l.side === "short") shortByTx.set(l.openTxId, (shortByTx.get(l.openTxId) ?? 0) + l.qtyOriginal);
    return [...byTx.entries()]
      .map(([txId, m]) => ({ closeTxId: txId, closeDate: m.closeDate, proceedsPerShare: m.pps, currency: m.currency, qty: m.closed + (shortByTx.get(txId) ?? 0) }))
      .sort((a, b) => a.closeDate.localeCompare(b.closeDate) || a.closeTxId - b.closeTxId);
  }, [closures, lots]);

  const currentAlloc = useMemo(() => {
    const a: Record<string, number> = {};
    for (const c of closures) if (c.closeKind === "sell") a[`${c.closeTxId}_${c.lotId}`] = (a[`${c.closeTxId}_${c.lotId}`] ?? 0) + c.qtyClosed;
    for (const l of lots) if (l.side === "short") a[`${l.openTxId}_${SHORT_LOT_ID}`] = (a[`${l.openTxId}_${SHORT_LOT_ID}`] ?? 0) + l.qtyOriginal;
    return a;
  }, [closures, lots]);

  const [alloc, setAlloc] = useState<Record<string, string>>(() => {
    const s: Record<string, string> = {};
    for (const [k, v] of Object.entries(currentAlloc)) if (v > EPS) s[k] = String(v);
    return s;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const elig = (lot: LotRow, sell: { closeDate: string }) => lot.openDate <= sell.closeDate;
  const num = (k: string) => { const n = Number(alloc[k]); return Number.isFinite(n) && n > 0 ? n : 0; };

  // ─── Build the spec + run the shared planner for live feedback ──────────
  const spec: AllocSpec = useMemo(() => {
    const s: AllocSpec = {};
    for (const sell of sells) {
      const entries: Array<{ lotId: number; qty: number }> = [];
      for (const lot of longLots) { const q = num(`${sell.closeTxId}_${lot.id}`); if (q > EPS) entries.push({ lotId: lot.id, qty: q }); }
      const sh = num(`${sell.closeTxId}_${SHORT_LOT_ID}`); if (sh > EPS) entries.push({ lotId: SHORT_LOT_ID, qty: sh });
      s[sell.closeTxId] = entries;
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alloc, sells, longLots]);

  const plan = useMemo(() => {
    const planLots: AllocLot[] = longLots.map((l) => ({ id: l.id, openDate: l.openDate, available: availableByLot.get(l.id) ?? 0, costPerShare: l.costPerShare, currency: l.currency }));
    const planSells: AllocSell[] = sells.map((s) => ({ closeTxId: s.closeTxId, closeDate: s.closeDate, proceedsPerShare: s.proceedsPerShare, qty: s.qty, currency: s.currency }));
    return planHoldingAllocation({ lots: planLots, sells: planSells, spec });
  }, [longLots, sells, availableByLot, spec]);

  const cellGain = useMemo(() => {
    const m = new Map<string, { gain: number; term: "short" | "long" }>();
    for (const c of plan.closures) if (c.lotId != null) m.set(`${c.closeTxId}_${c.lotId}`, { gain: c.realizedGain, term: c.term });
    return m;
  }, [plan]);

  function setCell(sellTx: number, lotId: number, v: string) {
    setErr(null);
    setAlloc((a) => ({ ...a, [`${sellTx}_${lotId}`]: v }));
  }

  function fill(strategy: "fifo" | "hifo" | "lifo" | "current" | "clear") {
    setErr(null);
    if (strategy === "current") {
      const s: Record<string, string> = {};
      for (const [k, v] of Object.entries(currentAlloc)) if (v > EPS) s[k] = String(v);
      setAlloc(s);
      return;
    }
    if (strategy === "clear") { setAlloc({}); return; }
    const next: Record<string, string> = {};
    const rem = new Map<number, number>(longLots.map((l) => [l.id, availableByLot.get(l.id) ?? 0]));
    for (const sell of sells) {
      let need = sell.qty;
      let order = longLots.filter((l) => elig(l, sell));
      if (strategy === "fifo") order = [...order].sort((a, b) => a.openDate.localeCompare(b.openDate));
      if (strategy === "lifo") order = [...order].sort((a, b) => b.openDate.localeCompare(a.openDate));
      if (strategy === "hifo") order = [...order].sort((a, b) => b.costPerShare - a.costPerShare);
      for (const lot of order) {
        if (need <= EPS) break;
        const take = Math.min(need, rem.get(lot.id) ?? 0);
        if (take > EPS) { next[`${sell.closeTxId}_${lot.id}`] = String(+take.toFixed(4)); rem.set(lot.id, (rem.get(lot.id) ?? 0) - take); need -= take; }
      }
      if (need > EPS) next[`${sell.closeTxId}_${SHORT_LOT_ID}`] = String(+need.toFixed(4));
    }
    setAlloc(next);
  }

  async function commit() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/portfolio/holdings/${holdingId}/lots/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, spec, preview: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Save failed (${res.status})`);
      onApplied();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const shortRowActive = useMemo(() => sells.some((s) => num(`${s.closeTxId}_${SHORT_LOT_ID}`) > EPS) || plan.openedShorts.length > 0, [sells, alloc, plan]); // eslint-disable-line react-hooks/exhaustive-deps

  if (sells.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">No editable sell closures on this holding yet. Rebuild the ticker first if your sells show as shorts.</p>
        <div className="flex justify-end"><Button variant="outline" size="sm" onClick={onCancel}>Back</Button></div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium">Edit all allocations</h3>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-muted-foreground">Auto:</span>
          {(["fifo", "hifo", "lifo", "current"] as const).map((s) => (
            <button key={s} type="button" onClick={() => fill(s)} className="text-[11px] rounded-md border border-border px-2 py-1 hover:bg-muted">
              {s === "hifo" ? "HIFO" : s === "current" ? "Current" : s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className={`rounded-md px-3 py-2 text-xs ${plan.ok ? "bg-emerald-50/60 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300" : "bg-rose-50/60 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300"}`}>
        {plan.ok
          ? `Balanced — ${qf(plan.totals.openShares)} sh still open. Net ${plan.totals.realizedGain >= 0 ? "gain " : "loss "}${formatCurrency(plan.totals.realizedGain, sells[0].currency)} (LT ${formatCurrency(plan.totals.longTerm, sells[0].currency)} · ST ${formatCurrency(plan.totals.shortTerm, sells[0].currency)}).`
          : plan.errors[0]}
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-muted/40">
              <th className="text-left font-medium px-3 py-2 sticky left-0 bg-muted/40">Lot</th>
              {sells.map((s) => (
                <th key={s.closeTxId} className="text-right font-medium px-3 py-2 border-b-2 border-primary/40 min-w-[120px]">
                  <div>Sell #{s.closeTxId}</div>
                  <div className="font-normal text-muted-foreground">{s.closeDate} · @ {formatCurrency(s.proceedsPerShare, s.currency)}</div>
                  <div className="font-normal text-muted-foreground">need {qf(s.qty)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {longLots.map((lot) => (
              <tr key={lot.id} className="border-b border-border/60">
                <td className="px-3 py-2 sticky left-0 bg-background">
                  <div className="font-medium">Lot #{lot.id}</div>
                  <div className="text-muted-foreground">opened {lot.openDate} · {qf(availableByLot.get(lot.id) ?? 0)} sh @ {formatCurrency(lot.costPerShare, lot.currency)}</div>
                </td>
                {sells.map((s) => {
                  const k = `${s.closeTxId}_${lot.id}`;
                  const ok = elig(lot, s);
                  const g = cellGain.get(k);
                  return (
                    <td key={s.closeTxId} className="px-3 py-2 text-right align-top">
                      {ok ? (
                        <div className="flex flex-col items-end gap-1">
                          <Input type="number" min={0} step="any" value={alloc[k] ?? ""} placeholder="0"
                            onChange={(e) => setCell(s.closeTxId, lot.id, e.target.value)} className="h-7 w-[84px] text-right tabular-nums" />
                          {g && num(k) > EPS && (
                            <span className={`text-[10px] tabular-nums ${g.gain >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                              {g.gain >= 0 ? "+" : ""}{formatCurrency(g.gain, s.currency)} {g.term === "long" ? "LT" : "ST"}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400" title={`Lot opened ${lot.openDate}, after this sale on ${s.closeDate}.`}>⚠ later</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {shortRowActive && (
              <tr className="border-b border-border/60">
                <td className="px-3 py-2 sticky left-0 bg-background">
                  <div className="font-medium text-rose-600 dark:text-rose-400">Open short</div>
                  <div className="text-muted-foreground">the remainder not closed against a long lot</div>
                </td>
                {sells.map((s) => {
                  const k = `${s.closeTxId}_${SHORT_LOT_ID}`;
                  return (
                    <td key={s.closeTxId} className="px-3 py-2 text-right">
                      <Input type="number" min={0} step="any" value={alloc[k] ?? ""} placeholder="0"
                        onChange={(e) => setCell(s.closeTxId, SHORT_LOT_ID, e.target.value)} className="h-7 w-[84px] text-right tabular-nums" />
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="bg-muted/40 font-medium">
              <td className="px-3 py-2 sticky left-0 bg-muted/40">Allocated / needed</td>
              {sells.map((s) => {
                let sum = num(`${s.closeTxId}_${SHORT_LOT_ID}`);
                for (const lot of longLots) sum += num(`${s.closeTxId}_${lot.id}`);
                const bal = Math.abs(sum - s.qty) <= EPS;
                return (
                  <td key={s.closeTxId} className={`px-3 py-2 text-right tabular-nums ${bal ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                    {qf(sum)} / {qf(s.qty)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      {err && <p className="text-xs text-rose-600 dark:text-rose-400">{err}</p>}

      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => fill("clear")} className="text-[11px] text-muted-foreground hover:underline">Clear</button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={commit} disabled={!plan.ok || busy}>{busy ? "Saving…" : "Save allocation"}</Button>
        </div>
      </div>
    </div>
  );
}
