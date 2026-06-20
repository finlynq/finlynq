"use client";

/**
 * Realized-gain dashboard — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * Reads /api/portfolio/realized-gains; renders one row per
 * holding_lot_closures row, sorted newest first. Tax-year + term
 * (short/long) filter chips on top; CSV export button hits the same
 * endpoint with `format=csv`.
 *
 * Empty-state copy is "No closed lots yet" rather than "no data" —
 * users whose lots backfill hasn't run yet (portfolio_lots_status not
 * populated) see this naturally.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, ArrowDownLeft, ArrowUpLeft, RefreshCw, Coins } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useDisplayCurrency } from "@/components/currency-provider";
import { exportCsv, type CsvColumn } from "@/lib/csv-export";

// Phase 3 follow-up (2026-05-26): short_close = a Buy that covered a short
// position; gain inverts (cost − buy_price). short_open = the audit-marker
// row written when a Sell overflows into a new short lot. The other
// close_kind values are normal long-position closures + special cases.
const CLOSE_KIND_META: Record<string, { icon: typeof ArrowDownLeft; label: string; className: string; tooltip: string }> = {
  short_open: {
    icon: ArrowDownLeft,
    label: "Short open",
    className: "border-rose-500 text-rose-600 dark:border-rose-400 dark:text-rose-400",
    tooltip: "Short opened — a Sell exceeded the open longs and opened a new side='short' lot at the sell price.",
  },
  short_close: {
    icon: ArrowUpLeft,
    label: "Short close",
    className: "border-amber-500 text-amber-600 dark:border-amber-400 dark:text-amber-400",
    tooltip: "Short covered — a Buy on this holding/account closed an open short lot. Realized gain = (open cost − buy price) × qty.",
  },
  swap_out: {
    icon: RefreshCw,
    label: "Swap",
    className: "border-sky-500 text-sky-600 dark:border-sky-400 dark:text-sky-400",
    tooltip: "Closure originated from a Swap (sell-out leg of an in-place rebalance).",
  },
  fx_conversion: {
    icon: Coins,
    label: "Currency",
    className: "border-violet-500 text-violet-600 dark:border-violet-400 dark:text-violet-400",
    tooltip: "Currency-on-currency FX gain — a cash lot in this sleeve was closed by an FX conversion. The realized gain in the sleeve currency is 0 (cost=1, proceeds=1); the actual gain shows in the unified display-currency view (toggle above).",
  },
};

interface ApiRow {
  closureId: number;
  closeDate: string;
  openDate: string;
  holdingId: number;
  holdingName: string | null;
  accountId: number;
  accountName: string | null;
  qtyClosed: number;
  proceedsPerShare: number;
  costPerShare: number;
  realizedGain: number;
  currency: string;
  daysHeld: number;
  term: "short" | "long";
  closeKind: string;
  realizedGainInBase?: number;
  baseCurrency?: string;
}

interface ApiResponse {
  success: boolean;
  data: {
    rows: ApiRow[];
    totals: {
      realizedGain: number;
      qtyClosed: number;
      rowCount: number;
      byCurrency: Record<string, { realizedGain: number; qtyClosed: number }>;
    };
    totalRealizedGainInBase?: number;
  };
}

const CURRENT_YEAR = new Date().getFullYear();

// FINLYNQ-193 — group-by modes for the rolled-up view. "off" keeps the
// flat one-row-per-closure list (the legacy view).
type GroupMode = "off" | "holding" | "account" | "holding_account";

const GROUP_MODE_LABELS: Record<GroupMode, string> = {
  off: "Off",
  holding: "By holding",
  account: "By account",
  holding_account: "Holding + account",
};

/**
 * One rolled-up group row. Aggregates qty + realized gain across its member
 * closures. We ALWAYS sum the unified (display-currency) gain — grouping is
 * only ever enabled in the unified view (see the mixed-currency rule below),
 * so summing across a group never crosses native currencies.
 */
