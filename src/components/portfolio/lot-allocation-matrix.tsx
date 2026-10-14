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
 *
 * Layout: compact + fullscreen-friendly (flex column, the grid scrolls with a
 * sticky header row + sticky lot column). A sales date/year filter + a
 * "used lots only" toggle shrink the visible grid WITHOUT changing the spec —
 * the plan, validation, and commit always span EVERY editable sell + lot
 * (applyHoldingAllocation reverses + re-closes all of them, so a hidden,
 * unbalanced sell still surfaces in the banner).
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
import { shortOpenedBySale } from "@/lib/portfolio/lots/sale-lot-choices";
import { coveredShortMessage } from "@/lib/portfolio/lots/reassign-errors";

interface LotRow {
  id: number;
  openDate: string;
  side: "long" | "short";
  status: string;
  qtyOriginal: number;
  qtyRemaining: number;
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

  // An oversold sale whose short a later buy already closed: saving would
  // delete that closing and bring the short back open (nothing replays the
  // buy), so the server refuses and the grid can't be saved.
  const coveredShort =
    sells
      .map((s) => ({ closeTxId: s.closeTxId, ...shortOpenedBySale(lots, s.closeTxId) }))
      .filter((s) => s.covered > EPS)
      .map((s) => ({ closeTxId: s.closeTxId, shortQty: s.qty, coveredQty: s.covered }))[0] ?? null;

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

