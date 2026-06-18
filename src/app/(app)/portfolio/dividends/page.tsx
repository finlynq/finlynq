"use client";

/**
 * Dividend-income dashboard — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * Quarterly / annual / per-holding views. Reads
 * /api/portfolio/dividends with a `groupBy` param. Negative-amount
 * rows (withholding tax, corrections) surface as a separate badge
 * count per group rather than being netted.
 *
 * FINLYNQ-182 — Year/Quarter pivot one row per period with a money column per
 * currency (native pivot, `pivot=1`); a "Show in reporting currency" toggle
 * collapses to a single reporting-currency Total computed from STORED
 * `reporting_amount` (`reportingCurrency=1`, never a render-time FX
 * conversion); date filters (from/to + tax-year) wired across all three views.
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

interface CurrencyCell {
  amount: number;
  rowCount: number;
  reinvestedCount: number;
  withholdingCount: number;
}

interface GroupRow {
  bucket: string;
  label: string;
  amount: number;
  currency: string;
  rowCount: number;
  reinvestedCount: number;
  withholdingCount: number;
  byCurrency?: Record<string, CurrencyCell>;
  unratedCount?: number;
}

interface ApiResponse {
  success: boolean;
  data: {
    groups?: GroupRow[];
    totals: {
      amount: number;
      rowCount: number;
      byCurrency: Record<string, number>;
      unratedCount?: number;
    };
    mode?: "native" | "reporting";
    reportingCurrency?: string;
  };
}

type GroupBy = "quarter" | "year" | "holding";

const CURRENT_YEAR = new Date().getFullYear();
// Tax-year choices: this year back through ~10 years.
const TAX_YEARS = Array.from({ length: 11 }, (_, i) => CURRENT_YEAR - i);

export default function DividendsPage() {
  const [groupBy, setGroupBy] = useState<GroupBy>("year");
  const [reporting, setReporting] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [taxYear, setTaxYear] = useState<string>("");
  const [data, setData] = useState<ApiResponse["data"] | null>(null);
  const [loading, setLoading] = useState(true);

  // Build the shared param set (used by both the fetch and the CSV link) so
  // the export always reflects the active mode + filters.
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("groupBy", groupBy);
    if (reporting) params.set("reportingCurrency", "1");
    else params.set("pivot", "1"); // native = one row per period, currency columns
    if (taxYear) params.set("taxYear", taxYear);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params;
  }, [groupBy, reporting, taxYear, from, to]);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/portfolio/dividends?${queryParams.toString()}`)
      .then((r) => r.json())
      .then((json: ApiResponse) => {
        if (json.success) setData(json.data);
        else setData(null);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [queryParams]);

  const csvHref = useMemo(() => {
    const params = new URLSearchParams(queryParams);
    params.set("format", "csv");
    return `/api/portfolio/dividends?${params.toString()}`;
  }, [queryParams]);

  // Currencies present (native pivot) → one money column each.
  const currencyColumns = useMemo(() => {
    if (reporting || !data?.groups) return [];
    const set = new Set<string>();
    for (const g of data.groups) {
      for (const c of Object.keys(g.byCurrency ?? {})) set.add(c);
    }
    return [...set].sort();
  }, [data, reporting]);

  const reportingCcy = data?.reportingCurrency ?? "USD";
  const firstHeader = groupBy === "holding" ? "Holding" : "Period";
  const hasFilters = Boolean(from || to || taxYear);

  function clearFilters() {
    setFrom("");
    setTo("");
    setTaxYear("");
  }

  return (
    <div className="container mx-auto space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dividend income</h1>
          <p className="text-sm text-muted-foreground">
            Every transaction categorized as Dividends, including reinvestments and
            withholding-tax entries.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/portfolio" className="text-sm text-muted-foreground hover:underline self-center">
            ← Overview
          </Link>
          <a
            href={csvHref}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Download className="mr-2 h-4 w-4" /> CSV
          </a>
        </div>
      </div>

      {/* Controls: group-by + reporting toggle */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Group by:</span>
          {(["year", "quarter", "holding"] as const).map((g) => (
            <Button
              key={g}
              size="sm"
              variant={groupBy === g ? "default" : "outline"}
              onClick={() => setGroupBy(g)}
            >
              {g[0].toUpperCase() + g.slice(1)}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Show in:</span>
          <Button
            size="sm"
            variant={reporting ? "outline" : "default"}
            onClick={() => setReporting(false)}
          >
            Native currency
          </Button>
          <Button
            size="sm"
            variant={reporting ? "default" : "outline"}
            onClick={() => setReporting(true)}
          >
            Reporting currency
          </Button>
        </div>
      </div>

      {/* Date filters — apply across all three views */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Tax year</label>
          <select
            value={taxYear}
            onChange={(e) => {
              setTaxYear(e.target.value);
              // A tax-year selection supersedes any explicit range.
              if (e.target.value) {
                setFrom("");
                setTo("");
              }
            }}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            <option value="">All years</option>
            {TAX_YEARS.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">From</label>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              if (e.target.value) setTaxYear("");
            }}
            className="w-[9.5rem]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">To</label>
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              if (e.target.value) setTaxYear("");
            }}
            className="w-[9.5rem]"
          />
        </div>
        {hasFilters && (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {loading
              ? "Loading…"
              : data
                ? `${data.totals.rowCount} dividend row${data.totals.rowCount === 1 ? "" : "s"}`
                : "—"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Total badges — collapse to a single reporting-currency badge in reporting mode */}
          {!loading && data && Object.entries(data.totals.byCurrency).length > 0 && (
            <div className="mb-4 flex flex-wrap gap-3 text-sm">
              {reporting ? (
                <Badge
                  variant={data.totals.amount >= 0 ? "default" : "destructive"}
                  className="px-3 py-1"
                >
                  {formatCurrency(data.totals.amount, reportingCcy)} {reportingCcy}
                </Badge>
              ) : (
                Object.entries(data.totals.byCurrency).map(([ccy, total]) => (
                  <Badge
                    key={ccy}
                    variant={total >= 0 ? "default" : "destructive"}
                    className="px-3 py-1"
                  >
                    {formatCurrency(total, ccy)} {ccy}
                  </Badge>
                ))
              )}
            </div>
          )}

          {reporting && data && (data.totals.unratedCount ?? 0) > 0 && (
            <p className="mb-3 text-xs text-amber-600 dark:text-amber-500">
              Re-rating in progress: {data.totals.unratedCount} row
              {data.totals.unratedCount === 1 ? "" : "s"} not yet converted to{" "}
              {reportingCcy} and excluded from the totals. Reload shortly.
            </p>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !data || !data.groups || data.groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No dividend transactions yet. Tag dividend payouts with a category named
              &quot;Dividends&quot; for them to show up here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{firstHeader}</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="text-right">Reinvested</TableHead>
                    <TableHead className="text-right">Withholding</TableHead>
                    {reporting ? (
                      <TableHead className="text-right">Total ({reportingCcy})</TableHead>
                    ) : (
                      currencyColumns.map((c) => (
                        <TableHead key={c} className="text-right">
                          {c}
                        </TableHead>
                      ))
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.groups.map((g) => (
                    <TableRow key={g.bucket}>
                      <TableCell>{g.label}</TableCell>
                      <TableCell className="text-right">{g.rowCount}</TableCell>
                      <TableCell className="text-right">{g.reinvestedCount}</TableCell>
                      <TableCell className="text-right">{g.withholdingCount}</TableCell>
                      {reporting ? (
                        <TableCell
                          className={`text-right font-mono ${
                            g.amount >= 0 ? "text-green-600" : "text-red-600"
                          }`}
                        >
                          {formatCurrency(g.amount, reportingCcy)}
                        </TableCell>
                      ) : (
                        currencyColumns.map((c) => {
                          const cell = g.byCurrency?.[c];
                          return (
                            <TableCell
                              key={c}
                              className={`text-right font-mono ${
                                cell
                                  ? cell.amount >= 0
                                    ? "text-green-600"
                                    : "text-red-600"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {cell ? formatCurrency(cell.amount, c) : "—"}
                            </TableCell>
                          );
                        })
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