interface GroupRow {
  key: string;
  holdingLabel: string;
  accountLabel: string;
  qtyClosed: number;
  /** Sum of member `realizedGainInBase` (unified display currency). */
  realizedGain: number;
  closureCount: number;
  earliestClose: string;
  latestClose: string;
}

const holdingLabelOf = (r: ApiRow) => r.holdingName ?? `#${r.holdingId}`;
const accountLabelOf = (r: ApiRow) => r.accountName ?? `#${r.accountId}`;

/**
 * Aggregate flat closure rows into group rows. Pure. Caller guarantees
 * `unified` rows carry `realizedGainInBase` (grouping is unified-only), so the
 * summed gain is always in a single currency and never crosses native ccys.
 */
function buildGroupRows(rows: ApiRow[], mode: GroupMode): GroupRow[] {
  const map = new Map<string, GroupRow>();
  for (const r of rows) {
    const hLabel = holdingLabelOf(r);
    const aLabel = accountLabelOf(r);
    let key: string;
    if (mode === "holding") key = `h:${r.holdingId}`;
    else if (mode === "account") key = `a:${r.accountId}`;
    else key = `h:${r.holdingId}|a:${r.accountId}`; // holding_account
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        holdingLabel: mode === "account" ? "" : hLabel,
        accountLabel: mode === "holding" ? "" : aLabel,
        qtyClosed: 0,
        realizedGain: 0,
        closureCount: 0,
        earliestClose: r.closeDate,
        latestClose: r.closeDate,
      };
      map.set(key, g);
    }
    g.qtyClosed += r.qtyClosed;
    g.realizedGain += r.realizedGainInBase ?? 0;
    g.closureCount += 1;
    if (r.closeDate < g.earliestClose) g.earliestClose = r.closeDate;
    if (r.closeDate > g.latestClose) g.latestClose = r.closeDate;
  }
  // Sort by absolute realized gain desc — largest movers first.
  return [...map.values()].sort(
    (a, b) => Math.abs(b.realizedGain) - Math.abs(a.realizedGain),
  );
}