  // ─── Filters (display-only; spec/plan/commit always span ALL sells+lots) ─
  const sellYears = useMemo(
    () => [...new Set(sells.map((s) => s.closeDate.slice(0, 4)))].sort((a, b) => b.localeCompare(a)),
    [sells],
  );
  const [yearFilter, setYearFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [onlyUsedLots, setOnlyUsedLots] = useState(false);

  const lotYears = useMemo(
    () => [...new Set(longLots.map((l) => l.openDate.slice(0, 4)))].sort((a, b) => b.localeCompare(a)),
    [longLots],
  );
  const [buyYear, setBuyYear] = useState<string>("all");
  const [buyFrom, setBuyFrom] = useState("");
  const [buyTo, setBuyTo] = useState("");

  const elig = (lot: LotRow, sell: { closeDate: string }) => lot.openDate <= sell.closeDate;
  const num = (k: string) => { const n = Number(alloc[k]); return Number.isFinite(n) && n > 0 ? n : 0; };

  const visibleSells = useMemo(
    () =>
      sells.filter((s) => {
        if (yearFilter !== "all" && s.closeDate.slice(0, 4) !== yearFilter) return false;
        if (fromDate && s.closeDate < fromDate) return false;
        if (toDate && s.closeDate > toDate) return false;
        return true;
      }),
    [sells, yearFilter, fromDate, toDate],
  );
  const visibleLots = useMemo(() => {
    let ls = longLots.filter((lot) => {
      if (buyYear !== "all" && lot.openDate.slice(0, 4) !== buyYear) return false;
      if (buyFrom && lot.openDate < buyFrom) return false;
      if (buyTo && lot.openDate > buyTo) return false;
      return true;
    });
    if (onlyUsedLots) {
      ls = ls.filter((lot) => visibleSells.some((s) => elig(lot, s) || num(`${s.closeTxId}_${lot.id}`) > EPS));
    }
    return ls;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [longLots, visibleSells, onlyUsedLots, buyYear, buyFrom, buyTo, alloc]);
  const filtered = visibleSells.length !== sells.length || visibleLots.length !== longLots.length;

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

  // Per-lot row totals (across ALL sells, not just the visible/filtered ones —
  // this is the quantity the per-lot over-allocation guard validates, so it
  // must surface even when a sell is filtered out of view).
  const lotAllocated = useMemo(() => {
    const m = new Map<number, number>();
    for (const lot of longLots) {
      let sum = 0;
      for (const s of sells) sum += num(`${s.closeTxId}_${lot.id}`);
      m.set(lot.id, sum);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [longLots, sells, alloc]);
  const shortAllocated = useMemo(() => {
    let sum = 0;
    for (const s of sells) sum += num(`${s.closeTxId}_${SHORT_LOT_ID}`);
    return sum;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sells, alloc]);

  if (sells.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">No editable sell closures on this holding yet. Rebuild the ticker first if your sells show as shorts.</p>
        <div className="flex justify-end"><Button variant="outline" size="sm" onClick={onCancel}>Back</Button></div>
      </div>
    );
  }

  const cur = sells[0].currency;
  const thBase = "px-2 py-1.5 text-right font-medium align-bottom whitespace-nowrap";
  const tdBase = "px-2 py-1 text-right align-top whitespace-nowrap";
  // md:text-[10px] is REQUIRED: the base Input carries `md:text-sm`, a md:
  // responsive variant that beats a plain `text-[10px]` at ≥768px — so the
  // override must also be md:-prefixed for tailwind-merge to drop md:text-sm.
  const inputCls = "h-6 w-[58px] px-1 text-right text-[10px] md:text-[10px] tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-2.5">
      {/* Toolbar: strategies + filters */}
      <div className="shrink-0 flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium">Edit all allocations</h3>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-muted-foreground">Auto:</span>
          {(["fifo", "hifo", "lifo", "current"] as const).map((s) => (
            <button key={s} type="button" onClick={() => fill(s)} className="text-[11px] rounded-md border border-border px-2 py-0.5 hover:bg-muted">
              {s === "hifo" ? "HIFO" : s === "current" ? "Current" : s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="shrink-0 space-y-1 text-[11px] text-muted-foreground">
        {/* Sales filter — columns */}
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
          <span className="font-medium w-9 shrink-0">Sales:</span>
          <div className="flex items-center gap-1 flex-wrap">
            <button type="button" onClick={() => { setYearFilter("all"); setFromDate(""); setToDate(""); }}
              className={`rounded-md border px-2 py-0.5 ${yearFilter === "all" && !fromDate && !toDate ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted"}`}>
              All
            </button>
            {sellYears.map((y) => (
              <button key={y} type="button" onClick={() => { setYearFilter(y); setFromDate(""); setToDate(""); }}
                className={`rounded-md border px-2 py-0.5 ${yearFilter === y ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted"}`}>
                {y}
              </button>
            ))}
          </div>
          <span className="text-border">|</span>
          <label className="flex items-center gap-1">From
            <Input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setYearFilter("all"); }} className="h-6 w-[130px] text-[11px] px-1.5" />
          </label>
          <label className="flex items-center gap-1">To
            <Input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setYearFilter("all"); }} className="h-6 w-[130px] text-[11px] px-1.5" />
          </label>
        </div>
        {/* Buys filter — rows */}
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
          <span className="font-medium w-9 shrink-0">Buys:</span>
          <div className="flex items-center gap-1 flex-wrap">
            <button type="button" onClick={() => { setBuyYear("all"); setBuyFrom(""); setBuyTo(""); }}
              className={`rounded-md border px-2 py-0.5 ${buyYear === "all" && !buyFrom && !buyTo ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted"}`}>
              All
            </button>
            {lotYears.map((y) => (
              <button key={y} type="button" onClick={() => { setBuyYear(y); setBuyFrom(""); setBuyTo(""); }}
                className={`rounded-md border px-2 py-0.5 ${buyYear === y ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted"}`}>
                {y}
              </button>
            ))}
          </div>
          <span className="text-border">|</span>
          <label className="flex items-center gap-1">From
            <Input type="date" value={buyFrom} onChange={(e) => { setBuyFrom(e.target.value); setBuyYear("all"); }} className="h-6 w-[130px] text-[11px] px-1.5" />
          </label>
          <label className="flex items-center gap-1">To
            <Input type="date" value={buyTo} onChange={(e) => { setBuyTo(e.target.value); setBuyYear("all"); }} className="h-6 w-[130px] text-[11px] px-1.5" />
          </label>
          <span className="text-border">|</span>
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={onlyUsedLots} onChange={(e) => setOnlyUsedLots(e.target.checked)} className="h-3.5 w-3.5 accent-primary" />
            Used lots only
          </label>
          {filtered && (
            <span className="text-muted-foreground/80">· {visibleSells.length}/{sells.length} sales, {visibleLots.length}/{longLots.length} lots</span>
          )}
        </div>
      </div>

      {coveredShort && (
        <div className="shrink-0 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          {coveredShortMessage(coveredShort)}
        </div>
      )}

      <div className={`shrink-0 rounded-md px-3 py-1.5 text-xs ${plan.ok ? "bg-emerald-50/60 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300" : "bg-rose-50/60 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300"}`}>
        {plan.ok
          ? `Balanced — ${qf(plan.totals.openShares)} sh still open. Net ${plan.totals.realizedGain >= 0 ? "gain " : "loss "}${formatCurrency(plan.totals.realizedGain, cur)} (LT ${formatCurrency(plan.totals.longTerm, cur)} · ST ${formatCurrency(plan.totals.shortTerm, cur)}).`
          : plan.errors[0]}
      </div>

      <div className="shrink-0 text-[11px] text-muted-foreground">
        Each <span className="font-medium text-foreground">row is a buy lot</span> (a purchase) · each <span className="font-medium text-foreground">column is a sell</span>. A cell = shares of that lot the sale closes; the <span className="text-rose-600 dark:text-rose-400">Open short</span> row holds any remainder.
      </div>

      {/* Scrollable grid — sticky header row + sticky lot column + sticky total column */}
      <div className="flex-1 min-h-0 overflow-auto rounded-md border border-border">
        <table className="text-[11px] border-collapse">
          <thead>
            <tr>
              <th className={`${thBase} text-left sticky left-0 top-0 z-20 bg-muted min-w-[150px]`}>
                <div className="text-foreground">Buy lots <span className="font-normal text-muted-foreground">↓</span></div>
                <div className="font-normal text-muted-foreground">sells →</div>
              </th>
              {visibleSells.map((s) => (
                <th key={s.closeTxId} className={`${thBase} sticky top-0 z-10 bg-muted border-b-2 border-primary/40 min-w-[92px]`}>
                  <div className="font-medium text-foreground">Sell #{s.closeTxId}</div>
                  <div className="font-normal text-muted-foreground">{s.closeDate}</div>
                  <div className="font-normal text-muted-foreground">@{formatCurrency(s.proceedsPerShare, s.currency)}</div>
                  <div className="font-normal text-muted-foreground/80">need {qf(s.qty)}</div>
                </th>
              ))}
              <th className={`${thBase} sticky right-0 top-0 z-20 bg-muted border-l border-border min-w-[92px]`}>
                <div className="text-foreground">Lot total</div>
                <div className="font-normal text-muted-foreground">alloc / avail</div>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleLots.map((lot) => (
              <tr key={lot.id} className="border-b border-border/60">
                <td className={`${tdBase} text-left sticky left-0 z-10 bg-background`}>
                  <div className="font-medium">Lot #{lot.id}</div>
                  <div className="text-muted-foreground">{lot.openDate} · {qf(availableByLot.get(lot.id) ?? 0)} @ {formatCurrency(lot.costPerShare, lot.currency)}</div>
                </td>
                {visibleSells.map((s) => {
                  const k = `${s.closeTxId}_${lot.id}`;
                  const ok = elig(lot, s);
                  const g = cellGain.get(k);
                  return (
                    <td key={s.closeTxId} className={tdBase}>
                      {ok ? (
                        <div className="flex flex-col items-end gap-0.5">
                          <Input type="number" min={0} step="any" value={alloc[k] ?? ""} placeholder="0"
                            onChange={(e) => setCell(s.closeTxId, lot.id, e.target.value)} className={inputCls} />
                          {g && num(k) > EPS && (
                            <span className={`text-[9px] leading-none tabular-nums ${g.gain >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                              {g.gain >= 0 ? "+" : ""}{formatCurrency(g.gain, s.currency)} {g.term === "long" ? "LT" : "ST"}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[9px] text-amber-600 dark:text-amber-400" title={`Lot opened ${lot.openDate}, after this sale on ${s.closeDate}.`}>⚠ later</span>
                      )}
                    </td>
                  );
                })}
                {(() => {
                  const used = lotAllocated.get(lot.id) ?? 0;
                  const avail = availableByLot.get(lot.id) ?? 0;
                  const over = used > avail + EPS;
                  return (
                    <td className={`${tdBase} sticky right-0 z-10 bg-background border-l border-border tabular-nums ${over ? "text-rose-600 dark:text-rose-400 font-medium" : used > EPS ? "text-foreground" : "text-muted-foreground"}`}
                      title={over ? `Over-allocated: ${qf(used)} sh assigned but the lot only has ${qf(avail)} sh.` : undefined}>
                      {qf(used)} / {qf(avail)}
                    </td>
                  );
                })()}
              </tr>
            ))}
            {shortRowActive && (
              <tr className="border-b border-border/60">
                <td className={`${tdBase} text-left sticky left-0 z-10 bg-background`}>
                  <div className="font-medium text-rose-600 dark:text-rose-400">Open short</div>
                  <div className="text-muted-foreground">remainder not closed against a long lot</div>
                </td>
                {visibleSells.map((s) => {
                  const k = `${s.closeTxId}_${SHORT_LOT_ID}`;
                  return (
                    <td key={s.closeTxId} className={tdBase}>
                      <Input type="number" min={0} step="any" value={alloc[k] ?? ""} placeholder="0"
                        onChange={(e) => setCell(s.closeTxId, SHORT_LOT_ID, e.target.value)} className={inputCls} />
                    </td>
                  );
                })}
                <td className={`${tdBase} sticky right-0 z-10 bg-background border-l border-border tabular-nums text-rose-600 dark:text-rose-400`}>
                  {qf(shortAllocated)}
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <td className={`${tdBase} text-left sticky left-0 bottom-0 z-20 bg-muted`}>Allocated / needed</td>
              {visibleSells.map((s) => {
                let sum = num(`${s.closeTxId}_${SHORT_LOT_ID}`);
                for (const lot of longLots) sum += num(`${s.closeTxId}_${lot.id}`);
                const bal = Math.abs(sum - s.qty) <= EPS;
                return (
                  <td key={s.closeTxId} className={`${tdBase} sticky bottom-0 z-[1] bg-muted tabular-nums ${bal ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                    {qf(sum)} / {qf(s.qty)}
                  </td>
                );
              })}
              {(() => {
                let used = 0, avail = 0;
                for (const lot of longLots) { used += lotAllocated.get(lot.id) ?? 0; avail += availableByLot.get(lot.id) ?? 0; }
                const over = used > avail + EPS;
                return (
                  <td className={`${tdBase} sticky right-0 bottom-0 z-20 bg-muted border-l border-border tabular-nums ${over ? "text-rose-600 dark:text-rose-400" : "text-foreground"}`}>
                    {qf(used)} / {qf(avail)}
                  </td>
                );
              })()}
            </tr>
          </tfoot>
        </table>
      </div>

      {err && <p className="shrink-0 text-xs text-rose-600 dark:text-rose-400">{err}</p>}

      <div className="shrink-0 flex items-center justify-between gap-2">
        <button type="button" onClick={() => fill("clear")} className="text-[11px] text-muted-foreground hover:underline">Clear all</button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={commit} disabled={!plan.ok || busy || coveredShort != null}>{busy ? "Saving…" : "Save allocation"}</Button>
        </div>
      </div>
    </div>
  );
}