export default function RealizedGainsPage() {
  const { displayCurrency } = useDisplayCurrency();
  const [taxYear, setTaxYear] = useState<number | null>(CURRENT_YEAR);
  const [term, setTerm] = useState<"all" | "short" | "long">("all");
  // FINLYNQ-183: the toggle now switches between per-row native currency and
  // the unified DISPLAY-currency view (there is no separate "base currency").
  const [showUnified, setShowUnified] = useState(false);
  // FINLYNQ-193 — additive view options (component-state only, resets on
  // reload; matches the FINLYNQ-129/172 toggle precedent).
  const [hideZero, setHideZero] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>("off");
  const [data, setData] = useState<ApiResponse["data"] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams();
    if (taxYear) params.set("taxYear", String(taxYear));
    params.set("term", term);
    if (showUnified) params.set("unified", "1");
    setLoading(true);
    fetch(`/api/portfolio/realized-gains?${params.toString()}`)
      .then((r) => r.json())
      .then((json: ApiResponse) => {
        if (json.success) setData(json.data);
        else setData(null);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [taxYear, term, showUnified]);

  // FINLYNQ-193 mixed-currency rule: group-by is UNIFIED-VIEW-ONLY. The
  // unified view converts every closure into the single display currency, so
  // summing realized gain across a group is always one-currency-correct.
  // Native view rows are each in their own sleeve currency, so a group could
  // span multiple currencies — we never sum those. The selector is disabled
  // in native view; this effect also resets a stale mode if the user turns
  // the unified toggle back off while grouped.
  useEffect(() => {
    if (!showUnified && groupMode !== "off") setGroupMode("off");
  }, [showUnified, groupMode]);

  // The unified currency is always the user's display currency; the server
  // stamps it onto each row's `baseCurrency`, so prefer that and fall back to
  // the provider value before any row loads.
  const unifiedCurrency = data?.rows[0]?.baseCurrency ?? displayCurrency;

  // FINLYNQ-193 — apply hide-zero over the figure CURRENTLY DISPLAYED: the
  // unified `realizedGainInBase` in unified view, the native `realizedGain`
  // otherwise. So the row that shows `0` on screen is the one hidden.
  const visibleRows = useMemo<ApiRow[]>(() => {
    const rows = data?.rows ?? [];
    if (!hideZero) return rows;
    return rows.filter((r) => {
      const shown =
        showUnified && r.realizedGainInBase != null
          ? r.realizedGainInBase
          : r.realizedGain;
      return shown !== 0;
    });
  }, [data, hideZero, showUnified]);

  // Grouping only ever runs in the unified view (guarded above), so member
  // gains are all in `unifiedCurrency`.
  const grouped = groupMode !== "off";
  const groupRows = useMemo<GroupRow[]>(
    () => (grouped ? buildGroupRows(visibleRows, groupMode) : []),
    [grouped, visibleRows, groupMode],
  );

  // Summary badges + closed-lot count reflect the VISIBLE (filtered/grouped)
  // set — consistent with hide-zero and grouping.
  const visibleCount = grouped ? groupRows.length : visibleRows.length;
  const visibleByCurrency = useMemo(() => {
    const acc: Record<string, { realizedGain: number; qtyClosed: number }> = {};
    for (const r of visibleRows) {
      const cell = acc[r.currency] ?? { realizedGain: 0, qtyClosed: 0 };
      cell.realizedGain += r.realizedGain;
      cell.qtyClosed += r.qtyClosed;
      acc[r.currency] = cell;
    }
    return acc;
  }, [visibleRows]);
  const visibleTotalInBase = useMemo(
    () => visibleRows.reduce((s, r) => s + (r.realizedGainInBase ?? 0), 0),
    [visibleRows],
  );

  // FINLYNQ-193 — CSV now reflects the active hide-zero + group-by state, so
  // the download byte-matches what's on screen. Built CLIENT-SIDE from the
  // already-fetched rows via the shared `exportCsv` helper — the server route,
  // `realizedGainsToCsv`, and MCP/mobile flat shape are all untouched.
  const handleExportCsv = () => {
    const yearTag = taxYear ? `-${taxYear}` : "";
    if (grouped) {
      const columns: CsvColumn<GroupRow>[] = [];
      if (groupMode !== "account")
        columns.push({ header: "holding", accessor: (g) => g.holdingLabel });
      if (groupMode !== "holding")
        columns.push({ header: "account", accessor: (g) => g.accountLabel });
      columns.push(
        { header: "closures", accessor: (g) => g.closureCount },
        { header: "qty_closed", accessor: (g) => g.qtyClosed },
        { header: "earliest_close", accessor: (g) => g.earliestClose },
        { header: "latest_close", accessor: (g) => g.latestClose },
        { header: "realized_gain", accessor: (g) => g.realizedGain },
        { header: "currency", accessor: () => unifiedCurrency },
      );
      exportCsv(groupRows, columns, `realized-gains${yearTag}-grouped.csv`);
      return;
    }
    // Flat (filtered) export — mirrors the server CSV columns, but over the
    // hide-zero-filtered visible set, plus the unified column when active.
    const columns: CsvColumn<ApiRow>[] = [
      { header: "close_date", accessor: (r) => r.closeDate },
      { header: "open_date", accessor: (r) => r.openDate },
      { header: "days_held", accessor: (r) => r.daysHeld },
      { header: "term", accessor: (r) => r.term },
      { header: "holding", accessor: (r) => holdingLabelOf(r) },
      { header: "account", accessor: (r) => accountLabelOf(r) },
      { header: "qty_closed", accessor: (r) => r.qtyClosed },
      { header: "cost_per_share", accessor: (r) => r.costPerShare },
      { header: "proceeds_per_share", accessor: (r) => r.proceedsPerShare },
      { header: "realized_gain", accessor: (r) => r.realizedGain },
      { header: "currency", accessor: (r) => r.currency },
      { header: "close_kind", accessor: (r) => r.closeKind },
    ];
    if (showUnified) {
      columns.push(
        {
          header: `realized_gain_${unifiedCurrency.toLowerCase()}`,
          accessor: (r) => r.realizedGainInBase ?? "",
        },
        { header: "unified_currency", accessor: () => unifiedCurrency },
      );
    }
    exportCsv(visibleRows, columns, `realized-gains${yearTag}.csv`);
  };

  const yearChoices = [
    CURRENT_YEAR,
    CURRENT_YEAR - 1,
    CURRENT_YEAR - 2,
    CURRENT_YEAR - 3,
  ];

  return (
    <div className="container mx-auto space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Realized gains</h1>
          <p className="text-sm text-muted-foreground">
            Lot-level realized gain on every closed sell / transfer-out, per (holding, account).
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/portfolio" className="text-sm text-muted-foreground hover:underline self-center">
            ← Overview
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={loading || !data || visibleCount === 0}
          >
            <Download className="mr-2 h-4 w-4" /> CSV
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Tax year:</span>
        {yearChoices.map((y) => (
          <Button
            key={y}
            size="sm"
            variant={taxYear === y ? "default" : "outline"}
            onClick={() => setTaxYear(y)}
          >
            {y}
          </Button>
        ))}
        <Button
          size="sm"
          variant={taxYear === null ? "default" : "outline"}
          onClick={() => setTaxYear(null)}
        >
          All time
        </Button>
        <span className="ml-4 text-sm text-muted-foreground">Term:</span>
        {(["all", "short", "long"] as const).map((t) => (
          <Button
            key={t}
            size="sm"
            variant={term === t ? "default" : "outline"}
            onClick={() => setTerm(t)}
          >
            {t === "short" ? "Short (≤365d)" : t === "long" ? "Long (>365d)" : "All"}
          </Button>
        ))}
        <label className="ml-4 flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={showUnified}
            onChange={(e) => setShowUnified(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>Show in {unifiedCurrency}</span>
        </label>
        <label className="ml-4 flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={hideZero}
            onChange={(e) => setHideZero(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>Hide zero-gain rows</span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Group by:</span>
        {(["off", "holding", "account", "holding_account"] as const).map((m) => (
          <Button
            key={m}
            size="sm"
            variant={groupMode === m ? "default" : "outline"}
            // Mixed-currency rule: grouping sums realized gain across closures,
            // which is only single-currency-safe in the unified display view.
            // Disable every non-"off" mode in the native view.
            disabled={m !== "off" && !showUnified}
            onClick={() => setGroupMode(m)}
          >
            {GROUP_MODE_LABELS[m]}
          </Button>
        ))}
        {!showUnified && (
          <span className="text-xs text-muted-foreground">
            Enable “Show in {unifiedCurrency}” to group (avoids summing across native currencies).
          </span>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {loading
              ? "Loading…"
              : data
                ? grouped
                  ? `${visibleCount} ${groupMode === "account" ? "account" : groupMode === "holding" ? "holding" : "group"}${visibleCount === 1 ? "" : "s"} · ${visibleRows.length} closed lot${visibleRows.length === 1 ? "" : "s"}`
                  : `${visibleCount} closed lot${visibleCount === 1 ? "" : "s"}`
                : "—"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Summary badges reflect the VISIBLE (hide-zero-filtered) set. */}
          {!loading && data && Object.entries(visibleByCurrency).length > 0 && (
            <div className="mb-4 flex flex-wrap gap-3 text-sm">
              {showUnified && data.totalRealizedGainInBase != null ? (
                <Badge
                  variant={visibleTotalInBase >= 0 ? "default" : "destructive"}
                  className="px-3 py-1"
                >
                  {formatCurrency(visibleTotalInBase, unifiedCurrency)}{" "}
                  {unifiedCurrency}
                </Badge>
              ) : (
                Object.entries(visibleByCurrency).map(([ccy, t]) => (
                  <Badge
                    key={ccy}
                    variant={t.realizedGain >= 0 ? "default" : "destructive"}
                    className="px-3 py-1"
                  >
                    {formatCurrency(t.realizedGain, ccy)} {ccy}
                  </Badge>
                ))
              )}
            </div>
          )}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !data || data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No closed lots in this range yet. Lots are created on every new sell / in-kind
              transfer; pre-Phase-1 history is filled in by the lot backfill admin script.
            </p>
          ) : visibleCount === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rows match the current filters. Every closure in this range has a zero
              realized gain — turn off “Hide zero-gain rows” to see them.
            </p>
          ) : grouped ? (
            // FINLYNQ-193 — rolled-up grouped view. Per-share + date columns
            // collapse (not meaningful aggregated); we show qty + a closure
            // count + a date range + the summed realized gain (always in the
            // unified display currency, since grouping is unified-only).
            <Table>
              <TableHeader>
                <TableRow>
                  {groupMode !== "account" && <TableHead>Holding</TableHead>}
                  {groupMode !== "holding" && <TableHead>Account</TableHead>}
                  <TableHead className="text-right">Closures</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>Date range</TableHead>
                  <TableHead className="text-right">Realized ({unifiedCurrency})</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupRows.map((g) => (
                  <TableRow key={g.key}>
                    {groupMode !== "account" && (
                      <TableCell>{g.holdingLabel}</TableCell>
                    )}
                    {groupMode !== "holding" && (
                      <TableCell>{g.accountLabel}</TableCell>
                    )}
                    <TableCell className="text-right">{g.closureCount}</TableCell>
                    <TableCell className="text-right">{g.qtyClosed}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {g.earliestClose === g.latestClose
                        ? g.earliestClose
                        : `${g.earliestClose} → ${g.latestClose}`}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono ${
                        g.realizedGain >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {formatCurrency(g.realizedGain, unifiedCurrency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Closed</TableHead>
                  <TableHead>Opened</TableHead>
                  <TableHead>Days</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead>Holding</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Cost / sh</TableHead>
                  <TableHead className="text-right">Proceeds / sh</TableHead>
                  <TableHead className="text-right">Realized</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((r) => {
                  const kindMeta = CLOSE_KIND_META[r.closeKind] ?? null;
                  const KindIcon = kindMeta?.icon ?? null;
                  return (
                  <TableRow key={r.closureId}>
                    <TableCell className="font-mono text-xs">{r.closeDate}</TableCell>
                    <TableCell className="font-mono text-xs">{r.openDate}</TableCell>
                    <TableCell className="text-xs">{r.daysHeld}</TableCell>
                    <TableCell>
                      <Badge variant={r.term === "long" ? "secondary" : "outline"}>
                        {r.term}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {KindIcon && (
                          <KindIcon className={`h-3.5 w-3.5 ${kindMeta!.className.split(" ").filter(c => c.startsWith("text-")).join(" ")}`} />
                        )}
                        <span>{r.holdingName ?? `#${r.holdingId}`}</span>
                        {kindMeta && (
                          <Badge
                            variant="outline"
                            className={`text-[10px] h-4 px-1 ${kindMeta.className}`}
                            title={kindMeta.tooltip}
                          >
                            {kindMeta.label}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{r.accountName ?? `#${r.accountId}`}</TableCell>
                    <TableCell className="text-right">{r.qtyClosed}</TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCurrency(r.costPerShare, r.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCurrency(r.proceedsPerShare, r.currency)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono ${
                        (showUnified && r.realizedGainInBase != null
                          ? r.realizedGainInBase
                          : r.realizedGain) >= 0
                          ? "text-green-600"
                          : "text-red-600"
                      }`}
                    >
                      {showUnified && r.realizedGainInBase != null && r.baseCurrency
                        ? formatCurrency(r.realizedGainInBase, r.baseCurrency)
                        : formatCurrency(r.realizedGain, r.currency)}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
